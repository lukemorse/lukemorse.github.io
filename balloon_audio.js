// balloon_audio.js: owns the AudioContext and the Faust voices.
//
// Narrow API on window.balloonAudio (Dart reaches it via lib/audio/js_bridge.dart):
//   init()                    -> Promise<boolean>  create/resume audio; call from a gesture
//   setParam(voice, name, v)  set "inflate" | "bend" | "wobble" | "pop" | "gate"
//                             voice 0..3 = L U K E classic, 4..7 = L U K E wild,
//                             8 = swap balloon ("wild" 0/1, "boing" counter; dsp/swap.dsp)
//   gate(voice, on)           shorthand for setParam(voice, "gate", 0|1)
//   isRunning()               -> boolean  context running and voices loaded
//   debugLevel()              -> number   output RMS, for checking that sound plays
//   startRecording()          -> boolean  record the mix (sound only); call from a gesture
//   stopRecording()           -> Promise<File|null>  the clip so far
//   isRecording()             -> boolean
//   canRecord()               -> boolean  MediaRecorder available
//
// Each pop also buzzes the phone (navigator.vibrate, Android only).
//
// The DSP is compiled ahead of time (npm run build:dsp). Here we only fetch
// the precompiled wasm + metadata and the small faustwasm runtime, never the
// Faust compiler. Voices are built into a suspended context at load; the
// first user gesture only resumes it.

// Both sets are loaded; the balloon button in the footer (Dart side) picks
// which one the letters play. The wild set is dsp/*_wild.dsp.
const LETTERS = ['l', 'u', 'k', 'e'];
const VOICES = [...LETTERS, ...LETTERS.map((v) => `${v}_wild`), 'swap'];
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const asset = (p) => new URL(p, document.baseURI).href;

let ctx = null;
let master = null;
let analyser = null;
let limiter = null;
let recDest = null; // MediaStreamAudioDestinationNode, connected only while recording
let prefetched = null; // Promise<{FaustMonoDspGenerator, dsps}>
let loading = null; // Promise<boolean>

// ---------------------------------------------------------------- reporting
// Sentry is loaded by web/index.html (absent on localhost or before it loads).
// Real failures go up as exceptions; a context iOS will not restart is not an
// exception, so it goes up as one message per stuck episode (see onGesture).
function reportError(err, what) {
  console.error(`[balloonAudio] ${what}`, err);
  const e = err instanceof Error ? err : new Error(String(err));
  window.Sentry?.captureException(e, { tags: { source: 'audio', what } });
}
function reportIssue(message, level, extra) {
  console.warn(`[balloonAudio] ${message}`, extra);
  window.Sentry?.captureMessage(`[balloonAudio] ${message}`, {
    level,
    tags: { source: 'audio', state: extra.state, fromBackground: String(extra.fromBackground) },
    extra,
  });
}
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
    prefetched.catch((err) => reportError(err, 'prefetch failed'));
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
  // One at a time: WebKit (Safari, every iOS browser) deadlocks the page
  // when several audioWorklet.addModule calls are in flight at once.
  // Serially all eight take ~100 ms. Classic set first.
  for (const [i, dsp] of dsps) {
    try {
      await createVoiceNode(FaustMonoDspGenerator, i, dsp);
    } catch (err) {
      reportError(err, `voice ${dsp.voice} failed`);
    }
  }
  console.info(`[balloonAudio] ready: ${[...nodes.keys()].map((i) => VOICES[i]).join(', ')} @ ${ctx.sampleRate} Hz`);
  return nodes.size > 0;
}

// ---------------------------------------------------------------- unlock

// iOS: play through the ringer/silent switch, like a media app. Set before
// the context exists too, so WebKit never picks a play-and-record session
// (which lights the microphone indicator).
function setPlaybackSession() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch (_) {}
}

// Builds the graph. Fine without a gesture: the context just starts
// suspended, and voices can be loaded into it ahead of the first tap.
function ensureContext() {
  if (!AudioContextClass) return false;
  if (!ctx || ctx.state === 'closed') {
    setPlaybackSession();
    loading = null; // nodes belong to the old context
    nodes.clear();
    paramPaths.clear();
    ctx = new AudioContextClass({ latencyHint: 'interactive' });
    ctx.addEventListener('statechange', onStateChange);
    master = ctx.createGain();
    master.gain.value = 0.7;
    // Safety limiter only (all four letters popping at once would clip);
    // every sound itself comes from the Faust voices.
    limiter = ctx.createDynamicsCompressor();
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
    recDest = null; // belonged to the old context
  }
  return true;
}

function startLoading() {
  if (!loading) {
    loading = loadVoices().catch((err) => {
      reportError(err, 'init failed');
      loading = null;
      return false;
    });
  }
  return loading;
}

// Must run synchronously inside a user-gesture handler (Safari).
function unlock() {
  if (!ensureContext()) return false;
  setPlaybackSession();
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
// The listeners stay on for good: after a trip to the background (or another
// app taking the audio session, e.g. switching Chrome -> Safari -> Chrome on
// iOS) the context comes back suspended/interrupted and only a real gesture
// can resume it. Flutter's pointerdown alone does not qualify on iOS.
const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'mousedown', 'keydown'];
function onGesture() {
  if (ctx && ctx.state === 'running' && nodes.size) return; // cheap path
  init();
  scheduleReviveCheck();
}
GESTURES.forEach((t) => document.addEventListener(t, onGesture, { capture: true, passive: true }));

// iOS WebKit sometimes never lets a context out of 'interrupted' once another
// app has had the audio session. If a gesture's resume() has not taken after
// a moment, throw the context away and build a fresh one (voices reload from
// the compiled cache in ~100 ms); the next tap starts it.
//
// Each run of taps that cannot get audio going is one "episode": reported to
// Sentry once when it starts, and once more when it ends (recovered by a
// rebuild) or gives up after MAX_REBUILDS.
const MAX_REBUILDS = 3;
let reviveTimer = 0;
let episode = null; // { start, rebuilds, state, fromBackground, gaveUp }
let lastShownAt = 0; // when the page last came back from the background

function episodeInfo(state) {
  return {
    state,
    fromBackground: !!lastShownAt && performance.now() - lastShownAt < 60000,
    rebuilds: episode?.rebuilds ?? 0,
    ms: episode ? Math.round(performance.now() - episode.start) : 0,
    voices: nodes.size,
  };
}

function onStateChange() {
  if (ctx?.state !== 'running' || !episode) return;
  if (episode.rebuilds > 0) {
    reportIssue('audio recovered after rebuild', 'info', episodeInfo('running'));
  }
  episode = null;
}

function scheduleReviveCheck() {
  if (reviveTimer || !ctx || ctx.state === 'running' || document.hidden) return;
  if (episode?.gaveUp) return;
  const stuck = ctx;
  reviveTimer = setTimeout(async () => {
    reviveTimer = 0;
    if (ctx !== stuck || stuck.state === 'running' || document.hidden) return;
    if (!loading || !(await loading)) return; // still loading: not stuck yet
    if (stuck.state === 'running') return;
    if (!episode) {
      episode = { start: performance.now(), rebuilds: 0, gaveUp: false };
      reportIssue('audio stuck after tap, rebuilding context', 'warning', episodeInfo(stuck.state));
    }
    if (episode.rebuilds >= MAX_REBUILDS) {
      episode.gaveUp = true;
      reportIssue('audio still stuck after rebuilds, giving up', 'error', episodeInfo(stuck.state));
      return;
    }
    episode.rebuilds++;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    stuck.close().catch(() => {});
    ctx = null;
    if (ensureContext()) startLoading();
  }, 600);
}

// ---------------------------------------------------------------- API

function init() {
  if (!unlock()) return Promise.resolve(false);
  return startLoading();
}

function setParam(voice, name, value) {
  const store = latest[voice];
  if (!store) return;
  if (name === 'pop' && store.get(name) !== value) buzz();
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

// A short buzz on pop. Android only; elsewhere vibrate is missing or a no-op.
function buzz() {
  try {
    // No amplitude control on the web, so "harder" = longer + a pattern:
    // a sharp hit, a tiny gap, then a longer rumble.
    navigator.vibrate?.([70, 30, 120]);
  } catch (_) {}
}

// ---------------------------------------------------------------- recording

const REC_TYPES = [
  ['audio/mp4', 'm4a'], // Safari
  // .weba, not .webm: Chrome's share sheet only takes audio/webm as .weba.
  ['audio/webm;codecs=opus', 'weba'], // Chrome, Firefox
  ['audio/ogg;codecs=opus', 'ogg'],
];
const REC_MAX_MS = 60000;
let recorder = null;
let recChunks = [];
let recDone = null; // Promise<File|null> for the recording in progress
let recTimer = 0;

function canRecord() {
  return typeof MediaRecorder !== 'undefined' && !!AudioContextClass;
}

function startRecording() {
  if (!canRecord() || recorder) {
    console.warn(`[rec] can't start: canRecord ${canRecord()}, already recording ${!!recorder} (${recorder?.state})`);
    return false;
  }
  init(); // a gesture: unlock audio too, so recording can be the first thing you do
  // Tapped in only while recording: on iOS a live MediaStream destination
  // moves the whole context onto a slower path and every tap lags.
  if (!recDest && ctx?.createMediaStreamDestination) recDest = ctx.createMediaStreamDestination();
  if (recDest) limiter.connect(recDest);
  if (!recDest) {
    console.warn('[rec] no MediaStream destination on this AudioContext');
    return false;
  }
  const [type, ext] = REC_TYPES.find(([t]) => MediaRecorder.isTypeSupported?.(t)) ?? ['', 'weba'];
  try {
    recorder = new MediaRecorder(recDest.stream, type ? { mimeType: type } : undefined);
  } catch (err) {
    reportError(err, 'MediaRecorder failed');
    try { limiter.disconnect(recDest); } catch (_) {}
    recorder = null;
    return false;
  }
  recChunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) recChunks.push(e.data);
  };
  recDone = new Promise((resolve) => {
    recorder.onstop = () => {
      const mime = recorder.mimeType || type || 'audio/webm';
      const blob = new Blob(recChunks, { type: mime });
      console.info(`[rec] stopped: ${recChunks.length} chunks, ${blob.size} bytes`);
      recorder = null;
      recChunks = [];
      clearTimeout(recTimer);
      try { limiter.disconnect(recDest); } catch (_) {}
      // A live MediaStream track keeps iOS showing the capture indicator
      // (and the slow audio path); end it and build a fresh one next time.
      recDest?.stream.getTracks().forEach((t) => t.stop());
      recDest = null;
      // Chrome's share sheet refuses an .m4a typed audio/mp4 ("Permission
      // denied") but takes the same file as audio/x-m4a.
      const fileType = ext === 'm4a' ? 'audio/x-m4a' : mime.split(';')[0];
      resolve(blob.size ? new File([blob], `balloons.${ext}`, { type: fileType }) : null);
    };
  });
  recorder.start(1000);
  console.info(`[rec] recording ${recorder.mimeType || type || '(default type)'}`);
  recTimer = setTimeout(() => recorder?.state === 'recording' && recorder.stop(), REC_MAX_MS);
  return true;
}

// Also collects a clip that already stopped itself at REC_MAX_MS.
function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  const done = recDone ?? Promise.resolve(null);
  recDone = null;
  return done;
}

function isRecording() {
  return !!recorder;
}

window.balloonAudio = {
  init, setParam, gate, isRunning, debugLevel,
  startRecording, stopRecording, isRecording, canRecord,
};

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
      `${ctx ? ctx.sampleRate : '-'} Hz | ` +
      `latency ${ctx ? ((ctx.baseLatency ?? 0) * 1000).toFixed(0) : '-'}+${ctx ? ((ctx.outputLatency ?? 0) * 1000).toFixed(0) : '-'} ms | level ${db.toFixed(0)} dB | peak ${peak.toFixed(0)} dB`;
  }, 150);
}

// In the background: stop any recording and suspend the context, so the
// page holds no live audio session (iOS keeps its indicator lit otherwise).
// Back in front: resume (works where the page already had a gesture; on iOS
// the next tap resumes it via init()).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    lastShownAt = performance.now();
    // A new trip to the background starts a fresh episode (and new rebuilds).
    episode = null;
  }
  if (!ctx) return;
  if (document.hidden) {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    if (ctx.state === 'running') ctx.suspend().catch(() => {});
  } else if (ctx.state !== 'running' && ctx.state !== 'closed') {
    ctx.resume().catch(() => {});
  }
});
window.addEventListener('pagehide', () => {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  ctx?.suspend().catch(() => {});
});

// Once the page is idle, download the voices and build them into a suspended
// AudioContext, so the first tap only has to resume it (instant) instead of
// doing all the setup while the finger is down.
window.addEventListener('load', () => {
  const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 300));
  idle(() => {
    if (ensureContext()) startLoading();
  }, { timeout: 1500 });
});
