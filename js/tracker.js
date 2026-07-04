// tracker.js — analysis pass: detect players/ball per frame, then build
//   1) a smooth virtual-camera PATH (center + zoom), and
//   2) a list of active SEGMENTS (auto-trim of dead time).
//
// The crop is always 9:16. "Pan" moves its center (cx, cy); "zoom" changes its
// height h (cropW is always h*9/16). Zoomed out => h == full height.

const PAD = 1.3;          // breathing room around the detected action box
const ZOOM_MIN_FRAC = 0.5; // most we'll zoom in: crop height >= 50% of full height
const AR = 9 / 16;        // output aspect (width / height)

/** Seek the video to time t and resolve once the frame is actually ready. */
export function seek(video, t) {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = Math.min(Math.max(t, 0), Math.max(0, video.duration - 0.001));
  });
}

/**
 * Turn one frame's detections into a framing {cx, cy, h, ball, present}:
 * a bounding box around all players + ball, its center (optionally nudged
 * toward the ball by ballBias), and the 9:16 crop height needed to contain it.
 */
function measure(preds, W, H, ballBias, hMin, zoom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let bx = 0, by = 0, bn = 0, present = false;
  for (const p of preds) {
    const [x, y, w, h] = p.bbox;
    if (p.class === 'person' && p.score > 0.4) {
      present = true;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
    } else if (p.class === 'sports ball' && p.score > 0.3) {
      present = true;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
      bx += x + w / 2; by += y + h / 2; bn++;
    }
  }
  if (!present) return { cx: null, cy: null, h: null, ball: false, present: false };

  let cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const ball = bn > 0;
  if (ball && ballBias > 0) {                 // lean framing toward the ball
    const k = Math.min(0.6, (ballBias / 10) * 0.6);
    cx += (bx / bn - cx) * k;
    cy += (by / bn - cy) * k;
  }

  let h;
  if (!zoom) {                                // pan-only: keep full height
    h = H; cy = H / 2;
  } else {                                     // size the crop to contain the box
    const halfW = Math.max(maxX - cx, cx - minX);
    const halfH = Math.max(maxY - cy, cy - minY);
    h = Math.max(halfH * 2, (halfW * 2) / AR) * PAD;
    h = Math.min(Math.max(h, hMin), H);
  }
  return { cx, cy, h, ball, present };
}

/** Forward/backward fill null samples so smoothing has a continuous signal. */
function fillRecords(raw, W, H) {
  const defs = { cx: W / 2, cy: H / 2, h: H };
  for (const key of ['cx', 'cy', 'h']) {
    let last = null;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i][key] != null) last = raw[i][key];
      else if (last != null) raw[i][key] = last;
    }
    let next = defs[key];
    for (let i = raw.length - 1; i >= 0; i--) {
      if (raw[i][key] == null) raw[i][key] = next; else next = raw[i][key];
    }
  }
}

/** One exponential-smoothing step with a max-speed cap. */
function stepToward(cur, target, alpha, cap) {
  let next = cur + alpha * (target - cur);
  const dv = next - cur;
  if (Math.abs(dv) > cap) next = cur + Math.sign(dv) * cap;
  return next;
}

/** Detect dead time and return the active [{start,end}] segments to keep. */
function buildSegments(raw, duration, H, step, autotrim) {
  if (!autotrim || raw.length < 4) return [{ start: 0, end: duration }];

  // Activity = how much the action moved between samples, + a nudge if a ball
  // is visible. Standing/waiting reads as near-zero; a rally reads as high.
  const act = new Array(raw.length).fill(0);
  for (let i = 1; i < raw.length; i++) {
    const m = Math.hypot(raw[i].cx - raw[i - 1].cx, raw[i].cy - raw[i - 1].cy) / H;
    act[i] = m + (raw[i].ball ? 0.02 : 0);
  }
  const win = Math.max(1, Math.round(0.4 / step)); // ~0.4s smoothing window
  const THRESH = 0.006, MARGIN = 0.5;              // keep ±0.5s around each active moment
  const segments = [];
  for (let i = 0; i < act.length; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(act.length - 1, i + win); j++) { s += act[j]; n++; }
    if (s / n <= THRESH) continue;                 // dead moment
    const start = Math.max(0, raw[i].t - MARGIN);
    const end = Math.min(duration, raw[i].t + MARGIN);
    const prev = segments[segments.length - 1];
    if (prev && start <= prev.end) prev.end = Math.max(prev.end, end); // merge / bridge gaps
    else segments.push({ start, end });
  }
  return segments.length ? segments : [{ start: 0, end: duration }];
}

/**
 * @returns {Promise<{ path: {t,cx,cy,h}[], segments: {start,end}[] }>}
 */
export async function analyze(model, video, opts, onProgress) {
  const { ballBias, smoothness, zoom, autotrim, sampleFps = 8 } = opts;
  const W = video.videoWidth, H = video.videoHeight, duration = video.duration;
  const step = 1 / sampleFps;
  const hMin = Math.round(H * ZOOM_MIN_FRAC);

  const raw = [];
  for (let t = 0; t < duration; t += step) {
    await seek(video, t);
    const preds = await model.detect(video);
    raw.push({ t, ...measure(preds, W, H, ballBias, hMin, zoom) });
    onProgress(Math.min(1, t / duration));
  }
  fillRecords(raw, W, H);

  const segments = buildSegments(raw, duration, H, step, autotrim);

  // Smooth center + zoom into a gliding camera path.
  const alpha = 1 / (smoothness + 1);
  const capX = W * 0.9 * step, capY = H * 0.9 * step, capH = H * 0.35 * step;
  let cx = raw[0].cx, cy = raw[0].cy, h = raw[0].h;
  const path = [];
  for (const r of raw) {
    cx = stepToward(cx, r.cx, alpha, capX);
    cy = stepToward(cy, r.cy, alpha, capY);
    h = stepToward(h, r.h, alpha, capH);
    const cw = h * AR;
    path.push({
      t: r.t,
      cx: Math.min(Math.max(cx, cw / 2), W - cw / 2),
      cy: Math.min(Math.max(cy, h / 2), H - h / 2),
      h,
    });
  }
  return { path, segments };
}

/** Linear-interpolate the full framing {cx, cy, h} for any playback time. */
export function sampleAt(path, t) {
  const n = path.length;
  if (t <= path[0].t) return path[0];
  if (t >= path[n - 1].t) return path[n - 1];
  for (let i = 1; i < n; i++) {
    if (path[i].t >= t) {
      const a = path[i - 1], b = path[i];
      const f = (t - a.t) / (b.t - a.t || 1);
      return {
        cx: a.cx + (b.cx - a.cx) * f,
        cy: a.cy + (b.cy - a.cy) * f,
        h: a.h + (b.h - a.h) * f,
      };
    }
  }
  return path[n - 1];
}
