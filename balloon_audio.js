// balloon_audio.js: owns the AudioContext and the Faust voices.
//
// Narrow API on window.balloonAudio (Dart reaches it via lib/audio/js_bridge.dart):
//   init()                    -> Promise<boolean>  create/resume audio; call from a gesture
//   setParam(voice, name, v)  set "inflate" | "bend" | "wobble" | "pop" | "gate"
//   gate(voice, on)           shorthand for setParam(voice, "gate", 0|1)
//   isRunning()               -> boolean  context running and voices loaded
//   debugLevel()              -> number   output RMS, for checking that sound plays
//
// The DSP is compiled ahead of time (npm run build:dsp). Here we only fetch
// the precompiled wasm + metadata and the small faustwasm runtime, never the
// Faust compiler. Nothing touches audio until the first user gesture.

const VOICES = ['l', 'u', 'k', 'e'];
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const asset = (p) => new URL(p, document.baseURI).href;

let ctx = null;
let master = null;
let analyser = null;
let prefetched = null; // Promise<{FaustMonoDspGenerator, dsps}>
let loading = null; // Promise<boolean>
const nodes = new Map(); // voice index -> Faust node
const paramPaths = new Map(); // voice index -> Map(shortName -> address)
const latest = VOICES.map(() => new Map()); // last value per param, replayed on load

// ---------------------------------------------------------------- loading

async function compileWasm(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (WebAssembly.compileStreaming) {
    try {
      return await WebAssembly.compileStreaming(Promise.resolve(res.clone()));
    } catch (_) {
      // Wrong MIME type from some static hosts; fall back to bytes.
    }
  }
  return WebAssembly.compile(await res.arrayBuffer());
}

async function fetchVoice(v) {
  const [meta, module] = await Promise.all([
    fetch(asset(`dsp/${v}/dsp-meta.json`)).then((r) => {
      if (!r.ok) throw new Error(`dsp/${v}/dsp-meta.json: HTTP ${r.status}`);
      return r.json();
    }),
    compileWasm(asset(`dsp/${v}/dsp-module.wasm`)),
  ]);
  return { voice: v, meta, module };
}

// Fetch and compile everything that does not need an AudioContext.
// Voices whose files are missing are skipped, so the site still runs while
// letters are being added.
function prefetch() {
  if (!prefetched) {
    prefetched = (async () => {
      const { FaustMonoDspGenerator } = await import(asset('faustwasm/index.js'));
      const results = await Promise.allSettled(VOICES.map(fetchVoice));
      const dsps = new Map();
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') dsps.set(i, r.value);
        else console.warn(`[balloonAudio] voice ${VOICES[i]} unavailable:`, r.reason?.message ?? r.reason);
      });
      return { FaustMonoDspGenerator, dsps };
    })();
    prefetched.catch((err) => console.error('[balloonAudio] prefetch failed', err));
  }
  return prefetched;
}

function collectPaths(items, out) {
  for (const item of items) {
    if (item.items) collectPaths(item.items, out);
    else if (item.address) out.set(item.address.split('/').pop(), item.address);
  }
  return out;
}

async function createVoiceNode(Generator, voiceIndex, dsp) {
  const factory = { module: dsp.module, json: JSON.stringify(dsp.meta), soundfiles: {} };
  const name = `balloon_${dsp.voice}`;
  let node = null;
  try {
    node = await new Generator().createNode(ctx, name, factory);
  } catch (err) {
    console.warn(`[balloonAudio] AudioWorklet failed for ${name}, using ScriptProcessor`, err);
    node = await new Generator().createNode(ctx, name, factory, true, 512);
  }
  if (!node) throw new Error(`could not create node for ${name}`);
  node.connect(master);
  if (typeof node.start === 'function') node.start();
  const paths = collectPaths(dsp.meta.ui, new Map());
  paramPaths.set(voiceIndex, paths);
  nodes.set(voiceIndex, node);
  for (const [k, value] of latest[voiceIndex]) {
    const path = paths.get(k);
    if (path) node.setParamValue(path, value);
  }
}

async function loadVoices() {
  const { FaustMonoDspGenerator, dsps } = await prefetch();
  await Promise.all(
    [...dsps].map(([i, dsp]) =>
      createVoiceNode(FaustMonoDspGenerator, i, dsp).catch((err) =>
        console.error(`[balloonAudio] voice ${dsp.voice} failed`, err),
      ),
    ),
  );
  console.info(`[balloonAudio] ready: ${[...nodes.keys()].map((i) => VOICES[i]).join(', ')} @ ${ctx.sampleRate} Hz`);
  return nodes.size > 0;
}

// ---------------------------------------------------------------- unlock

// Must run synchronously inside a user-gesture handler (Safari).
function unlock() {
  if (!AudioContextClass) return false;
  if (!ctx || ctx.state === 'closed') {
    ctx = new AudioContextClass({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = 0.7;
    // Safety limiter only (all four letters popping at once would clip);
    // every sound itself comes from the Faust voices.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    limiter.connect(analyser);
  }
  // iOS: play through the ringer/silent switch, like a media app.
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch (_) {}
  if (ctx.state !== 'running') {
    ctx.resume().catch(() => {});
    // A one-sample silent buffer completes the unlock on older iOS.
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    src.connect(ctx.destination);
    src.start(0);
  }
  return true;
}

// On iOS and Android, touchstart/pointerdown(touch) do not count as user
// activation; pointerup/touchend do. Listening natively on the document
// (capture phase) catches whichever event qualifies, whatever Flutter does.
const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'mousedown', 'keydown'];
function onGesture() {
  init();
  if (ctx && ctx.state === 'running' && nodes.size) {
    GESTURES.forEach((t) => document.removeEventListener(t, onGesture, true));
  }
}
GESTURES.forEach((t) => document.addEventListener(t, onGesture, { capture: true, passive: true }));

// ---------------------------------------------------------------- API

function init() {
  if (!unlock()) return Promise.resolve(false);
  if (!loading) {
    loading = loadVoices().catch((err) => {
      console.error('[balloonAudio] init failed', err);
      loading = null;
      return false;
    });
  }
  return loading;
}

function setParam(voice, name, value) {
  const store = latest[voice];
  if (!store) return;
  store.set(name, value);
  const node = nodes.get(voice);
  const path = paramPaths.get(voice)?.get(name);
  if (node && path) node.setParamValue(path, value);
}

function gate(voice, on) {
  setParam(voice, 'gate', on ? 1 : 0);
}

function isRunning() {
  return !!ctx && ctx.state === 'running' && nodes.size > 0;
}

const levelBuf = new Float32Array(1024);
function debugLevel() {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(levelBuf);
  let s = 0;
  for (const v of levelBuf) s += v * v;
  return Math.sqrt(s / levelBuf.length);
}

window.balloonAudio = { init, setParam, gate, isRunning, debugLevel };

// Add ?debug to the URL to see the audio state on the page (handy on phones,
// where the console is out of reach).
if (new URLSearchParams(location.search).has('debug')) {
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;top:env(safe-area-inset-top,0);left:0;z-index:9;padding:4px 8px;' +
    'font:12px/1.4 ui-monospace,monospace;background:#0008;color:#fff;pointer-events:none';
  document.body.appendChild(box);
  let peak = -Infinity;
  setInterval(() => {
    const lvl = debugLevel();
    const db = lvl > 0 ? 20 * Math.log10(lvl) : -Infinity;
    peak = Math.max(peak, db);
    box.textContent =
      `audio ${ctx ? ctx.state : 'none'} | voices ${nodes.size} | ` +
      `${ctx ? ctx.sampleRate : '-'} Hz | level ${db.toFixed(0)} dB | peak ${peak.toFixed(0)} dB`;
  }, 150);
}

// Warm the cache once the page is idle, so the first press sounds quickly.
// This only downloads and compiles; the AudioContext waits for a gesture.
window.addEventListener('load', () => {
  const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1200));
  idle(() => prefetch(), { timeout: 3000 });
});
