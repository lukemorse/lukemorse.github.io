// balloon_input.js: computer keyboard and Web MIDI, forwarded to Dart.
//
// Listening here (not through Flutter focus) means the keys still play when
// focus is on the i button or inside the about card.
//
// API on window.balloonInput (Dart reaches it via lib/audio/js_bridge.dart):
//   onKey(f)       f(letter, step, down)  letter 0..3 = L U K E, step 0..7
//   onMidi(f)      f(kind, a, b)  kind 'on' (note, velocity) | 'off' (note, 0)
//                                 | 'bend' (-1..1, 0) | 'cc' (number, 0..1)
//   connectMidi()  -> Promise<string>  'connected' | 'unsupported' | 'denied'
//   midiDevices()  -> string[]  names of the MIDI inputs plugged in now
//   onMidiDevices(f)  f(names) whenever an input is plugged in or out
//   midiSelected() -> string    name of the input played from, '' = all
//   selectMidi(name)            play from just that input ('' = all);
//                               remembered across visits
//
// Keys go by physical position (e.code), so the rows are the same on any
// layout. Top row is the lowest letter:
//   1 2 3 4 5 6 7 8  -> L     q w e r t y u i -> U
//   a s d f g h j k  -> K     z x c v b n m , -> E
//
// A classic script (not a module) loaded before flutter_bootstrap.js, so
// window.balloonInput exists by the time Dart registers its callbacks.

(() => {
  const ROWS = [
    ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8'],
    ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI'],
    ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK'],
    ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma'],
  ];
  const KEYMAP = new Map();
  ROWS.forEach((row, letter) => row.forEach((code, step) => KEYMAP.set(code, [letter, step])));

  const keyListeners = [];
  const midiListeners = [];
  const down = new Set(); // e.code of keys currently held

  const emitKey = (code, isDown) => {
    const [letter, step] = KEYMAP.get(code);
    for (const f of keyListeners) f(letter, step, isDown);
  };
  const emitMidi = (kind, a, b) => {
    for (const f of midiListeners) f(kind, a, b);
  };

  const editable = (el) =>
    el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  document.addEventListener('keydown', (e) => {
    if (!KEYMAP.has(e.code) || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (editable(e.target) || down.has(e.code)) return;
    down.add(e.code);
    emitKey(e.code, true);
  });
  document.addEventListener('keyup', (e) => {
    if (!down.delete(e.code)) return;
    emitKey(e.code, false);
  });

  // Let go of everything when the page loses focus: the keyup would never come.
  function releaseAll() {
    for (const code of down) emitKey(code, false);
    down.clear();
    for (const note of midiDown) emitMidi('off', note, 0);
    midiDown.clear();
  }
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAll();
  });

  // ---------------------------------------------------------------- MIDI

  const midiDown = new Set();
  const deviceListeners = [];
  let midiAccess = null;

  // Which input to play from, by name ('' = every input). A DAW's virtual
  // ports show up as inputs too, so with several around the player picks one.
  const PICK_KEY = 'balloons.midiInput';
  let selected = '';
  try { selected = localStorage.getItem(PICK_KEY) || ''; } catch (_) {}

  const midiDevices = () =>
    midiAccess
      ? [...midiAccess.inputs.values()].filter((i) => i.state === 'connected').map((i) => i.name || 'MIDI keyboard')
      : [];

  // A remembered input that isn't plugged in now doesn't silence the rest.
  const listening = (input) =>
    !selected || input.name === selected || !midiDevices().includes(selected);

  function selectMidi(name) {
    selected = name || '';
    try {
      if (selected) localStorage.setItem(PICK_KEY, selected);
      else localStorage.removeItem(PICK_KEY);
    } catch (_) {}
    // Notes held on the input we stopped listening to would never get their off.
    for (const note of midiDown) emitMidi('off', note, 0);
    midiDown.clear();
  }

  function onMidiMessage(e) {
    if (!listening(e.currentTarget ?? e.target)) return;
    const [status, d1 = 0, d2 = 0] = e.data;
    const type = status & 0xf0;
    if (type === 0x90 && d2 > 0) {
      midiDown.add(d1);
      emitMidi('on', d1, d2 / 127);
    } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
      if (midiDown.delete(d1)) emitMidi('off', d1, 0);
    } else if (type === 0xe0) {
      emitMidi('bend', (((d2 << 7) | d1) - 8192) / 8192, 0);
    } else if (type === 0xb0) {
      emitMidi('cc', d1, d2 / 127);
    }
  }

  function attachInputs() {
    for (const input of midiAccess.inputs.values()) input.onmidimessage = onMidiMessage;
    const names = midiDevices();
    console.info(`[balloonInput] MIDI inputs: ${names.join(', ') || '(none)'}`);
    for (const f of deviceListeners) f(names);
  }

  async function connectMidi() {
    if (!navigator.requestMIDIAccess) return 'unsupported';
    if (midiAccess) return 'connected';
    try {
      midiAccess = await navigator.requestMIDIAccess();
    } catch (err) {
      console.warn('[balloonInput] MIDI unavailable:', err?.message ?? err);
      return 'denied';
    }
    attachInputs();
    midiAccess.onstatechange = attachInputs; // keyboards plugged in later
    return 'connected';
  }

  // Reconnect silently if MIDI was allowed before; never prompt on load.
  try {
    navigator.permissions
      ?.query({ name: 'midi' })
      .then((p) => {
        if (p.state === 'granted') connectMidi();
      })
      .catch(() => {});
  } catch (_) {} // some browsers throw for unknown permission names

  window.balloonInput = {
    onKey: (f) => { keyListeners.push(f); },
    onMidi: (f) => { midiListeners.push(f); },
    connectMidi,
    midiConnected: () => !!midiAccess,
    midiDevices,
    midiSelected: () => selected,
    selectMidi,
    onMidiDevices: (f) => { deviceListeners.push(f); },
  };
})();
