// renderer.js — render pass: play the source at normal speed, draw the moving
// vertical crop onto a canvas, and capture that canvas (plus source audio) with
// MediaRecorder into a downloadable clip. No server, no upload.

import { seek, centerAt } from './tracker.js';

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

/**
 * @returns {Promise<{blob: Blob, mime: string}>}
 */
export async function render(video, canvas, path, cropWidth, onProgress) {
  const W = video.videoWidth;
  const H = video.videoHeight;

  // Output is the vertical slice at native resolution (capped to 1080 tall).
  const scale = Math.min(1, 1080 / H);
  canvas.width = Math.round(cropWidth * scale);
  canvas.height = Math.round(H * scale);
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

  await seek(video, 0);
  recorder.start();
  await video.play();

  await new Promise((resolve) => {
    const draw = () => {
      const cx = centerAt(path, video.currentTime);
      const sx = Math.min(Math.max(cx - cropWidth / 2, 0), W - cropWidth);
      ctx.drawImage(video, sx, 0, cropWidth, H, 0, 0, canvas.width, canvas.height);
      onProgress(Math.min(1, video.currentTime / video.duration));
      if (video.ended || video.paused) return resolve();
      onFrame(video, draw);
    };
    video.onended = resolve;
    onFrame(video, draw);
  });

  recorder.stop();
  await stopped;
  return { blob: new Blob(chunks, { type: mime || 'video/webm' }), mime };
}
