// tracker.js — analysis pass: detect players/ball per frame and build a smooth
// horizontal camera path. For 16:9 -> 9:16 we keep full height and only pan on X,
// so the whole job reduces to "where should the center of the vertical crop be
// at each moment in time".

/** Seek the video to time t and resolve once the frame is actually ready. */
export function seek(video, t) {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = Math.min(Math.max(t, 0), Math.max(0, video.duration - 0.001));
  });
}

/**
 * Turn a set of detections into a single target X (pixels, source coords).
 * Players are weighted by box area (the nearer / larger player wins), and the
 * ball is weighted up by `ballBias` so the camera leans toward live action.
 * Returns null when nothing was found so we can fill the gap later.
 */
function targetX(preds, ballBias) {
  let sum = 0, wsum = 0;
  for (const p of preds) {
    if (p.score < 0.4) continue;
    const cx = p.bbox[0] + p.bbox[2] / 2;
    const area = p.bbox[2] * p.bbox[3];
    if (p.class === 'person') {
      sum += cx * area; wsum += area;
    } else if (p.class === 'sports ball' && p.score > 0.3) {
      const w = area * (1 + ballBias); // ballBias 0..~ : how hard to chase the ball
      sum += cx * w; wsum += w;
    }
  }
  return wsum > 0 ? sum / wsum : null;
}

/** Replace null samples with the nearest known value (edges included). */
function fillGaps(xs, fallback) {
  let last = null;
  for (let i = 0; i < xs.length; i++) if (xs[i] != null) { last = xs[i]; break; }
  if (last == null) return xs.map(() => fallback);
  last = null;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] == null) xs[i] = last;
    else last = xs[i];
  }
  // backfill leading nulls
  let next = fallback;
  for (let i = xs.length - 1; i >= 0; i--) {
    if (xs[i] == null) xs[i] = next; else next = xs[i];
  }
  return xs;
}

/**
 * Run the detector across the clip and return a smoothed path:
 * an array of { t, cx } samples, cx already clamped so the crop stays in bounds.
 */
export async function analyze(model, video, opts, onProgress) {
  const { ballBias, smoothness, cropWidth, sampleFps = 8 } = opts;
  const W = video.videoWidth;
  const duration = video.duration;
  const step = 1 / sampleFps;

  const times = [];
  const rawX = [];
  for (let t = 0; t < duration; t += step) {
    await seek(video, t);
    const preds = await model.detect(video);
    times.push(t);
    rawX.push(targetX(preds, ballBias));
    onProgress(Math.min(1, t / duration));
  }

  fillGaps(rawX, W / 2);

  // Exponential smoothing + a max pan speed so the camera glides instead of
  // snapping. Larger `smoothness` -> slower, calmer camera.
  const alpha = 1 / (smoothness + 1);
  const maxSpeed = (W * 0.9) * step; // px/sample cap, keeps fast whips in check
  const half = cropWidth / 2;
  const path = [];
  let cur = rawX[0];
  for (let i = 0; i < rawX.length; i++) {
    let next = cur + alpha * (rawX[i] - cur);
    const dv = next - cur;
    if (Math.abs(dv) > maxSpeed) next = cur + Math.sign(dv) * maxSpeed;
    cur = next;
    const cx = Math.min(Math.max(cur, half), W - half);
    path.push({ t: times[i], cx });
  }
  return path;
}

/** Linear-interpolate the crop center for any playback time. */
export function centerAt(path, t) {
  if (t <= path[0].t) return path[0].cx;
  const n = path.length;
  if (t >= path[n - 1].t) return path[n - 1].cx;
  // small linear scan is fine for a few hundred samples
  for (let i = 1; i < n; i++) {
    if (path[i].t >= t) {
      const a = path[i - 1], b = path[i];
      const f = (t - a.t) / (b.t - a.t || 1);
      return a.cx + (b.cx - a.cx) * f;
    }
  }
  return path[n - 1].cx;
}
