// renderer.js — render pass: play the source, draw the moving/zooming 9:16 crop
// onto a canvas, and capture it (plus source audio) with MediaRecorder. Dead
// segments are skipped by seeking across them within one continuous recording
// (lightweight auto-trim — expect a brief freeze at each cut).

import { seek, sampleAt } from './tracker.js';

/** Pick the best container/codec this browser can actually record. */
export function pickMime() {
  const candidates = [
    'video/mp4;codecs=h264,aac',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

/** Request a per-frame callback, falling back to rAF on older browsers. */
function onFrame(video, cb) {
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => cb());
  else requestAnimationFrame(() => cb());
}

const AR = 9 / 16;

/**
 * @param segments {start,end}[] active spans to keep (in order)
 * @returns {Promise<{blob: Blob, mime: string}>}
 */
export async function render(video, canvas, path, segments, onProgress) {
  const W = video.videoWidth, H = video.videoHeight;

  // Fixed 9:16 output canvas (capped to 1080 tall); zoom is done in the source
  // rectangle, so the output size stays constant.
  const outH = Math.min(1080, Math.round(H));
  canvas.height = outH;
  canvas.width = Math.round(outH * AR);
  const ctx = canvas.getContext('2d');

  // Compose: canvas video track + original audio (when the browser exposes it).
  const stream = canvas.captureStream(30);
  let tracks = stream.getVideoTracks();
  if (video.captureStream) {
    try {
      const audio = video.captureStream().getAudioTracks();
      if (audio.length) tracks = tracks.concat(audio);
    } catch { /* audio is a nice-to-have; ignore if blocked */ }
  }
  const out = new MediaStream(tracks);

  const mime = pickMime();
  const recorder = new MediaRecorder(out, mime
    ? { mimeType: mime, videoBitsPerSecond: 8_000_000 }
    : { videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (recorder.onstop = r));

  const drawFrame = () => {
    const f = sampleAt(path, video.currentTime);
    const cw = f.h * AR;
    const sx = Math.min(Math.max(f.cx - cw / 2, 0), W - cw);
    const sy = Math.min(Math.max(f.cy - f.h / 2, 0), H - f.h);
    ctx.drawImage(video, sx, sy, cw, f.h, 0, 0, canvas.width, canvas.height);
  };

  const total = segments.reduce((s, seg) => s + (seg.end - seg.start), 0) || video.duration;
  let done = 0;

  recorder.start();
  for (const seg of segments) {
    await seek(video, seg.start);
    await video.play();
    await new Promise((resolve) => {
      const draw = () => {
        if (video.currentTime >= seg.end || video.ended) return resolve();
        drawFrame();
        onProgress(Math.min(1, (done + (video.currentTime - seg.start)) / total));
        onFrame(video, draw);
      };
      video.onended = resolve;
      onFrame(video, draw);
    });
    video.pause();
    done += seg.end - seg.start;
  }

  recorder.stop();
  await stopped;
  return { blob: new Blob(chunks, { type: mime || 'video/webm' }), mime };
}
