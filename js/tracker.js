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
 * Turn one frame's detections into a framing {cx, cy, h, ball, present}.
 *
 * `follow` decides who the camera locks onto — crucial when the scene has more
 * than the one player (an opponent across the net, bystanders on the side):
 *   'me'   -> the nearest/largest person only (you), ignoring distant people
 *   'both' -> the two largest people (you + opponent), ignoring bystanders
 *   'ball' -> center on the ball, keeping the nearest player in view
 * The crop height h is sized to contain the chosen subject(s).
 */
function measure(preds, W, H, hMin, zoom, follow) {
  const persons = [], balls = [];
  for (const p of preds) {
    const [x, y, w, h] = p.bbox;
    if (p.class === 'person' && p.score > 0.4)
      persons.push({ minX: x, minY: y, maxX: x + w, maxY: y + h, area: w * h });
    else if (p.class === 'sports ball' && p.score > 0.3)
      balls.push({ cx: x + w / 2, cy: y + h / 2, minX: x, minY: y, maxX: x + w, maxY: y + h });
  }
  if (!persons.length && !balls.length)
    return { cx: null, cy: null, h: null, ball: false, present: false };

  // Nearest players = the largest by on-screen area (closest to the camera).
  persons.sort((a, b) => b.area - a.area);
  const chosen = follow === 'both' ? persons.slice(0, 2) : persons.slice(0, 1);

  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (o) => {
    box.minX = Math.min(box.minX, o.minX); box.minY = Math.min(box.minY, o.minY);
    box.maxX = Math.max(box.maxX, o.maxX); box.maxY = Math.max(box.maxY, o.maxY);
  };
  (chosen.length ? chosen : [balls[0]]).forEach(add);

  const ball = balls.length > 0;
  let cx, cy;
  if (follow === 'ball' && ball) {            // center on the ball; keep player in the box
    let sx = 0, sy = 0;
    for (const b of balls) { sx += b.cx; sy += b.cy; add(b); }
    cx = sx / balls.length; cy = sy / balls.length;
  } else {                                    // center on the chosen player(s)
    cx = (box.minX + box.maxX) / 2;
    cy = (box.minY + box.maxY) / 2;
  }

  let h;
  if (!zoom) {                                // pan-only: keep full height
    h = H; cy = H / 2;
  } else {                                     // size the crop to contain the box
    const halfW = Math.max(box.maxX - cx, cx - box.minX);
    const halfH = Math.max(box.maxY - cy, cy - box.minY);
    h = Math.max(halfH * 2, (halfW * 2) / AR) * PAD;
    h = Math.min(Math.max(h, hMin), H);
  }
  return { cx, cy, h, ball, present: true };
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
  const { follow = 'me', smoothness, zoom, autotrim, sampleFps = 4 } = opts;
  const W = video.videoWidth, H = video.videoHeight, duration = video.duration;
  const step = 1 / sampleFps;
  const hMin = Math.round(H * ZOOM_MIN_FRAC);

  // Detect on a downscaled copy of each frame — inference on a ~480px image is
  // far faster on a phone than on full 1080p/4K, and we scale boxes back up.
  const DET_W = 480;
  const s = Math.min(1, DET_W / W);
  const dW = Math.max(1, Math.round(W * s)), dH = Math.max(1, Math.round(H * s));
  const dcanvas = document.createElement('canvas');
  dcanvas.width = dW; dcanvas.height = dH;
  const dctx = dcanvas.getContext('2d');
  const inv = 1 / s;

  const raw = [];
  for (let t = 0; t < duration; t += step) {
    await seek(video, t);
    dctx.drawImage(video, 0, 0, dW, dH);
    const preds = await model.detect(dcanvas);
    for (const p of preds) p.bbox = [p.bbox[0] * inv, p.bbox[1] * inv, p.bbox[2] * inv, p.bbox[3] * inv];
    raw.push({ t, ...measure(preds, W, H, hMin, zoom, follow) });
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
