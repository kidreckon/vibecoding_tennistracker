// app.js — UI glue: load the model, wire the controls, run analyze -> render.

import { analyze } from './tracker.js';
import { render, pickMime } from './renderer.js';

const $ = (id) => document.getElementById(id);
const file = $('file');
const src = $('src');
const out = $('out');
const go = $('go');
const bar = $('barfill');
const stage = $('stage');
const progress = $('progress');

let model = null;
let currentUrl = null;

// Register the service worker so the app installs/works offline after first run.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

if (!pickMime() && !window.MediaRecorder) {
  stage.textContent = 'This browser can’t record video. Try Chrome or Safari.';
}

/** Lazily load the detector (person + sports ball, pre-trained on COCO). */
async function getModel() {
  if (model) return model;
  setStage('Loading detector…', 0);
  // lite_mobilenet_v2 is the fast, mobile-friendly base.
  model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  return model;
}

function setStage(text, frac) {
  stage.textContent = text;
  if (frac != null) bar.style.width = Math.round(frac * 100) + '%';
}

file.addEventListener('change', () => {
  const f = file.files[0];
  if (!f) return;
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(f);
  src.src = currentUrl;
  src.onloadedmetadata = () => {
    $('workspace').classList.remove('hidden');
    $('result').classList.add('hidden');
    $('picker').classList.add('hidden');
  };
});

go.addEventListener('click', async () => {
  if (!src.videoWidth) return;
  go.disabled = true;
  progress.classList.remove('hidden');

  try {
    const m = await getModel();

    const H = src.videoHeight;
    const cropWidth = Math.min(src.videoWidth, Math.round(H * 9 / 16));
    const opts = {
      ballBias: Number($('ballBias').value),
      smoothness: Number($('smooth').value),
      cropWidth,
    };

    setStage('Tracking the action…', 0);
    const path = await analyze(m, src, opts, (p) => setStage('Tracking the action…', p * 0.6));

    setStage('Rendering vertical clip…', 0.6);
    const { blob } = await render(src, out, path, cropWidth,
      (p) => setStage('Rendering vertical clip…', 0.6 + p * 0.4));

    const url = URL.createObjectURL(blob);
    $('resultVideo').src = url;
    const dl = $('download');
    dl.href = url;
    dl.download = 'rally-vertical' + (blob.type.includes('mp4') ? '.mp4' : '.webm');
    $('result').classList.remove('hidden');
    $('workspace').classList.add('hidden');
  } catch (err) {
    console.error(err);
    setStage('Something went wrong: ' + err.message, 0);
  } finally {
    go.disabled = false;
  }
});

$('again').addEventListener('click', () => {
  file.value = '';
  $('picker').classList.remove('hidden');
  $('result').classList.add('hidden');
  progress.classList.add('hidden');
});
