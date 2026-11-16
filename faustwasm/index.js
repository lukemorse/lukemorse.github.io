var __typeError = (msg) => {
  throw TypeError(msg);
};
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);

// src/instantiateFaustModuleFromFile.ts
var instantiateFaustModuleFromFile = async (jsFile, dataFile = jsFile.replace(/c?js$/, "data"), wasmFile = jsFile.replace(/c?js$/, "wasm")) => {
  var _a, _b;
  let FaustModule;
  let dataBinary;
  let wasmBinary;
  const jsCodeHead = /var (\w+)\s*=\s*\(/;
  if (typeof window === "object") {
    let jsCode = await (await fetch(jsFile)).text();
    jsCode = `${jsCode}
export default ${(_a = jsCode.match(jsCodeHead)) == null ? void 0 : _a[1]};
`;
    const jsFileMod = URL.createObjectURL(
      new Blob([jsCode], { type: "text/javascript" })
    );
    FaustModule = (await import(
      /* webpackIgnore: true */
      jsFileMod
    )).default;
    dataBinary = await (await fetch(dataFile)).arrayBuffer();
    wasmBinary = await (await fetch(wasmFile)).arrayBuffer();
  } else {
    const { promises: fs } = await import("fs");
    const { pathToFileURL } = await import("url");
    let jsCode = await fs.readFile(jsFile, { encoding: "utf-8" });
    jsCode = `
import process from "process";
import * as path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);

${jsCode}

export default ${(_b = jsCode.match(jsCodeHead)) == null ? void 0 : _b[1]};
`;
    const unique = `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const jsFileMod = jsFile.replace(/c?js$/, `${unique}.mjs`);
    await fs.writeFile(jsFileMod, jsCode);
    try {
      FaustModule = (await import(
        /* webpackIgnore: true */
        pathToFileURL(jsFileMod).href
      )).default;
    } finally {
      await fs.unlink(jsFileMod).catch(() => {
      });
    }
    dataBinary = new Uint8Array(await fs.readFile(dataFile)).buffer;
    wasmBinary = new Uint8Array(await fs.readFile(wasmFile)).buffer;
  }
  const faustModule = await FaustModule({
    wasmBinary,
    getPreloadedPackage: (remotePackageName, remotePackageSize) => {
      if (remotePackageName === "libfaust-wasm.data") return dataBinary;
      return new ArrayBuffer(0);
    }
  });
  return faustModule;
};
var instantiateFaustModuleFromFile_default = instantiateFaustModuleFromFile;

// src/FaustAudioWorkletProcessor.ts
var getFaustAudioWorkletProcessor = (dependencies, faustData, register = true) => {
  const { registerProcessor, AudioWorkletProcessor, sampleRate } = globalThis;
  const audioClock = globalThis;
  const kBlockSize = 128;
  const statusChannel = (status) => status >= 128 && status < 240 ? status & 15 : -1;
  const messageChannel = (msg) => {
    switch (msg.type) {
      case "midi":
        return statusChannel(msg.data[0]);
      case "wam-midi":
        return statusChannel(msg.data.bytes[0]);
      case "ctrlChange":
      case "pitchWheel":
      case "keyOn":
      case "keyOff":
        return msg.data[0];
      default:
        return -1;
    }
  };
  const kFromAutomation = -2;
  const kFromSensors = -1;
  const kCancelled = () => {
  };
  const kRampChanges = 16;
  const kRampStride = 16;
  const {
    FaustBaseWebAudioDsp: FaustBaseWebAudioDsp2,
    FaustWasmInstantiator: FaustWasmInstantiator2,
    FaustAudioWorkletProcessorCommunicator: FaustAudioWorkletProcessorCommunicator2
  } = dependencies;
  const { processorName, dspName, dspMeta, effectMeta, poly } = faustData;
  const analysePolyParameters = (item) => {
    const polyKeywords = [
      "/gate",
      "/freq",
      "/gain",
      "/key",
      "/vel",
      "/velocity"
    ];
    const isPolyReserved = "address" in item && !!polyKeywords.find((k) => item.address.endsWith(k));
    if (poly && isPolyReserved) return null;
    if (item.type === "vslider" || item.type === "hslider" || item.type === "nentry") {
      return {
        name: item.address,
        defaultValue: item.init || 0,
        minValue: item.min || 0,
        maxValue: item.max || 0
      };
    } else if (item.type === "button" || item.type === "checkbox") {
      return {
        name: item.address,
        defaultValue: item.init || 0,
        minValue: 0,
        maxValue: 1
      };
    }
    return null;
  };
  class FaustAudioWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super(options);
      this.paramValuesCache = {};
      /**
       * Port messages waiting for the block they were timestamped for.
       *
       * Sorted by frame, then by arrival. `process` drains everything up to
       * the end of the block it is about to render; the rest waits.
       */
      this.fEventQueue = [];
      this.fEventSeq = 0;
      /**
       * The events of the block about to be rendered.
       *
       * Refilled rather than reallocated, so a quiet block allocates
       * nothing.
       */
      this.fBlockEvents = [];
      /**
       * Scratch space for the frames one control's automation changed on.
       * Reused for the same reason as `fBlockEvents`.
       */
      this.fChangedFrames = [];
      this.fCommunicator = new FaustAudioWorkletProcessorCommunicator2(
        this.port
      );
      const { parameterDescriptors } = this.constructor;
      parameterDescriptors.forEach((pd) => {
        this.paramValuesCache[pd.name] = pd.defaultValue || 0;
      });
      const { moduleId, instanceId } = options.processorOptions;
      if (!moduleId || !instanceId) return;
      this.wamInfo = { moduleId, instanceId };
    }
    static get parameterDescriptors() {
      const params = [];
      const origin = /* @__PURE__ */ new Map();
      const collect = (side) => (item) => {
        const param = analysePolyParameters(item);
        if (!param) return;
        const previous = origin.get(param.name);
        if (previous === side) {
          throw new Error(
            `Faust: control "${param.name}" is declared twice in the ${side}. Two widgets resolved to the same path, so one of them would be unreachable. Give them distinct labels or groups.`
          );
        }
        if (previous !== void 0) {
          throw new Error(
            `Faust: control "${param.name}" is declared both in the ${previous} and in the ${side}. A polyphonic DSP cannot share a control path between \`process\` and \`effect\`: setParamValue routes a path to one side only, so the other would keep its default. Declare it under a distinct path on each side and have the host write both.`
          );
        }
        origin.set(param.name, side);
        params.push(param);
      };
      FaustBaseWebAudioDsp2.parseUI(dspMeta.ui, collect("voice"));
      if (effectMeta)
        FaustBaseWebAudioDsp2.parseUI(effectMeta.ui, collect("effect"));
      return params;
    }
    setupWamEventHandler() {
      var _a;
      if (!this.wamInfo) return;
      const { moduleId, instanceId } = this.wamInfo;
      const { webAudioModules } = globalThis;
      const ModuleScope = webAudioModules.getModuleScope(
        moduleId
      );
      const paramMgrProcessor = (_a = ModuleScope == null ? void 0 : ModuleScope.paramMgrProcessors) == null ? void 0 : _a[instanceId];
      if (!paramMgrProcessor) return;
      if (paramMgrProcessor.handleEvent) return;
      paramMgrProcessor.handleEvent = (event) => {
        if (event.type === "wam-midi")
          this.atTime(
            event,
            () => this.midiMessage(event.data.bytes)
          );
      };
    }
    /**
     * Read a message's timestamp as a whole frame on the audio clock.
     * Null if it carries none, meaning now.
     *
     * Both routes round, and both reject anything non-finite. A fraction
     * would become a fractional slice count and a channel pointer partway
     * through a sample. A NaN compares false against every frame, so a
     * queued one would stay at the head of the queue and block every event
     * behind it.
     */
    messageFrame(msg) {
      const frame = Number.isFinite(msg.frame) ? msg.frame : Number.isFinite(msg.time) ? msg.time * sampleRate : null;
      return frame === null ? null : Math.round(frame);
    }
    /**
     * Apply `apply` now, or queue it for the frame the sender asked for.
     *
     * Untimed messages are applied on arrival, between two blocks, which
     * is equivalent to frame 0 of the next one. A throw from one of those
     * escapes the port handler and costs that message, as it always did.
     *
     * Timed ones have to catch. They run from inside `process`, and the
     * Web Audio spec's response to a `process` that throws is to fire
     * `processorerror` and stop calling the node -- so one bad message
     * would silence the device permanently.
     */
    atTime(msg, apply) {
      const frame = this.messageFrame(msg);
      if (frame === null) {
        apply();
        return;
      }
      const event = {
        frame,
        seq: this.fEventSeq++,
        channel: messageChannel(msg),
        apply: () => {
          try {
            apply();
          } catch (error) {
            console.error(
              `Faust: a message timed for frame ${frame} threw and was dropped`,
              error
            );
          }
        }
      };
      let i = this.fEventQueue.length;
      while (i > 0 && this.fEventQueue[i - 1].frame > frame) i--;
      this.fEventQueue.splice(i, 0, event);
    }
    /**
     * Cancel everything scheduled and not yet performed.
     *
     * A panic, or the end of the DSP's life, has to reach the notes that
     * have not sounded yet as well as the ones that have -- otherwise they
     * play afterwards, over a device that was told to be quiet.
     *
     * That means the queue and the rest of the block being rendered, whose
     * events have already left the queue. Messages only: automation and
     * sensor writes are the state of the controls through the block, and
     * an all-notes-off should not stop a filter sweep.
     */
    flushEvents() {
      this.fEventQueue.length = 0;
      for (const event of this.fBlockEvents) {
        if (event.seq >= 0) event.apply = kCancelled;
      }
    }
    /**
     * Cancel the MIDI messages of one channel scheduled and not yet
     * performed: what CC 120/123 on that channel asks for.
     *
     * All Notes Off and All Sound Off are channel mode messages, and the
     * polyphonic DSP only ends the voices of their channel: the notes
     * waiting on other channels, and the control messages, are left alone.
     *
     * @param channel - the MIDI channel, 0..15
     */
    flushChannelEvents(channel) {
      const queue = this.fEventQueue;
      let kept = 0;
      for (let i = 0; i < queue.length; i++) {
        if (queue[i].channel !== channel) queue[kept++] = queue[i];
      }
      queue.length = kept;
      for (const event of this.fBlockEvents) {
        if (event.seq >= 0 && event.channel === channel)
          event.apply = kCancelled;
      }
    }
    /** Whether the DSP receives raw MIDI on `channel`, 0..15. */
    acceptsMidiChannel(channel) {
      const received = this.fDSPCode.getMidiChannel();
      return received === 0 || channel === received - 1;
    }
    /**
     * Whether a controller number silences the instrument.
     *
     * Exactly the two `FaustPolyWebAudioDsp.ctrlChange` treats as
     * all-notes-off for their channel. Not 121, which resets controllers
     * without ending a note, and not 122, which is a keyboard's local
     * control.
     */
    isPanic(ctrl) {
      return ctrl === 120 || ctrl === 123;
    }
    /**
     * One control's automation for the block, as events.
     *
     * A control that holds arrives as a single value, worth an event only
     * if it differs from what the DSP has. A control that moves arrives as
     * 128, and each change is an edge due on its own frame.
     *
     * Reading only `[0]`, as this used to, pushes every `setValueAtTime`
     * out to the next block boundary and misses a `1 -> 0 -> 1` inside one
     * block completely -- a gate that never retriggers.
     *
     * Above `kRampChanges` the control is ramping rather than stepping,
     * and is followed at `kRampStride`. See the constants.
     */
    collectAutomation(path, automation, events) {
      const changes = this.fChangedFrames;
      changes.length = 0;
      let last = this.paramValuesCache[path];
      for (let i = 0; i < automation.length; i++) {
        if (automation[i] === last) continue;
        last = automation[i];
        changes.push(i);
      }
      if (changes.length === 0) return;
      const stride = changes.length > kRampChanges ? kRampStride : 1;
      for (let n = 0; n < changes.length; n += stride) {
        const frame = changes[n];
        events.push(this.paramEvent(path, automation[frame], frame));
      }
      const lastChange = changes.length - 1;
      if (lastChange % stride) {
        const frame = changes[lastChange];
        events.push(this.paramEvent(path, automation[frame], frame));
      }
    }
    paramEvent(path, value, frame) {
      return {
        frame,
        seq: kFromAutomation,
        apply: () => this.setParamValue(path, value)
      };
    }
    /**
     * Everything due inside the block starting at `start`.
     *
     * Three sources: the automation each `AudioParam` handed over, any new
     * sensor readings, and the port messages timestamped for a frame
     * inside the block.
     *
     * Sorted by frame, and on a tie by source -- see `FaustTimedEventSeq`.
     */
    collectEvents(parameters, start) {
      const events = this.fBlockEvents;
      events.length = 0;
      for (const path in parameters) {
        this.collectAutomation(path, parameters[path], events);
      }
      if (this.fCommunicator.getNewAccDataAvailable()) {
        const acc = this.fCommunicator.getAcc();
        if (acc) {
          this.fCommunicator.setNewAccDataAvailable(false);
          const { invert, ...data } = acc;
          events.push({
            frame: 0,
            seq: kFromSensors,
            apply: () => this.propagateAcc(data, invert)
          });
        }
      }
      if (this.fCommunicator.getNewGyrDataAvailable()) {
        const gyr = this.fCommunicator.getGyr();
        if (gyr) {
          this.fCommunicator.setNewGyrDataAvailable(false);
          events.push({
            frame: 0,
            seq: kFromSensors,
            apply: () => this.propagateGyr(gyr)
          });
        }
      }
      const end = start + kBlockSize;
      let ordinal = 0;
      while (this.fEventQueue.length && this.fEventQueue[0].frame < end) {
        const event = this.fEventQueue.shift();
        event.frame = Math.max(0, event.frame - start);
        event.seq = ordinal++;
        events.push(event);
      }
      if (events.length > 1) {
        events.sort((a, b) => a.frame - b.frame || a.seq - b.seq);
      }
      return events;
    }
    process(inputs, outputs, parameters) {
      const events = this.collectEvents(
        parameters,
        audioClock.currentFrame
      );
      return this.fDSPCode.compute(inputs[0], outputs[0], events);
    }
    handleMessageAux(e) {
      const msg = e.data;
      switch (msg.type) {
        // Generic MIDI message
        case "midi": {
          this.atTime(msg, () => {
            const channel = msg.data[0] & 15;
            if (msg.data[0] >> 4 === 11 && this.isPanic(msg.data[1]) && this.acceptsMidiChannel(channel))
              this.flushChannelEvents(channel);
            this.midiMessage(msg.data);
          });
          break;
        }
        // Typed MIDI message
        case "ctrlChange": {
          this.atTime(msg, () => {
            if (this.isPanic(msg.data[1]))
              this.flushChannelEvents(msg.data[0]);
            this.ctrlChange(msg.data[0], msg.data[1], msg.data[2]);
          });
          break;
        }
        // Received MIDI channel, applied on arrival like the other
        // settings of the DSP
        case "midiChannel": {
          this.fDSPCode.setMidiChannel(msg.data);
          break;
        }
        case "pitchWheel": {
          this.atTime(
            msg,
            () => this.pitchWheel(msg.data[0], msg.data[1])
          );
          break;
        }
        case "keyOn": {
          this.atTime(
            msg,
            () => this.keyOn(msg.data[0], msg.data[1], msg.data[2])
          );
          break;
        }
        case "keyOff": {
          this.atTime(
            msg,
            () => this.keyOff(msg.data[0], msg.data[1], msg.data[2])
          );
          break;
        }
        // Generic data message
        case "param": {
          this.atTime(
            msg,
            () => this.setParamValue(msg.data.path, msg.data.value)
          );
          break;
        }
        // Plot handler set on demand
        case "setPlotHandler": {
          if (msg.data) {
            this.fDSPCode.setPlotHandler(
              (output, index, events) => this.port.postMessage({
                type: "plot",
                value: output,
                index,
                events
              })
            );
          } else {
            this.fDSPCode.setPlotHandler(null);
          }
          break;
        }
        // Non-finite guard set on demand
        case "setNonFiniteHandler": {
          this.fDSPCode.setNonFiniteHandler(
            msg.data ? () => this.port.postMessage({ type: "nonfinite" }) : null
          );
          break;
        }
        case "setupWamEventHandler": {
          this.setupWamEventHandler();
          break;
        }
        case "init": {
          this.fDSPCode.init();
          break;
        }
        case "instanceInit": {
          this.fDSPCode.instanceInit();
          break;
        }
        case "instanceClear": {
          this.flushEvents();
          this.fDSPCode.instanceClear();
          break;
        }
        case "instanceConstants": {
          this.fDSPCode.instanceConstants();
          break;
        }
        case "instanceResetUserInterface": {
          this.fDSPCode.instanceResetUserInterface();
          break;
        }
        case "start": {
          this.fDSPCode.start();
          break;
        }
        case "stop": {
          this.flushEvents();
          this.fDSPCode.stop();
          break;
        }
        case "destroy": {
          this.flushEvents();
          this.port.close();
          this.fDSPCode.destroy();
          break;
        }
        default:
          break;
      }
    }
    setParamValue(path, value) {
      this.fDSPCode.setParamValue(path, value);
      this.paramValuesCache[path] = value;
    }
    midiMessage(data) {
      this.fDSPCode.midiMessage(data);
    }
    ctrlChange(channel, ctrl, value) {
      this.fDSPCode.ctrlChange(channel, ctrl, value);
    }
    pitchWheel(channel, wheel) {
      this.fDSPCode.pitchWheel(channel, wheel);
    }
    keyOn(channel, pitch, velocity) {
      this.fDSPCode.keyOn(channel, pitch, velocity);
    }
    keyOff(channel, pitch, velocity) {
      this.fDSPCode.keyOff(channel, pitch, velocity);
    }
    propagateAcc(accelerationIncludingGravity, invert = false) {
      this.fDSPCode.propagateAcc(accelerationIncludingGravity, invert);
    }
    propagateGyr(event) {
      this.fDSPCode.propagateGyr(event);
    }
  }
  class FaustMonoAudioWorkletProcessor extends FaustAudioWorkletProcessor {
    constructor(options) {
      super(options);
      this.handleMessageAux = (e) => {
        super.handleMessageAux(e);
      };
      const { FaustMonoWebAudioDsp: FaustMonoWebAudioDsp2 } = dependencies;
      const { factory, sampleSize } = options.processorOptions;
      const instance = FaustWasmInstantiator2.createSyncMonoDSPInstance(factory);
      this.fDSPCode = new FaustMonoWebAudioDsp2(
        instance,
        sampleRate,
        sampleSize,
        128,
        factory.soundfiles
      );
      this.port.addEventListener("message", this.handleMessageAux);
      this.port.start();
      this.fDSPCode.setOutputParamHandler(
        (path, value) => this.port.postMessage({ path, value, type: "out-param" })
      );
      this.fDSPCode.setInputParamHandler(
        (path, value) => this.port.postMessage({ path, value, type: "in-param" })
      );
      this.fDSPCode.start();
    }
  }
  class FaustPolyAudioWorkletProcessor extends FaustAudioWorkletProcessor {
    constructor(options) {
      super(options);
      // Raw MIDI goes to `FaustPolyWebAudioDsp.midiMessage`, which applies
      // the received channel before decoding notes. The base switch already
      // routes 'keyOn' and 'keyOff' through `this.keyOn` / `this.keyOff`,
      // overridden below.
      this.handleMessageAux = (e) => {
        if (e.data.type === "allNotesOff") {
          this.flushEvents();
          this.allNotesOff(e.data.data);
          return;
        }
        super.handleMessageAux(e);
      };
      const { FaustPolyWebAudioDsp: FaustPolyWebAudioDsp3 } = dependencies;
      const {
        voiceFactory,
        mixerModule,
        voices,
        effectFactory,
        sampleSize,
        stopLevel
      } = options.processorOptions;
      const instance = FaustWasmInstantiator2.createSyncPolyDSPInstance(
        voiceFactory,
        mixerModule,
        voices,
        effectFactory
      );
      const soundfiles = {
        ...effectFactory == null ? void 0 : effectFactory.soundfiles,
        ...voiceFactory.soundfiles
      };
      this.fDSPCode = new FaustPolyWebAudioDsp3(
        instance,
        sampleRate,
        sampleSize,
        128,
        soundfiles,
        stopLevel
      );
      this.port.addEventListener("message", this.handleMessageAux);
      this.port.start();
      this.fDSPCode.setOutputParamHandler(
        (path, value) => this.port.postMessage({ path, value, type: "out-param" })
      );
      this.fDSPCode.setInputParamHandler(
        (path, value) => this.port.postMessage({ path, value, type: "in-param" })
      );
      this.fDSPCode.setActiveVoicesHandler(
        (count) => this.port.postMessage({ value: count, type: "active-voices" })
      );
      this.fDSPCode.start();
    }
    // Public API
    keyOn(channel, pitch, velocity) {
      this.fDSPCode.keyOn(channel, pitch, velocity);
    }
    keyOff(channel, pitch, velocity) {
      this.fDSPCode.keyOff(channel, pitch, velocity);
    }
    allNotesOff(hard) {
      this.fDSPCode.allNotesOff(hard);
    }
  }
  const Processor = poly ? FaustPolyAudioWorkletProcessor : FaustMonoAudioWorkletProcessor;
  if (register) {
    const name = processorName || dspName || (poly ? "mydsp_poly" : "mydsp");
    const scope = globalThis;
    if (!scope.__faustRegisteredProcessors) {
      scope.__faustRegisteredProcessors = /* @__PURE__ */ new Set();
    }
    if (!scope.__faustRegisteredProcessors.has(name)) {
      registerProcessor(name, Processor);
      scope.__faustRegisteredProcessors.add(name);
    }
  }
  return poly ? FaustPolyAudioWorkletProcessor : FaustMonoAudioWorkletProcessor;
};
var FaustAudioWorkletProcessor_default = getFaustAudioWorkletProcessor;

// src/FaustFFTAudioWorkletProcessor.ts
var getFaustFFTAudioWorkletProcessor = (dependencies, faustData, register = true) => {
  const { registerProcessor, AudioWorkletProcessor, sampleRate } = globalThis;
  const audioClock = globalThis;
  const kBlockSize = 128;
  const {
    FaustBaseWebAudioDsp: FaustBaseWebAudioDsp2,
    FaustWasmInstantiator: FaustWasmInstantiator2,
    FaustMonoWebAudioDsp: FaustMonoWebAudioDsp2,
    FaustAudioWorkletProcessorCommunicator: FaustAudioWorkletProcessorCommunicator2,
    FFTUtils
  } = dependencies;
  const { processorName, dspName, dspMeta, fftOptions } = faustData;
  const { windowFunctions, getFFT, fftToSignal, signalToFFT, signalToNoFFT } = FFTUtils;
  const ceil = (x, to) => Math.abs(to) < 1 ? Math.ceil(x * (1 / to)) / (1 / to) : Math.ceil(x / to) * to;
  const mod = (x, y) => (x % y + y) % y;
  const apply = (array, windowFunction) => {
    for (let i = 0; i < array.length; i++) {
      array[i] *= windowFunction(i, array.length);
    }
  };
  const fftParamKeywords = [
    "/fftSize",
    "/fftHopSize",
    "/fftOverlap",
    "/windowFunction",
    "/noIFFT"
  ];
  const setTypedArray = (to, from, offsetTo = 0, offsetFrom = 0) => {
    const toLength = to.length;
    const fromLength = from.length;
    const spillLength = Math.min(toLength, fromLength);
    let spilled = 0;
    let $to = mod(offsetTo, toLength) || 0;
    let $from = mod(offsetFrom, fromLength) || 0;
    while (spilled < spillLength) {
      const $spillLength = Math.min(
        spillLength - spilled,
        toLength - $to,
        fromLength - $from
      );
      const $fromEnd = $from + $spillLength;
      if ($from === 0 && $fromEnd === fromLength) to.set(from, $to);
      else to.set(from.subarray($from, $fromEnd), $to);
      $to = ($to + $spillLength) % toLength;
      $from = $fromEnd % fromLength;
      spilled += $spillLength;
    }
    return $to;
  };
  const analyseParameters = (item) => {
    const isFFTReserved = "address" in item && !!fftParamKeywords.find((k) => item.address.endsWith(k));
    if (isFFTReserved) return null;
    if (item.type === "vslider" || item.type === "hslider" || item.type === "nentry") {
      return {
        name: item.address,
        defaultValue: item.init || 0,
        minValue: item.min || 0,
        maxValue: item.max || 0
      };
    } else if (item.type === "button" || item.type === "checkbox") {
      return {
        name: item.address,
        defaultValue: item.init || 0,
        minValue: 0,
        maxValue: 1
      };
    }
    return null;
  };
  class FaustFFTAudioWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super(options);
      this.paramValuesCache = {};
      /**
       * Port messages waiting for the block they were timestamped for.
       *
       * The node puts a `time` on every control it sends. This processor
       * used to ignore it, which mattered most for MIDI messages: nothing
       * mirrors those onto an `AudioParam`, so the timestamp did nothing and
       * the message landed whenever it was posted.
       *
       * They now wait here and are applied at the top of the block that
       * contains the instant. Two limits:
       *
       * Block, not sample. This processor buffers input into an FFT window
       * and hands the DSP whole frames of spectrum, so a control write
       * partway through what it computes has no meaning.
       *
       * A `param` still resolves one block later than that. The
       * `[0]`-against-cache sync below reads the AudioParam at the start of
       * the block and writes the pre-`time` value back over it; the intended
       * value arrives with the next block. Nothing is computed in between,
       * so there is no artefact.
       */
      this.fEventQueue = [];
      this.destroyed = false;
      /** Pointer of next start sample to write of the FFT input window */
      this.$inputWrite = 0;
      /** Pointer of next start sample to read of the FFT input window */
      this.$inputRead = 0;
      /** Pointer of next start sample to write of the FFT output window */
      this.$outputWrite = 0;
      /** Pointer of next start sample to read of the FFT output window */
      this.$outputRead = 0;
      /** Not perform in IFFT when reconstruct the audio signal */
      this.noIFFT = false;
      /** audio data from input, array of channels */
      this.fftInput = [];
      /** audio data for output, array of channels */
      this.fftOutput = [];
      /** FFT Overlaps, 1 means no overlap */
      this.fftOverlap = 0;
      this.fftHopSize = 0;
      this.fftSize = 0;
      this.fftBufferSize = 0;
      this.fPlotHandler = null;
      this.fNonFiniteHandler = null;
      this.fCachedEvents = [];
      this.fBufferNum = 0;
      this.soundfiles = {};
      this.windowFunction = null;
      this.handleMessageAux = (e) => {
        var _a, _b, _c, _d;
        const msg = e.data;
        switch (msg.type) {
          // Generic MIDI message
          case "midi":
            this.atTime(msg, () => this.midiMessage(msg.data));
            break;
          // Typed MIDI message
          case "ctrlChange":
            this.atTime(
              msg,
              () => this.ctrlChange(msg.data[0], msg.data[1], msg.data[2])
            );
            break;
          case "pitchWheel":
            this.atTime(
              msg,
              () => this.pitchWheel(msg.data[0], msg.data[1])
            );
            break;
          // Generic data message
          case "param":
            this.atTime(
              msg,
              () => this.setParamValue(msg.data.path, msg.data.value)
            );
            break;
          // Plot handler set on demand
          case "setPlotHandler": {
            if (msg.data) {
              this.fPlotHandler = (output, index, events) => {
                if (events) this.fCachedEvents.push(...events);
              };
            } else {
              this.fPlotHandler = null;
            }
            (_a = this.fDSPCode) == null ? void 0 : _a.setPlotHandler(this.fPlotHandler);
            break;
          }
          // Non-finite guard set on demand
          case "setNonFiniteHandler": {
            this.fNonFiniteHandler = msg.data ? () => this.port.postMessage({ type: "nonfinite" }) : null;
            (_b = this.fDSPCode) == null ? void 0 : _b.setNonFiniteHandler(this.fNonFiniteHandler);
            break;
          }
          case "setupWamEventHandler": {
            this.setupWamEventHandler();
            break;
          }
          case "start": {
            (_c = this.fDSPCode) == null ? void 0 : _c.start();
            break;
          }
          case "stop": {
            this.fEventQueue.length = 0;
            (_d = this.fDSPCode) == null ? void 0 : _d.stop();
            break;
          }
          case "destroy": {
            this.fEventQueue.length = 0;
            this.port.close();
            this.destroy();
            break;
          }
          default:
            break;
        }
      };
      this.port.addEventListener("message", this.handleMessageAux);
      this.port.start();
      this.communicator = new FaustAudioWorkletProcessorCommunicator2(
        this.port
      );
      const { parameterDescriptors } = this.constructor;
      parameterDescriptors.forEach((pd) => {
        this.paramValuesCache[pd.name] = pd.defaultValue || 0;
      });
      const { factory, sampleSize } = options.processorOptions;
      this.dspInstance = FaustWasmInstantiator2.createSyncMonoDSPInstance(factory);
      this.sampleSize = sampleSize;
      this.soundfiles = factory.soundfiles;
      this.initFFT();
      const { moduleId, instanceId } = options.processorOptions;
      if (!moduleId || !instanceId) return;
      this.wamInfo = { moduleId, instanceId };
    }
    get fftProcessorBufferSize() {
      return this.fftSize / 2 + 1;
    }
    async initFFT() {
      this.FFT = await getFFT();
      await this.createFFTProcessor();
      return true;
    }
    static get parameterDescriptors() {
      const params = [];
      const callback = (item) => {
        const param = analyseParameters(item);
        if (param) params.push(param);
      };
      FaustBaseWebAudioDsp2.parseUI(dspMeta.ui, callback);
      return [
        ...params,
        {
          defaultValue: (fftOptions == null ? void 0 : fftOptions.fftSize) || 1024,
          maxValue: 2 ** 32,
          minValue: 2,
          name: "fftSize"
        },
        {
          defaultValue: (fftOptions == null ? void 0 : fftOptions.fftOverlap) || 2,
          maxValue: 32,
          minValue: 1,
          name: "fftOverlap"
        },
        {
          defaultValue: typeof (fftOptions == null ? void 0 : fftOptions.defaultWindowFunction) === "number" ? fftOptions.defaultWindowFunction + 1 : 0,
          maxValue: (windowFunctions == null ? void 0 : windowFunctions.length) || 0,
          minValue: 0,
          name: "windowFunction"
        },
        {
          defaultValue: +!!(fftOptions == null ? void 0 : fftOptions.noIFFT) || 0,
          maxValue: 1,
          minValue: 0,
          name: "noIFFT"
        }
      ];
    }
    setupWamEventHandler() {
      var _a;
      if (!this.wamInfo) return;
      const { moduleId, instanceId } = this.wamInfo;
      const { webAudioModules } = globalThis;
      const ModuleScope = webAudioModules.getModuleScope(
        moduleId
      );
      const paramMgrProcessor = (_a = ModuleScope == null ? void 0 : ModuleScope.paramMgrProcessors) == null ? void 0 : _a[instanceId];
      if (!paramMgrProcessor) return;
      if (paramMgrProcessor.handleEvent) return;
      paramMgrProcessor.handleEvent = (event) => {
        if (event.type === "wam-midi")
          this.atTime(
            event,
            () => this.midiMessage(event.data.bytes)
          );
      };
    }
    processFFT() {
      let samplesForFFT = mod(this.$inputWrite - this.$inputRead, this.fftBufferSize) || this.fftBufferSize;
      while (samplesForFFT >= this.fftSize) {
        let fftProcessorOutputs = [];
        this.fDSPCode.compute(
          (inputs) => {
            for (let i = 0; i < Math.min(
              this.fftInput.length,
              Math.ceil(inputs.length / 3)
            ); i++) {
              const ffted = this.rfft.forward((fftBuffer) => {
                setTypedArray(
                  fftBuffer,
                  this.fftInput[i],
                  0,
                  this.$inputRead
                );
                for (let j = 0; j < fftBuffer.length; j++) {
                  fftBuffer[j] *= this.window[j];
                }
              });
              fftToSignal(
                ffted,
                inputs[i * 3],
                inputs[i * 3 + 1],
                inputs[i * 3 + 2]
              );
            }
            for (let i = this.fftInput.length * 3; i < inputs.length; i++) {
              if (i % 3 === 2)
                inputs[i].forEach((v, j) => inputs[i][j] = j);
              else inputs[i].fill(0);
            }
          },
          (outputs) => {
            fftProcessorOutputs = outputs;
          }
        );
        this.$inputRead += this.fftHopSize;
        this.$inputRead %= this.fftBufferSize;
        samplesForFFT -= this.fftHopSize;
        for (let i = 0; i < this.fftOutput.length; i++) {
          let iffted;
          if (this.noIFFT) {
            iffted = this.noIFFTBuffer;
            signalToNoFFT(
              fftProcessorOutputs[i * 2] || this.fftProcessorZeros,
              fftProcessorOutputs[i * 2 + 1] || this.fftProcessorZeros,
              iffted
            );
          } else {
            iffted = this.rfft.inverse((ifftBuffer) => {
              signalToFFT(
                fftProcessorOutputs[i * 2] || this.fftProcessorZeros,
                fftProcessorOutputs[i * 2 + 1] || this.fftProcessorZeros,
                ifftBuffer
              );
            });
          }
          for (let j = 0; j < iffted.length; j++) {
            iffted[j] *= this.window[j];
          }
          let $;
          for (let j = 0; j < iffted.length - this.fftHopSize; j++) {
            $ = mod(this.$outputWrite + j, this.fftBufferSize);
            this.fftOutput[i][$] += iffted[j];
            if (i === 0)
              this.windowSumSquare[$] += this.noIFFT ? this.window[j] : this.window[j] ** 2;
          }
          for (let j = iffted.length - this.fftHopSize; j < iffted.length; j++) {
            $ = mod(this.$outputWrite + j, this.fftBufferSize);
            this.fftOutput[i][$] = iffted[j];
            if (i === 0)
              this.windowSumSquare[$] = this.noIFFT ? this.window[j] : this.window[j] ** 2;
          }
        }
        this.$outputWrite += this.fftHopSize;
        this.$outputWrite %= this.fftBufferSize;
      }
    }
    process(inputs, outputs, parameters) {
      if (this.destroyed) return false;
      if (!this.FFT) return true;
      const input = inputs[0];
      const output = outputs[0];
      const inputChannels = (input == null ? void 0 : input.length) || 0;
      const outputChannels = (output == null ? void 0 : output.length) || 0;
      const bufferSize = (input == null ? void 0 : input.length) ? Math.max(...input.map((c) => c.length)) || 128 : 128;
      this.noIFFT = !!parameters.noIFFT[0];
      this.resetFFT(
        ~~parameters.fftSize[0],
        ~~parameters.fftOverlap[0],
        ~~parameters.windowFunction[0],
        inputChannels,
        outputChannels,
        bufferSize
      );
      if (!this.fDSPCode) return true;
      this.applyDueEvents(audioClock.currentFrame);
      for (const path in parameters) {
        if (fftParamKeywords.find((k) => `/${path}`.endsWith(k)))
          continue;
        const [paramValue] = parameters[path];
        if (paramValue !== this.paramValuesCache[path]) {
          this.setParamValue(path, paramValue);
        }
      }
      if (this.communicator.getNewAccDataAvailable()) {
        const acc = this.communicator.getAcc();
        if (acc) {
          this.communicator.setNewAccDataAvailable(false);
          const { invert, ...data } = acc;
          this.propagateAcc(data, invert);
        }
      }
      if (this.communicator.getNewGyrDataAvailable()) {
        const gyr = this.communicator.getGyr();
        if (gyr) {
          this.communicator.setNewGyrDataAvailable(false);
          this.propagateGyr(gyr);
        }
      }
      if (input == null ? void 0 : input.length) {
        let $inputWrite = 0;
        for (let i = 0; i < input.length; i++) {
          const inputWindow = this.fftInput[i];
          const channel = input[i].length ? input[i] : new Float32Array(bufferSize);
          $inputWrite = setTypedArray(
            inputWindow,
            channel,
            this.$inputWrite
          );
        }
        this.$inputWrite = $inputWrite;
      } else {
        this.$inputWrite += bufferSize;
        this.$inputWrite %= this.fftBufferSize;
      }
      this.processFFT();
      for (let i = 0; i < output.length; i++) {
        setTypedArray(
          output[i],
          this.fftOutput[i],
          0,
          this.$outputRead
        );
        let div = 0;
        for (let j = 0; j < bufferSize; j++) {
          div = this.windowSumSquare[mod(this.$outputRead + j, this.fftBufferSize)];
          output[i][j] /= div < 1e-8 ? 1 : div;
        }
      }
      this.$outputRead += bufferSize;
      this.$outputRead %= this.fftBufferSize;
      if (this.fPlotHandler) {
        this.port.postMessage({
          type: "plot",
          value: output,
          index: this.fBufferNum++,
          events: this.fCachedEvents
        });
        this.fCachedEvents = [];
      }
      return true;
    }
    /**
     * Read a message's timestamp as a whole frame on the audio clock.
     * Null if it carries none, meaning now.
     *
     * Rounded, and non-finite values rejected: a NaN compares false
     * against every frame and would block the queue behind it.
     */
    messageFrame(msg) {
      const frame = Number.isFinite(msg.frame) ? msg.frame : Number.isFinite(msg.time) ? msg.time * sampleRate : null;
      return frame === null ? null : Math.round(frame);
    }
    /**
     * Apply `apply` now, or at the top of the block containing the frame
     * the sender asked for.
     *
     * Queued ones catch: a throw would otherwise escape `process`, and the
     * spec's response is to stop calling the node permanently.
     */
    atTime(msg, apply2) {
      const frame = this.messageFrame(msg);
      if (frame === null) {
        apply2();
        return;
      }
      const guarded = () => {
        try {
          apply2();
        } catch (error) {
          console.error(
            `Faust: a message timed for frame ${frame} threw and was dropped`,
            error
          );
        }
      };
      let i = this.fEventQueue.length;
      while (i > 0 && this.fEventQueue[i - 1].frame > frame) i--;
      this.fEventQueue.splice(i, 0, { frame, apply: guarded });
    }
    /** Apply everything due by the end of the block starting at `start`. */
    applyDueEvents(start) {
      const end = start + kBlockSize;
      while (this.fEventQueue.length && this.fEventQueue[0].frame < end) {
        this.fEventQueue.shift().apply();
      }
    }
    setParamValue(path, value) {
      var _a;
      (_a = this.fDSPCode) == null ? void 0 : _a.setParamValue(path, value);
      this.paramValuesCache[path] = value;
    }
    midiMessage(data) {
      var _a;
      (_a = this.fDSPCode) == null ? void 0 : _a.midiMessage(data);
    }
    ctrlChange(channel, ctrl, value) {
      var _a;
      (_a = this.fDSPCode) == null ? void 0 : _a.ctrlChange(channel, ctrl, value);
    }
    pitchWheel(channel, wheel) {
      var _a;
      (_a = this.fDSPCode) == null ? void 0 : _a.pitchWheel(channel, wheel);
    }
    propagateAcc(accelerationIncludingGravity, invert = false) {
      this.fDSPCode.propagateAcc(accelerationIncludingGravity, invert);
    }
    propagateGyr(event) {
      this.fDSPCode.propagateGyr(event);
    }
    resetFFT(sizeIn, overlapIn, windowFunctionIn, inputChannels, outputChannels, bufferSize) {
      var _a, _b;
      const fftSize = ~~ceil(Math.max(2, sizeIn || 1024), 2);
      const fftOverlap = ~~Math.min(fftSize, Math.max(1, overlapIn));
      const fftHopSize = ~~Math.max(1, fftSize / fftOverlap);
      const latency = fftSize - Math.min(fftHopSize, bufferSize);
      let windowFunction = null;
      if (windowFunctionIn !== 0) {
        windowFunction = typeof windowFunctions === "object" ? windowFunctions[~~windowFunctionIn - 1] || null : null;
      }
      const fftSizeChanged = fftSize !== this.fftSize;
      const fftOverlapChanged = fftOverlap !== this.fftOverlap;
      if (fftSizeChanged || fftOverlapChanged) {
        this.fftSize = fftSize;
        this.fftOverlap = fftOverlap;
        this.fftHopSize = fftHopSize;
        this.$inputWrite = 0;
        this.$inputRead = 0;
        this.$outputWrite = 0;
        this.$outputRead = -latency;
        this.fftBufferSize = Math.max(
          fftSize * 2 - this.fftHopSize,
          bufferSize * 2
        );
        if (!fftSizeChanged && this.fftHopSizeParam)
          (_a = this.fDSPCode) == null ? void 0 : _a.setParamValue(
            this.fftHopSizeParam,
            this.fftHopSize
          );
      }
      if (fftSizeChanged) {
        (_b = this.rfft) == null ? void 0 : _b.dispose();
        this.rfft = new this.FFT(fftSize);
        this.noIFFTBuffer = new Float32Array(this.fftSize);
        this.createFFTProcessor();
      }
      if (fftSizeChanged || fftOverlapChanged || windowFunction !== this.windowFunction) {
        this.windowFunction = windowFunction;
        this.window = new Float32Array(fftSize);
        this.window.fill(1);
        if (windowFunction) apply(this.window, windowFunction);
        this.windowSumSquare = new Float32Array(this.fftBufferSize);
      }
      if (this.fftInput.length > inputChannels) {
        this.fftInput.splice(inputChannels);
      }
      if (this.fftOutput.length > outputChannels) {
        this.fftOutput.splice(outputChannels);
      }
      if (fftSizeChanged || fftOverlapChanged) {
        for (let i = 0; i < inputChannels; i++) {
          this.fftInput[i] = new Float32Array(this.fftBufferSize);
        }
        for (let i = 0; i < outputChannels; i++) {
          this.fftOutput[i] = new Float32Array(this.fftBufferSize);
        }
      } else {
        if (this.fftInput.length < inputChannels) {
          for (let i = this.fftInput.length; i < inputChannels; i++) {
            this.fftInput[i] = new Float32Array(this.fftBufferSize);
          }
        }
        if (this.fftOutput.length < outputChannels) {
          for (let i = this.fftOutput.length; i < outputChannels; i++) {
            this.fftOutput[i] = new Float32Array(
              this.fftBufferSize
            );
          }
        }
      }
    }
    async createFFTProcessor() {
      var _a, _b;
      (_a = this.fDSPCode) == null ? void 0 : _a.stop();
      (_b = this.fDSPCode) == null ? void 0 : _b.destroy();
      this.fDSPCode = new FaustMonoWebAudioDsp2(
        this.dspInstance,
        sampleRate,
        this.sampleSize,
        this.fftProcessorBufferSize,
        this.soundfiles
      );
      this.fDSPCode.setOutputParamHandler(
        (path, value) => this.port.postMessage({ path, value, type: "out-param" })
      );
      this.fDSPCode.setInputParamHandler(
        (path, value) => this.port.postMessage({ path, value, type: "in-param" })
      );
      this.fDSPCode.setNonFiniteHandler(this.fNonFiniteHandler);
      this.fDSPCode.setPlotHandler(this.fPlotHandler);
      const params = this.fDSPCode.getParams();
      this.fDSPCode.start();
      for (const path in this.paramValuesCache) {
        if (fftParamKeywords.find((k) => `/${path}`.endsWith(k)))
          continue;
        this.fDSPCode.setParamValue(path, this.paramValuesCache[path]);
      }
      const fftSizeParam = params.find((s) => s.endsWith("/fftSize"));
      if (fftSizeParam)
        this.fDSPCode.setParamValue(fftSizeParam, this.fftSize);
      this.fftHopSizeParam = params.find(
        (s) => s.endsWith("/fftHopSize")
      );
      if (this.fftHopSizeParam)
        this.fDSPCode.setParamValue(
          this.fftHopSizeParam,
          this.fftHopSize
        );
      this.fftProcessorZeros = new Float32Array(
        this.fftProcessorBufferSize
      );
    }
    destroy() {
      var _a, _b, _c;
      (_a = this.fDSPCode) == null ? void 0 : _a.stop();
      (_b = this.fDSPCode) == null ? void 0 : _b.destroy();
      (_c = this.rfft) == null ? void 0 : _c.dispose();
      this.destroyed = true;
    }
  }
  const Processor = FaustFFTAudioWorkletProcessor;
  if (register) {
    const name = processorName || dspName || "myfftdsp";
    const scope = globalThis;
    if (!scope.__faustRegisteredProcessors) {
      scope.__faustRegisteredProcessors = /* @__PURE__ */ new Set();
    }
    if (!scope.__faustRegisteredProcessors.has(name)) {
      registerProcessor(name, Processor);
      scope.__faustRegisteredProcessors.add(name);
    }
  }
  return FaustFFTAudioWorkletProcessor;
};
var FaustFFTAudioWorkletProcessor_default = getFaustFFTAudioWorkletProcessor;

// node_modules/tslib/tslib.es6.mjs
function __awaiter(thisArg, _arguments, P, generator) {
  function adopt(value) {
    return value instanceof P ? value : new P(function(resolve) {
      resolve(value);
    });
  }
  return new (P || (P = Promise))(function(resolve, reject) {
    function fulfilled(value) {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    }
    function rejected(value) {
      try {
        step(generator["throw"](value));
      } catch (e) {
        reject(e);
      }
    }
    function step(result) {
      result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
    }
    step((generator = generator.apply(thisArg, _arguments || [])).next());
  });
}
function __generator(thisArg, body) {
  var _ = { label: 0, sent: function() {
    if (t[0] & 1) throw t[1];
    return t[1];
  }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
  return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() {
    return this;
  }), g;
  function verb(n) {
    return function(v) {
      return step([n, v]);
    };
  }
  function step(op) {
    if (f) throw new TypeError("Generator is already executing.");
    while (g && (g = 0, op[0] && (_ = 0)), _) try {
      if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
      if (y = 0, t) op = [op[0] & 2, t.value];
      switch (op[0]) {
        case 0:
        case 1:
          t = op;
          break;
        case 4:
          _.label++;
          return { value: op[1], done: false };
        case 5:
          _.label++;
          y = op[1];
          op = [0];
          continue;
        case 7:
          op = _.ops.pop();
          _.trys.pop();
          continue;
        default:
          if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
            _ = 0;
            continue;
          }
          if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
            _.label = op[1];
            break;
          }
          if (op[0] === 6 && _.label < t[1]) {
            _.label = t[1];
            t = op;
            break;
          }
          if (t && _.label < t[2]) {
            _.label = t[2];
            _.ops.push(op);
            break;
          }
          if (t[2]) _.ops.pop();
          _.trys.pop();
          continue;
      }
      op = body.call(thisArg, _);
    } catch (e) {
      op = [6, e];
      y = 0;
    } finally {
      f = t = 0;
    }
    if (op[0] & 5) throw op[1];
    return { value: op[0] ? op[1] : void 0, done: true };
  }
}

// node_modules/@aws-crypto/sha256-js/build/module/constants.js
var BLOCK_SIZE = 64;
var DIGEST_LENGTH = 32;
var KEY = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var INIT = [
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
];
var MAX_HASHABLE_LENGTH = Math.pow(2, 53) - 1;

// node_modules/@aws-crypto/sha256-js/build/module/RawSha256.js
var RawSha256 = (
  /** @class */
  (function() {
    function RawSha2562() {
      this.state = Int32Array.from(INIT);
      this.temp = new Int32Array(64);
      this.buffer = new Uint8Array(64);
      this.bufferLength = 0;
      this.bytesHashed = 0;
      this.finished = false;
    }
    RawSha2562.prototype.update = function(data) {
      if (this.finished) {
        throw new Error("Attempted to update an already finished hash.");
      }
      var position = 0;
      var byteLength = data.byteLength;
      this.bytesHashed += byteLength;
      if (this.bytesHashed * 8 > MAX_HASHABLE_LENGTH) {
        throw new Error("Cannot hash more than 2^53 - 1 bits");
      }
      while (byteLength > 0) {
        this.buffer[this.bufferLength++] = data[position++];
        byteLength--;
        if (this.bufferLength === BLOCK_SIZE) {
          this.hashBuffer();
          this.bufferLength = 0;
        }
      }
    };
    RawSha2562.prototype.digest = function() {
      if (!this.finished) {
        var bitsHashed = this.bytesHashed * 8;
        var bufferView = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
        var undecoratedLength = this.bufferLength;
        bufferView.setUint8(this.bufferLength++, 128);
        if (undecoratedLength % BLOCK_SIZE >= BLOCK_SIZE - 8) {
          for (var i = this.bufferLength; i < BLOCK_SIZE; i++) {
            bufferView.setUint8(i, 0);
          }
          this.hashBuffer();
          this.bufferLength = 0;
        }
        for (var i = this.bufferLength; i < BLOCK_SIZE - 8; i++) {
          bufferView.setUint8(i, 0);
        }
        bufferView.setUint32(BLOCK_SIZE - 8, Math.floor(bitsHashed / 4294967296), true);
        bufferView.setUint32(BLOCK_SIZE - 4, bitsHashed);
        this.hashBuffer();
        this.finished = true;
      }
      var out = new Uint8Array(DIGEST_LENGTH);
      for (var i = 0; i < 8; i++) {
        out[i * 4] = this.state[i] >>> 24 & 255;
        out[i * 4 + 1] = this.state[i] >>> 16 & 255;
        out[i * 4 + 2] = this.state[i] >>> 8 & 255;
        out[i * 4 + 3] = this.state[i] >>> 0 & 255;
      }
      return out;
    };
    RawSha2562.prototype.hashBuffer = function() {
      var _a = this, buffer = _a.buffer, state = _a.state;
      var state0 = state[0], state1 = state[1], state2 = state[2], state3 = state[3], state4 = state[4], state5 = state[5], state6 = state[6], state7 = state[7];
      for (var i = 0; i < BLOCK_SIZE; i++) {
        if (i < 16) {
          this.temp[i] = (buffer[i * 4] & 255) << 24 | (buffer[i * 4 + 1] & 255) << 16 | (buffer[i * 4 + 2] & 255) << 8 | buffer[i * 4 + 3] & 255;
        } else {
          var u = this.temp[i - 2];
          var t1_1 = (u >>> 17 | u << 15) ^ (u >>> 19 | u << 13) ^ u >>> 10;
          u = this.temp[i - 15];
          var t2_1 = (u >>> 7 | u << 25) ^ (u >>> 18 | u << 14) ^ u >>> 3;
          this.temp[i] = (t1_1 + this.temp[i - 7] | 0) + (t2_1 + this.temp[i - 16] | 0);
        }
        var t1 = (((state4 >>> 6 | state4 << 26) ^ (state4 >>> 11 | state4 << 21) ^ (state4 >>> 25 | state4 << 7)) + (state4 & state5 ^ ~state4 & state6) | 0) + (state7 + (KEY[i] + this.temp[i] | 0) | 0) | 0;
        var t2 = ((state0 >>> 2 | state0 << 30) ^ (state0 >>> 13 | state0 << 19) ^ (state0 >>> 22 | state0 << 10)) + (state0 & state1 ^ state0 & state2 ^ state1 & state2) | 0;
        state7 = state6;
        state6 = state5;
        state5 = state4;
        state4 = state3 + t1 | 0;
        state3 = state2;
        state2 = state1;
        state1 = state0;
        state0 = t1 + t2 | 0;
      }
      state[0] += state0;
      state[1] += state1;
      state[2] += state2;
      state[3] += state3;
      state[4] += state4;
      state[5] += state5;
      state[6] += state6;
      state[7] += state7;
    };
    return RawSha2562;
  })()
);

// node_modules/@smithy/util-utf8/dist-es/fromUtf8.browser.js
var fromUtf8 = (input) => new TextEncoder().encode(input);

// node_modules/@aws-crypto/util/build/module/convertToBuffer.js
var fromUtf82 = typeof Buffer !== "undefined" && Buffer.from ? function(input) {
  return Buffer.from(input, "utf8");
} : fromUtf8;
function convertToBuffer(data) {
  if (data instanceof Uint8Array)
    return data;
  if (typeof data === "string") {
    return fromUtf82(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength / Uint8Array.BYTES_PER_ELEMENT);
  }
  return new Uint8Array(data);
}

// node_modules/@aws-crypto/util/build/module/isEmptyData.js
function isEmptyData(data) {
  if (typeof data === "string") {
    return data.length === 0;
  }
  return data.byteLength === 0;
}

// node_modules/@aws-crypto/sha256-js/build/module/jsSha256.js
var Sha256 = (
  /** @class */
  (function() {
    function Sha2562(secret) {
      this.secret = secret;
      this.hash = new RawSha256();
      this.reset();
    }
    Sha2562.prototype.update = function(toHash) {
      if (isEmptyData(toHash) || this.error) {
        return;
      }
      try {
        this.hash.update(convertToBuffer(toHash));
      } catch (e) {
        this.error = e;
      }
    };
    Sha2562.prototype.digestSync = function() {
      if (this.error) {
        throw this.error;
      }
      if (this.outer) {
        if (!this.outer.finished) {
          this.outer.update(this.hash.digest());
        }
        return this.outer.digest();
      }
      return this.hash.digest();
    };
    Sha2562.prototype.digest = function() {
      return __awaiter(this, void 0, void 0, function() {
        return __generator(this, function(_a) {
          return [2, this.digestSync()];
        });
      });
    };
    Sha2562.prototype.reset = function() {
      this.hash = new RawSha256();
      if (this.secret) {
        this.outer = new RawSha256();
        var inner = bufferFromSecret(this.secret);
        var outer = new Uint8Array(BLOCK_SIZE);
        outer.set(inner);
        for (var i = 0; i < BLOCK_SIZE; i++) {
          inner[i] ^= 54;
          outer[i] ^= 92;
        }
        this.hash.update(inner);
        this.outer.update(outer);
        for (var i = 0; i < inner.byteLength; i++) {
          inner[i] = 0;
        }
      }
    };
    return Sha2562;
  })()
);
function bufferFromSecret(secret) {
  var input = convertToBuffer(secret);
  if (input.byteLength > BLOCK_SIZE) {
    var bufferHash = new RawSha256();
    bufferHash.update(input);
    input = bufferHash.digest();
  }
  var buffer = new Uint8Array(BLOCK_SIZE);
  buffer.set(input);
  return buffer;
}

// src/FaustCompiler.ts
var ab2str = (buf) => String.fromCharCode.apply(null, Array.from(buf));
var str2ab = (str) => {
  const buf = new ArrayBuffer(str.length);
  const bufView = new Uint8Array(buf);
  for (let i = 0, strLen = str.length; i < strLen; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return bufView;
};
var sha256 = async (str) => {
  const sha2562 = new Sha256();
  sha2562.update(str);
  const hashArray = Array.from(await sha2562.digest());
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
};
var _FaustCompiler = class _FaustCompiler {
  /**
   * Get a stringified DSP factories table
   */
  static serializeDSPFactories() {
    const table = {};
    this.gFactories.forEach((factory, shaKey) => {
      const { code, json, poly } = factory;
      table[shaKey] = {
        code: btoa(ab2str(code)),
        json: JSON.parse(json),
        poly
      };
    });
    return table;
  }
  /**
   * Get a stringified DSP factories table as string
   */
  static stringifyDSPFactories() {
    return JSON.stringify(this.serializeDSPFactories());
  }
  /**
   * Import a DSP factories table
   */
  static deserializeDSPFactories(table) {
    const awaited = [];
    for (const shaKey in table) {
      const factory = table[shaKey];
      const { code, json, poly } = factory;
      const ab = str2ab(atob(code));
      awaited.push(
        WebAssembly.compile(ab).then(
          (module) => this.gFactories.set(shaKey, {
            shaKey,
            cfactory: 0,
            code: ab,
            module,
            json: JSON.stringify(json),
            poly,
            soundfiles: {}
          })
        )
      );
    }
    return Promise.all(awaited);
  }
  /**
   * Import a stringified DSP factories table
   */
  static importDSPFactories(tableStr) {
    const table = JSON.parse(tableStr);
    return this.deserializeDSPFactories(table);
  }
  constructor(libFaust) {
    this.fLibFaust = libFaust;
    this.fErrorMessage = "";
  }
  intVec2intArray(vec) {
    const size = vec.size();
    const ui8Code = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      ui8Code[i] = vec.get(i);
    }
    return ui8Code;
  }
  async createDSPFactory(name, code, args, poly) {
    if (_FaustCompiler.gFactories.size > 10) {
      _FaustCompiler.gFactories.clear();
    }
    const shaKey = await sha256(JSON.stringify([name, code, args, poly]));
    if (_FaustCompiler.gFactories.has(shaKey)) {
      return _FaustCompiler.gFactories.get(shaKey) || null;
    } else {
      try {
        const faustDspWasm = this.fLibFaust.createDSPFactory(
          name,
          code,
          args,
          !poly
        );
        const ui8Code = this.intVec2intArray(faustDspWasm.data);
        faustDspWasm.data.delete();
        const module = await WebAssembly.compile(ui8Code);
        const factory = {
          shaKey,
          cfactory: faustDspWasm.cfactory,
          code: ui8Code,
          module,
          json: faustDspWasm.json,
          poly,
          soundfiles: {}
        };
        this.deleteDSPFactory(factory);
        _FaustCompiler.gFactories.set(shaKey, factory);
        return factory;
      } catch (e) {
        this.fErrorMessage = this.fLibFaust.getErrorAfterException();
        this.fLibFaust.cleanupAfterException();
        throw this.fErrorMessage ? new Error(this.fErrorMessage) : e;
      }
    }
  }
  version() {
    return this.fLibFaust.version();
  }
  getErrorMessage() {
    return this.fErrorMessage;
  }
  async createMonoDSPFactory(name, code, args) {
    return this.createDSPFactory(name, code, args, false);
  }
  async createPolyDSPFactory(name, code, args) {
    return this.createDSPFactory(name, code, args, true);
  }
  deleteDSPFactory(factory) {
    this.fLibFaust.deleteDSPFactory(factory.cfactory);
    factory.cfactory = 0;
  }
  expandDSP(code, args) {
    try {
      return this.fLibFaust.expandDSP("FaustDSP", code, args);
    } catch (e) {
      this.fErrorMessage = this.fLibFaust.getErrorAfterException();
      this.fLibFaust.cleanupAfterException();
      throw this.fErrorMessage ? new Error(this.fErrorMessage) : e;
    }
  }
  generateAuxFiles(name, code, args) {
    try {
      return this.fLibFaust.generateAuxFiles(name, code, args);
    } catch (e) {
      this.fErrorMessage = this.fLibFaust.getErrorAfterException();
      this.fLibFaust.cleanupAfterException();
      throw this.fErrorMessage ? new Error(this.fErrorMessage) : e;
    }
  }
  deleteAllDSPFactories() {
    this.fLibFaust.deleteAllDSPFactories();
  }
  fs() {
    return this.fLibFaust.fs();
  }
  async getAsyncInternalMixerModule(isDouble = false) {
    const bufferKey = isDouble ? "mixer64Buffer" : "mixer32Buffer";
    const moduleKey = isDouble ? "mixer64Module" : "mixer32Module";
    if (this[moduleKey])
      return {
        mixerBuffer: this[bufferKey],
        mixerModule: this[moduleKey]
      };
    const path = isDouble ? "/usr/rsrc/mixer64.wasm" : "/usr/rsrc/mixer32.wasm";
    const mixerBuffer = this.fs().readFile(path, { encoding: "binary" });
    this[bufferKey] = mixerBuffer;
    const mixerModule = await WebAssembly.compile(
      new Uint8Array(mixerBuffer)
    );
    this[moduleKey] = mixerModule;
    return { mixerBuffer, mixerModule };
  }
  getSyncInternalMixerModule(isDouble = false) {
    const bufferKey = isDouble ? "mixer64Buffer" : "mixer32Buffer";
    const moduleKey = isDouble ? "mixer64Module" : "mixer32Module";
    if (this[moduleKey])
      return {
        mixerBuffer: this[bufferKey],
        mixerModule: this[moduleKey]
      };
    const path = isDouble ? "/usr/rsrc/mixer64.wasm" : "/usr/rsrc/mixer32.wasm";
    const mixerBuffer = this.fs().readFile(path, { encoding: "binary" });
    this[bufferKey] = mixerBuffer;
    const mixerModule = new WebAssembly.Module(new Uint8Array(mixerBuffer));
    this[moduleKey] = mixerModule;
    return { mixerBuffer, mixerModule };
  }
};
_FaustCompiler.gFactories = /* @__PURE__ */ new Map();
var FaustCompiler = _FaustCompiler;
var FaustCompiler_default = FaustCompiler;

// src/FaustDspInstance.ts
var FaustDspInstance = class {
  constructor(exports) {
    this.fExports = exports;
  }
  compute($dsp, count, $input, $output) {
    this.fExports.compute($dsp, count, $input, $output);
  }
  getNumInputs($dsp) {
    return this.fExports.getNumInputs($dsp);
  }
  getNumOutputs($dsp) {
    return this.fExports.getNumOutputs($dsp);
  }
  getParamValue($dsp, index) {
    return this.fExports.getParamValue($dsp, index);
  }
  getSampleRate($dsp) {
    return this.fExports.getSampleRate($dsp);
  }
  init($dsp, sampleRate) {
    this.fExports.init($dsp, sampleRate);
  }
  instanceClear($dsp) {
    this.fExports.instanceClear($dsp);
  }
  instanceConstants($dsp, sampleRate) {
    this.fExports.instanceConstants($dsp, sampleRate);
  }
  instanceInit($dsp, sampleRate) {
    this.fExports.instanceInit($dsp, sampleRate);
  }
  instanceResetUserInterface($dsp) {
    this.fExports.instanceResetUserInterface($dsp);
  }
  setParamValue($dsp, index, value) {
    this.fExports.setParamValue($dsp, index, value);
  }
};

// src/FaustWasmInstantiator.ts
var FaustWasmInstantiator = class {
  static createWasmImport(memory) {
    return {
      env: {
        memory: memory || new WebAssembly.Memory({ initial: 100 }),
        memoryBase: 0,
        tableBase: 0,
        // Integer version
        _abs: Math.abs,
        // Float version
        _acosf: Math.acos,
        _asinf: Math.asin,
        _atanf: Math.atan,
        _atan2f: Math.atan2,
        _ceilf: Math.ceil,
        _cosf: Math.cos,
        _expf: Math.exp,
        _floorf: Math.floor,
        _fmodf: (x, y) => x % y,
        _logf: Math.log,
        _log10f: Math.log10,
        _max_f: Math.max,
        _min_f: Math.min,
        _remainderf: (x, y) => x - Math.round(x / y) * y,
        _powf: Math.pow,
        _roundf: Math.round,
        _sinf: Math.sin,
        _sqrtf: Math.sqrt,
        _tanf: Math.tan,
        _acoshf: Math.acosh,
        _asinhf: Math.asinh,
        _atanhf: Math.atanh,
        _coshf: Math.cosh,
        _sinhf: Math.sinh,
        _tanhf: Math.tanh,
        _isnanf: Number.isNaN,
        _isinff: (x) => !isFinite(x),
        _copysignf: (x, y) => Math.sign(x) === Math.sign(y) ? x : -x,
        // Double version
        _acos: Math.acos,
        _asin: Math.asin,
        _atan: Math.atan,
        _atan2: Math.atan2,
        _ceil: Math.ceil,
        _cos: Math.cos,
        _exp: Math.exp,
        _floor: Math.floor,
        _fmod: (x, y) => x % y,
        _log: Math.log,
        _log10: Math.log10,
        _max_: Math.max,
        _min_: Math.min,
        _remainder: (x, y) => x - Math.round(x / y) * y,
        _pow: Math.pow,
        _round: Math.round,
        _sin: Math.sin,
        _sqrt: Math.sqrt,
        _tan: Math.tan,
        _acosh: Math.acosh,
        _asinh: Math.asinh,
        _atanh: Math.atanh,
        _cosh: Math.cosh,
        _sinh: Math.sinh,
        _tanh: Math.tanh,
        _isnan: Number.isNaN,
        _isinf: (x) => !isFinite(x),
        _copysign: (x, y) => Math.sign(x) === Math.sign(y) ? x : -x,
        table: new WebAssembly.Table({ initial: 0, element: "anyfunc" })
      }
    };
  }
  static createWasmMemoryPoly(voicesIn, sampleSize, dspMeta, effectMeta, bufferSize) {
    const voices = Math.max(4, voicesIn);
    const ptrSize = sampleSize;
    const pow2limit = (x) => {
      let n = 65536;
      while (n < x) {
        n *= 2;
      }
      return n;
    };
    const effectSize = effectMeta ? effectMeta.size : 0;
    let memorySize = pow2limit(
      effectSize + dspMeta.size * voices + (dspMeta.inputs + dspMeta.outputs * 2) * // + 2 for effect
      (ptrSize + bufferSize * sampleSize)
    ) / 65536;
    memorySize = Math.max(2, memorySize);
    return new WebAssembly.Memory({ initial: memorySize });
  }
  static createWasmMemoryMono(sampleSize, dspMeta, bufferSize) {
    const ptrSize = sampleSize;
    const memorySize = (dspMeta.size + (dspMeta.inputs + dspMeta.outputs) * (ptrSize + bufferSize * sampleSize)) / 65536;
    return new WebAssembly.Memory({ initial: memorySize * 2 });
  }
  static createMonoDSPInstanceAux(instance, json, mem = null) {
    const functions = instance.exports;
    const api = new FaustDspInstance(functions);
    const memory = mem ? mem : instance.exports.memory;
    return { memory, api, json };
  }
  static createMemoryMono(monoFactory) {
    const monoMeta = JSON.parse(monoFactory.json);
    const sampleSize = monoMeta.compile_options.match("-double") ? 8 : 4;
    return this.createWasmMemoryMono(sampleSize, monoMeta, 8192);
  }
  static createMemoryPoly(voices, voiceFactory, effectFactory) {
    const voiceMeta = JSON.parse(voiceFactory.json);
    const effectMeta = effectFactory && effectFactory.json ? JSON.parse(effectFactory.json) : null;
    const sampleSize = voiceMeta.compile_options.match("-double") ? 8 : 4;
    return this.createWasmMemoryPoly(
      voices,
      sampleSize,
      voiceMeta,
      effectMeta,
      8192
    );
  }
  static createMixerAux(mixerModule, memory) {
    const mixerImport = {
      imports: { print: console.log },
      memory: { memory }
    };
    const mixerInstance = new WebAssembly.Instance(
      mixerModule,
      mixerImport
    );
    const mixerFunctions = mixerInstance.exports;
    return mixerFunctions;
  }
  // Public API
  static async loadDSPFactory(wasmPath, jsonPath) {
    const wasmFile = await fetch(wasmPath);
    if (!wasmFile.ok) {
      throw new Error(
        `=> exception raised while running loadDSPFactory, file not found: ${wasmPath}`
      );
    }
    const wasmBuffer = await wasmFile.arrayBuffer();
    const module = await WebAssembly.compile(wasmBuffer);
    const jsonFile = await fetch(jsonPath);
    const json = await jsonFile.text();
    const meta = JSON.parse(json);
    const cOptions = meta.compile_options;
    const poly = cOptions.indexOf("wasm-e") !== -1;
    return {
      cfactory: 0,
      code: new Uint8Array(wasmBuffer),
      module,
      json,
      poly
    };
  }
  static async loadDSPMixer(mixerPath, fs) {
    let mixerBuffer = null;
    if (fs) {
      mixerBuffer = new Uint8Array(
        fs.readFile(mixerPath, { encoding: "binary" })
      );
    } else {
      const mixerFile = await fetch(mixerPath);
      mixerBuffer = await mixerFile.arrayBuffer();
    }
    return WebAssembly.compile(mixerBuffer);
  }
  static async createAsyncMonoDSPInstance(factory) {
    const pattern = /"type":\s*"soundfile"/;
    const isDetected = pattern.test(factory.json);
    if (isDetected) {
      const memory = this.createMemoryMono(factory);
      const instance = await WebAssembly.instantiate(
        factory.module,
        this.createWasmImport(memory)
      );
      return this.createMonoDSPInstanceAux(
        instance,
        factory.json,
        memory
      );
    } else {
      const instance = await WebAssembly.instantiate(
        factory.module,
        this.createWasmImport()
      );
      return this.createMonoDSPInstanceAux(instance, factory.json);
    }
  }
  static createSyncMonoDSPInstance(factory) {
    const pattern = /"type":\s*"soundfile"/;
    const isDetected = pattern.test(factory.json);
    if (isDetected) {
      const memory = this.createMemoryMono(factory);
      const instance = new WebAssembly.Instance(
        factory.module,
        this.createWasmImport(memory)
      );
      return this.createMonoDSPInstanceAux(
        instance,
        factory.json,
        memory
      );
    } else {
      const instance = new WebAssembly.Instance(
        factory.module,
        this.createWasmImport()
      );
      return this.createMonoDSPInstanceAux(instance, factory.json);
    }
  }
  static async createAsyncPolyDSPInstance(voiceFactory, mixerModule, voices, effectFactory) {
    const memory = this.createMemoryPoly(
      voices,
      voiceFactory,
      effectFactory
    );
    const voiceInstance = await WebAssembly.instantiate(
      voiceFactory.module,
      this.createWasmImport(memory)
    );
    const voiceFunctions = voiceInstance.exports;
    const voiceAPI = new FaustDspInstance(voiceFunctions);
    const mixerAPI = this.createMixerAux(mixerModule, memory);
    if (effectFactory) {
      const effectInstance = await WebAssembly.instantiate(
        effectFactory.module,
        this.createWasmImport(memory)
      );
      const effectFunctions = effectInstance.exports;
      const effectAPI = new FaustDspInstance(effectFunctions);
      return {
        memory,
        voices,
        voiceAPI,
        effectAPI,
        mixerAPI,
        voiceJSON: voiceFactory.json,
        effectJSON: effectFactory.json
      };
    } else {
      return {
        memory,
        voices,
        voiceAPI,
        mixerAPI,
        voiceJSON: voiceFactory.json
      };
    }
  }
  static createSyncPolyDSPInstance(voiceFactory, mixerModule, voices, effectFactory) {
    const memory = this.createMemoryPoly(
      voices,
      voiceFactory,
      effectFactory
    );
    const voiceInstance = new WebAssembly.Instance(
      voiceFactory.module,
      this.createWasmImport(memory)
    );
    const voiceFunctions = voiceInstance.exports;
    const voiceAPI = new FaustDspInstance(voiceFunctions);
    const mixerAPI = this.createMixerAux(mixerModule, memory);
    if (effectFactory) {
      const effectInstance = new WebAssembly.Instance(
        effectFactory.module,
        this.createWasmImport(memory)
      );
      const effectFunctions = effectInstance.exports;
      const effectAPI = new FaustDspInstance(effectFunctions);
      return {
        memory,
        voices,
        voiceAPI,
        effectAPI,
        mixerAPI,
        voiceJSON: voiceFactory.json,
        effectJSON: effectFactory.json
      };
    } else {
      return {
        memory,
        voices,
        voiceAPI,
        mixerAPI,
        voiceJSON: voiceFactory.json
      };
    }
  }
};
var FaustWasmInstantiator_default = FaustWasmInstantiator;

// src/FaustSensors.ts
var FaustSensors = class _FaustSensors {
  /**
   * Function to convert a number to an axis type
   *
   * @param value number
   * @returns axis type
   */
  static convertToAxis(value) {
    switch (value) {
      case 0:
        return 0 /* x */;
      case 1:
        return 1 /* y */;
      case 2:
        return 2 /* z */;
      default:
        console.error("Error: Axis not found value: " + value);
        return 0 /* x */;
    }
  }
  /**
   * Function to convert a number to a curve type
   *
   * @param value number
   * @returns curve type
   */
  static convertToCurve(value) {
    switch (value) {
      case 0:
        return 0 /* Up */;
      case 1:
        return 1 /* Down */;
      case 2:
        return 2 /* UpDown */;
      case 3:
        return 3 /* DownUp */;
      default:
        console.error("Error: Curve not found value: " + value);
        return 0 /* Up */;
    }
  }
  static get Range() {
    if (!this._Range) {
      this._Range = class {
        constructor(x, y) {
          this.fLo = Math.min(x, y);
          this.fHi = Math.max(x, y);
        }
        clip(x) {
          if (x < this.fLo) return this.fLo;
          if (x > this.fHi) return this.fHi;
          return x;
        }
      };
    }
    return this._Range;
  }
  /**
   * Interpolator class
   */
  static get Interpolator() {
    if (!this._Interpolator) {
      this._Interpolator = class {
        constructor(lo, hi, v1, v2) {
          this.fRange = new _FaustSensors.Range(lo, hi);
          if (hi !== lo) {
            this.fCoef = (v2 - v1) / (hi - lo);
            this.fOffset = v1 - lo * this.fCoef;
          } else {
            this.fCoef = 0;
            this.fOffset = (v1 + v2) / 2;
          }
        }
        returnMappedValue(v) {
          const x = this.fRange.clip(v);
          return this.fOffset + x * this.fCoef;
        }
        getLowHigh(amin, amax) {
          return { amin: this.fRange.fLo, amax: this.fRange.fHi };
        }
      };
    }
    return this._Interpolator;
  }
  /**
   * Interpolator3pt class, combine two interpolators
   */
  static get Interpolator3pt() {
    if (!this._Interpolator3pt) {
      this._Interpolator3pt = class {
        constructor(lo, mid, hi, v1, vMid, v2) {
          this.fSegment1 = new _FaustSensors.Interpolator(
            lo,
            mid,
            v1,
            vMid
          );
          this.fSegment2 = new _FaustSensors.Interpolator(
            mid,
            hi,
            vMid,
            v2
          );
          this.fMid = mid;
        }
        returnMappedValue(x) {
          return x < this.fMid ? this.fSegment1.returnMappedValue(x) : this.fSegment2.returnMappedValue(x);
        }
        getMappingValues(amin, amid, amax) {
          const lowHighSegment1 = this.fSegment1.getLowHigh(
            amin,
            amid
          );
          const lowHighSegment2 = this.fSegment2.getLowHigh(
            amid,
            amax
          );
          return {
            amin: lowHighSegment1.amin,
            amid: lowHighSegment2.amin,
            amax: lowHighSegment2.amax
          };
        }
      };
    }
    return this._Interpolator3pt;
  }
  /**
   * UpConverter class, convert accelerometer value to Faust value
   */
  static get UpConverter() {
    if (!this._UpConverter) {
      this._UpConverter = class {
        constructor(amin, amid, amax, fmin, fmid, fmax) {
          this.fActive = true;
          this.fA2F = new _FaustSensors.Interpolator3pt(
            amin,
            amid,
            amax,
            fmin,
            fmid,
            fmax
          );
          this.fF2A = new _FaustSensors.Interpolator3pt(
            fmin,
            fmid,
            fmax,
            amin,
            amid,
            amax
          );
        }
        uiToFaust(x) {
          return this.fA2F.returnMappedValue(x);
        }
        faustToUi(x) {
          return this.fF2A.returnMappedValue(x);
        }
        setMappingValues(amin, amid, amax, min, init, max) {
          this.fA2F = new _FaustSensors.Interpolator3pt(
            amin,
            amid,
            amax,
            min,
            init,
            max
          );
          this.fF2A = new _FaustSensors.Interpolator3pt(
            min,
            init,
            max,
            amin,
            amid,
            amax
          );
        }
        getMappingValues(amin, amid, amax) {
          return this.fA2F.getMappingValues(amin, amid, amax);
        }
        setActive(onOff) {
          this.fActive = onOff;
        }
        getActive() {
          return this.fActive;
        }
      };
    }
    return this._UpConverter;
  }
  /**
   * DownConverter class, convert accelerometer value to Faust value
   */
  static get DownConverter() {
    if (!this._DownConverter) {
      this._DownConverter = class {
        constructor(amin, amid, amax, fmin, fmid, fmax) {
          this.fActive = true;
          this.fA2F = new _FaustSensors.Interpolator3pt(
            amin,
            amid,
            amax,
            fmax,
            fmid,
            fmin
          );
          this.fF2A = new _FaustSensors.Interpolator3pt(
            fmin,
            fmid,
            fmax,
            amax,
            amid,
            amin
          );
        }
        uiToFaust(x) {
          return this.fA2F.returnMappedValue(x);
        }
        faustToUi(x) {
          return this.fF2A.returnMappedValue(x);
        }
        setMappingValues(amin, amid, amax, min, init, max) {
          this.fA2F = new _FaustSensors.Interpolator3pt(
            amin,
            amid,
            amax,
            max,
            init,
            min
          );
          this.fF2A = new _FaustSensors.Interpolator3pt(
            min,
            init,
            max,
            amax,
            amid,
            amin
          );
        }
        getMappingValues(amin, amid, amax) {
          return this.fA2F.getMappingValues(amin, amid, amax);
        }
        setActive(onOff) {
          this.fActive = onOff;
        }
        getActive() {
          return this.fActive;
        }
      };
    }
    return this._DownConverter;
  }
  /**
   * UpDownConverter class, convert accelerometer value to Faust value
   */
  static get UpDownConverter() {
    if (!this._UpDownConverter) {
      this._UpDownConverter = class {
        constructor(amin, amid, amax, fmin, fmid, fmax) {
          this.fActive = true;
          this.fA2F = new _FaustSensors.Interpolator3pt(
            amin,
            amid,
            amax,
            fmin,
            fmax,
            fmin
          );
          this.fF2A = new _FaustSensors.Interpolator(
            fmin,
            fmax,
            amin,
            amax
          );
        }
        uiToFaust(x) {
          return this.fA2F.returnMappedValue(x);
        }
        faustToUi(x) {
          return this.fF2A.returnMappedValue(x);
        }
        setMappingValues(amin, amid, amax, min, init, max) {
          this.fA2F = new _FaustSensors.Interpolator3pt(
            amin,
            amid,
            amax,
            min,
            max,
            min
          );
          this.fF2A = new _FaustSensors.Interpolator(
            min,
            max,
            amin,
            amax
          );
        }
        getMappingValues(amin, amid, amax) {
          return this.fA2F.getMappingValues(amin, amid, amax);
        }
        setActive(onOff) {
          this.fActive = onOff;
        }
        getActive() {
          return this.fActive;
        }
      };
    }
    return this._UpDownConverter;
  }
  static get DownUpConverter() {
    if (!this._DownUpConverter) {
      this._DownUpConverter = class {
        constructor(amin, amid, amax, fmin, fmid, fmax) {
          this.fActive = true;
          this.fA2F = new _FaustSensors.Interpolator3pt(
            amin,
            amid,
            amax,
            fmax,
            fmin,
            fmax
          );
          this.fF2A = new _FaustSensors.Interpolator(
            fmin,
            fmax,
            amin,
            amax
          );
        }
        uiToFaust(x) {
          return this.fA2F.returnMappedValue(x);
        }
        faustToUi(x) {
          return this.fF2A.returnMappedValue(x);
        }
        setMappingValues(amin, amid, amax, min, init, max) {
          this.fA2F = new _FaustSensors.Interpolator3pt(
            amin,
            amid,
            amax,
            max,
            min,
            max
          );
          this.fF2A = new _FaustSensors.Interpolator(
            min,
            max,
            amin,
            amax
          );
        }
        getMappingValues(amin, amid, amax) {
          return this.fA2F.getMappingValues(amin, amid, amax);
        }
        setActive(onOff) {
          this.fActive = onOff;
        }
        getActive() {
          return this.fActive;
        }
      };
    }
    return this._DownUpConverter;
  }
  /**
   * Public function to build the accelerometer handler
   *
   * @returns `UpdatableValueConverter` built for the given curve
   */
  static buildHandler(curve, amin, amid, amax, min, init, max) {
    switch (curve) {
      case 0 /* Up */:
        return new _FaustSensors.UpConverter(
          amin,
          amid,
          amax,
          min,
          init,
          max
        );
      case 1 /* Down */:
        return new _FaustSensors.DownConverter(
          amin,
          amid,
          amax,
          min,
          init,
          max
        );
      case 2 /* UpDown */:
        return new _FaustSensors.UpDownConverter(
          amin,
          amid,
          amax,
          min,
          init,
          max
        );
      case 3 /* DownUp */:
        return new _FaustSensors.DownUpConverter(
          amin,
          amid,
          amax,
          min,
          init,
          max
        );
      default:
        return new _FaustSensors.UpConverter(
          amin,
          amid,
          amax,
          min,
          init,
          max
        );
    }
  }
};

// src/FaustWebAudioDsp.ts
var WasmAllocator = class {
  constructor(memory, offset) {
    this.memory = memory;
    this.allocatedBytes = offset;
  }
  /**
   * Allocates a block of memory of the specified size, returning the pointer to the
   * beginning of the block. The block is allocated at the current offset, aligned on
   * 8 bytes, and the offset is incremented by the size of the block.
   *
   * @param sizeInBytes The size of the block to allocate in bytes.
   * @returns The offset (pointer) to the beginning of the allocated block.
   */
  alloc(sizeInBytes) {
    const currentOffset = this.allocatedBytes + 7 & ~7;
    const newOffset = currentOffset + sizeInBytes;
    const totalMemoryBytes = this.memory.buffer.byteLength;
    if (newOffset > totalMemoryBytes) {
      const neededPages = Math.ceil(
        (newOffset - totalMemoryBytes) / 65536
      );
      console.log(`GROW: ${neededPages} pages`);
      this.memory.grow(neededPages);
    }
    this.allocatedBytes = newOffset;
    return currentOffset;
  }
  /**
   * Returns the underlying buffer object.
   *
   * @returns The buffer object.
   */
  getBuffer() {
    return this.memory.buffer;
  }
  /**
   * Returns the Int32 view of the underlying buffer object.
   *
   * @returns The view of the memory buffer as Int32Array.
   */
  getInt32Array() {
    return new Int32Array(this.memory.buffer);
  }
  /**
   * Returns the Int64 view of the underlying buffer object.
   *
   * @returns The view of the memory buffer as BigInt64Array.
   */
  getInt64Array() {
    return new BigInt64Array(this.memory.buffer);
  }
  /**
   * Returns the Float32 view of the underlying buffer object.
   *
   * @returns The view of the memory buffer as Float32Array.
   */
  getFloat32Array() {
    return new Float32Array(this.memory.buffer);
  }
  /**
   * Returns the Float64 view of the underlying buffer object..
   *
   * @returns The view of the memory buffer as Float64Array.
   */
  getFloat64Array() {
    return new Float64Array(this.memory.buffer);
  }
};
var Soundfile = class _Soundfile {
  /** Maximum number of soundfile parts. */
  static get MAX_SOUNDFILE_PARTS() {
    return 256;
  }
  /**
   * @deprecated channels are no more duplicated up to MAX_CHAN: the generated code
   * reads channel 'chan % fChannels'.
   */
  static get MAX_CHAN() {
    return 64;
  }
  /** Maximum buffer size in frames. */
  static get BUFFER_SIZE() {
    return 1024;
  }
  /** Default sample rate. */
  static get SAMPLE_RATE() {
    return 44100;
  }
  /**
   * @param _maxChan - deprecated and ignored: only the curChan real channels are allocated
   */
  constructor(allocator, sampleSize, curChan, length, _maxChan, totalParts) {
    this.fSampleSize = sampleSize;
    this.fIntSize = this.fSampleSize;
    this.fPtrSize = 4;
    this.fAllocator = allocator;
    console.log(
      `Soundfile constructor: curChan: ${curChan}, length: ${length}, totalParts: ${totalParts}`
    );
    this.fPtr = allocator.alloc(4 * this.fPtrSize + 3 * 4);
    this.fLength = allocator.alloc(
      _Soundfile.MAX_SOUNDFILE_PARTS * this.fIntSize
    );
    this.fSR = allocator.alloc(
      _Soundfile.MAX_SOUNDFILE_PARTS * this.fIntSize
    );
    this.fOffset = allocator.alloc(
      _Soundfile.MAX_SOUNDFILE_PARTS * this.fIntSize
    );
    this.fBuffers = this.allocBuffers(curChan, length);
    const HEAP32 = this.fAllocator.getInt32Array();
    HEAP32[this.fPtr >> 2] = this.fBuffers;
    HEAP32[this.fPtr + this.fPtrSize >> 2] = this.fLength;
    HEAP32[this.fPtr + 2 * this.fPtrSize >> 2] = this.fSR;
    HEAP32[this.fPtr + 3 * this.fPtrSize >> 2] = this.fOffset;
    HEAP32[this.fPtr + 4 * this.fPtrSize >> 2] = curChan;
    HEAP32[this.fPtr + 4 * this.fPtrSize + 4 >> 2] = totalParts;
    HEAP32[this.fPtr + 4 * this.fPtrSize + 8 >> 2] = this.fSampleSize === 8 ? 1 : 0;
    for (let chan = 0; chan < curChan; chan++) {
      const buffer = HEAP32[(this.fBuffers >> 2) + chan];
      console.log(`allocBuffers AFTER: ${chan} - ${buffer}`);
    }
  }
  allocBuffers(curChan, length) {
    const buffers = this.fAllocator.alloc(curChan * this.fPtrSize);
    console.log(`allocBuffers buffers: ${buffers}`);
    for (let chan = 0; chan < curChan; chan++) {
      const buffer = this.fAllocator.alloc(
        length * this.fSampleSize
      );
      const HEAP32 = this.fAllocator.getInt32Array();
      HEAP32[(buffers >> 2) + chan] = buffer;
    }
    return buffers;
  }
  copyToOut(part, maxChannels, offset, audioData) {
    if (this.fIntSize === 4) {
      const HEAP32 = this.fAllocator.getInt32Array();
      HEAP32[(this.fLength >> Math.log2(this.fIntSize)) + part] = audioData.audioBuffer[0].length;
      HEAP32[(this.fSR >> Math.log2(this.fIntSize)) + part] = audioData.sampleRate;
      HEAP32[(this.fOffset >> Math.log2(this.fIntSize)) + part] = offset;
    } else {
      const HEAP64 = this.fAllocator.getInt64Array();
      HEAP64[(this.fLength >> Math.log2(this.fIntSize)) + part] = BigInt(
        audioData.audioBuffer[0].length
      );
      HEAP64[(this.fSR >> Math.log2(this.fIntSize)) + part] = BigInt(
        audioData.sampleRate
      );
      HEAP64[(this.fOffset >> Math.log2(this.fIntSize)) + part] = BigInt(offset);
    }
    console.log(
      `copyToOut: part: ${part}, maxChannels: ${maxChannels}, offset: ${offset}, buffer: ${audioData}`
    );
    if (this.fSampleSize === 8) {
      this.copyToOutReal64(maxChannels, offset, audioData);
    } else {
      this.copyToOutReal32(maxChannels, offset, audioData);
    }
  }
  copyToOutReal32(maxChannels, offset, audioData) {
    const HEAP32 = this.fAllocator.getInt32Array();
    const HEAPF = this.fAllocator.getFloat32Array();
    for (let chan = 0; chan < audioData.audioBuffer.length; chan++) {
      const input = audioData.audioBuffer[chan];
      const output = HEAP32[(this.fBuffers >> 2) + chan];
      const begin = output + offset * this.fSampleSize >> Math.log2(this.fSampleSize);
      const end = output + (offset + input.length) * this.fSampleSize >> Math.log2(this.fSampleSize);
      console.log(
        `copyToOutReal32 begin: ${begin}, end: ${end}, delta: ${end - begin}`
      );
      const outputReal = HEAPF.subarray(
        output + offset * this.fSampleSize >> Math.log2(this.fSampleSize),
        output + (offset + input.length) * this.fSampleSize >> Math.log2(this.fSampleSize)
      );
      for (let sample = 0; sample < input.length; sample++) {
        outputReal[sample] = input[sample];
      }
    }
  }
  copyToOutReal64(maxChannels, offset, audioData) {
    const HEAP32 = this.fAllocator.getInt32Array();
    const HEAPF = this.fAllocator.getFloat64Array();
    for (let chan = 0; chan < audioData.audioBuffer.length; chan++) {
      const input = audioData.audioBuffer[chan];
      const output = HEAP32[(this.fBuffers >> 2) + chan];
      const begin = output + offset * this.fSampleSize >> Math.log2(this.fSampleSize);
      const end = output + (offset + input.length) * this.fSampleSize >> Math.log2(this.fSampleSize);
      console.log(
        `copyToOutReal64 begin: ${begin}, end: ${end}, delta: ${end - begin}`
      );
      const outputReal = HEAPF.subarray(
        output + offset * this.fSampleSize >> Math.log2(this.fSampleSize),
        output + (offset + input.length) * this.fSampleSize >> Math.log2(this.fSampleSize)
      );
      for (let sample = 0; sample < input.length; sample++) {
        outputReal[sample] = input[sample];
      }
    }
  }
  emptyFile(part, offset) {
    if (this.fIntSize === 4) {
      const HEAP32 = this.fAllocator.getInt32Array();
      HEAP32[(this.fLength >> Math.log2(this.fIntSize)) + part] = _Soundfile.BUFFER_SIZE;
      HEAP32[(this.fSR >> Math.log2(this.fIntSize)) + part] = _Soundfile.SAMPLE_RATE;
      HEAP32[(this.fOffset >> Math.log2(this.fIntSize)) + part] = offset;
    } else {
      const HEAP64 = this.fAllocator.getInt64Array();
      HEAP64[(this.fLength >> Math.log2(this.fIntSize)) + part] = BigInt(
        _Soundfile.BUFFER_SIZE
      );
      HEAP64[(this.fSR >> Math.log2(this.fIntSize)) + part] = BigInt(
        _Soundfile.SAMPLE_RATE
      );
      HEAP64[(this.fOffset >> Math.log2(this.fIntSize)) + part] = BigInt(offset);
    }
    return offset + _Soundfile.BUFFER_SIZE;
  }
  displayMemory(where = "", mem = false) {
    console.log("Soundfile memory: " + where);
    console.log(`fPtr: ${this.fPtr}`);
    console.log(`fBuffers: ${this.fBuffers}`);
    console.log(`fLength: ${this.fLength}`);
    console.log(`fSR: ${this.fSR}`);
    console.log(`fOffset: ${this.fOffset}`);
    const HEAP32 = this.fAllocator.getInt32Array();
    if (mem) console.log(`HEAP32: ${HEAP32}`);
    console.log(`HEAP32[this.fPtr >> 2]: ${HEAP32[this.fPtr >> 2]}`);
    console.log(
      `HEAP32[(this.fPtr + ptrSize) >> 2]: ${HEAP32[this.fPtr + this.fPtrSize >> 2]}`
    );
    console.log(
      `HEAP32[(this.fPtr + 2 * ptrSize) >> 2]: ${HEAP32[this.fPtr + 2 * this.fPtrSize >> 2]}`
    );
    console.log(
      `HEAP32[(this.fPtr + 3 * ptrSize) >> 2]: ${HEAP32[this.fPtr + 3 * this.fPtrSize >> 2]}`
    );
  }
  // Return the pointer to the soundfile structure in wasm memory
  getPtr() {
    return this.fPtr;
  }
  getHEAP32() {
    return this.fAllocator.getInt32Array();
  }
  getHEAPFloat32() {
    return this.fAllocator.getFloat32Array();
  }
  getHEAPFloat64() {
    return this.fAllocator.getFloat64Array();
  }
};
var FaustBaseWebAudioDsp = class _FaustBaseWebAudioDsp {
  constructor(sampleSize, bufferSize, soundfiles) {
    this.fOutputHandler = null;
    this.fInputHandler = null;
    this.fComputeHandler = null;
    // Told once when the DSP first produces a non-finite output sample
    this.fNonFiniteHandler = null;
    this.fNonFiniteReported = false;
    // To handle MIDI events plot
    this.fPlotHandler = null;
    this.fCachedEvents = [];
    this.fBufferNum = 0;
    this.fInChannels = [];
    this.fOutChannels = [];
    this.fOutputsTimer = 5;
    // UI items path
    this.fInputsItems = [];
    this.fOutputsItems = [];
    this.fDescriptor = [];
    // Soundfile handling
    this.fSoundfiles = [];
    this.fSoundfileBuffers = {};
    /**
     * Block-start address of every wasm audio channel, plus the heap view
     * holding the pointer tables.
     *
     * Rendering a slice means giving wasm a channel pointer to the slice's
     * first frame, so `setBufferOffset` rewrites the tables and needs these
     * unmoved addresses to offset from. Only the tables move; the
     * `fInChannels` / `fOutChannels` views from `initMemory` still span the
     * whole block and stay valid.
     */
    this.fInBase = [];
    this.fOutBase = [];
    // MIDI handling
    this.fPitchwheelLabel = [];
    this.fCtrlLabel = new Array(128).fill(null).map(() => []);
    // array of MIDI key handlers; array index is the MIDI note number
    this.fMidiKeyLabel = new Array(128).fill(null).map(() => []);
    this.fMidiKeyOnLabel = new Array(128).fill(null).map(() => []);
    this.fMidiKeyOffLabel = new Array(128).fill(null).map(() => []);
    // Received MIDI channel in 1..16, 0 for all channels (see setMidiChannel)
    this.fMidiChannel = 0;
    this.fPathTable = {};
    /** Paths already complained about, so the warning is not repeated. */
    this.fUnknownPaths = /* @__PURE__ */ new Set();
    this.fUICallback = (item) => {
      if (item.type === "hbargraph" || item.type === "vbargraph") {
        const registerPath = (alias) => {
          if (this.fPathTable[alias] === void 0) {
            this.fPathTable[alias] = item.index;
          }
        };
        this.fOutputsItems.push(item.address);
        registerPath(item.address);
        registerPath(item.shortname);
        registerPath(item.label);
      } else if (item.type === "vslider" || item.type === "hslider" || item.type === "button" || item.type === "checkbox" || item.type === "nentry") {
        const registerPath = (alias) => {
          if (this.fPathTable[alias] === void 0) {
            this.fPathTable[alias] = item.index;
          }
        };
        this.fInputsItems.push(item.address);
        registerPath(item.address);
        registerPath(item.shortname);
        registerPath(item.label);
        this.fDescriptor.push(item);
        if (!item.meta) return;
        item.meta.forEach((meta) => {
          var _a, _b, _c, _d, _e, _f;
          const { midi, acc, gyr } = meta;
          if (midi) {
            const strMidi = midi.trim();
            if (strMidi === "pitchwheel") {
              const matched = strMidi.match(/^pitchwheel\s(\d+)/);
              if (matched) {
                this.fPitchwheelLabel.push({
                  path: item.address,
                  chan: parseInt(matched[1]),
                  min: item.min,
                  max: item.max
                });
              } else {
                this.fPitchwheelLabel.push({
                  path: item.address,
                  chan: 0,
                  min: item.min,
                  max: item.max
                });
              }
            } else {
              const matched2 = strMidi.match(/^ctrl\s(\d+)\s(\d+)/);
              const matched1 = strMidi.match(/^ctrl\s(\d+)/);
              const matchedKey = strMidi.match(
                /^key\s+(\d+)(?:\s+(\d+))?$/
              );
              const matchedKeyOn = strMidi.match(
                /^keyon\s+(\d+)(?:\s+(\d+))?$/
              );
              const matchedKeyOff = strMidi.match(
                /^keyoff\s+(\d+)(?:\s+(\d+))?$/
              );
              if (matched2) {
                this.fCtrlLabel[parseInt(matched2[1])].push({
                  path: item.address,
                  chan: parseInt(matched2[2]),
                  min: item.min,
                  max: item.max
                });
              } else if (matched1) {
                this.fCtrlLabel[parseInt(matched1[1])].push({
                  path: item.address,
                  chan: 0,
                  min: item.min,
                  max: item.max
                });
              } else if (matchedKey) {
                const note = parseInt(matchedKey[1]);
                const channel = matchedKey[2] ? parseInt(matchedKey[2]) : 0;
                this.fMidiKeyLabel[note].push({
                  path: item.address,
                  chan: channel,
                  min: (_a = item.min) != null ? _a : 0,
                  max: (_b = item.max) != null ? _b : 1
                });
              } else if (matchedKeyOn) {
                const note = parseInt(matchedKeyOn[1]);
                const channel = matchedKeyOn[2] ? parseInt(matchedKeyOn[2]) : 0;
                this.fMidiKeyOnLabel[note].push({
                  path: item.address,
                  chan: channel,
                  min: (_c = item.min) != null ? _c : 0,
                  max: (_d = item.max) != null ? _d : 1
                });
              } else if (matchedKeyOff) {
                const note = parseInt(matchedKeyOff[1]);
                const channel = matchedKeyOff[2] ? parseInt(matchedKeyOff[2]) : 0;
                this.fMidiKeyOffLabel[note].push({
                  path: item.address,
                  chan: channel,
                  min: (_e = item.min) != null ? _e : 0,
                  max: (_f = item.max) != null ? _f : 1
                });
              }
            }
          }
          if (acc) {
            const numAcc = acc.trim().split(" ").map(Number);
            this.setupAccHandler(
              item.address,
              FaustSensors.convertToAxis(numAcc[0]),
              FaustSensors.convertToCurve(numAcc[1]),
              numAcc[2],
              numAcc[3],
              numAcc[4],
              item.min,
              item.init,
              item.max
            );
          }
          if (gyr) {
            const numAcc = gyr.trim().split(" ").map(Number);
            this.setupGyrHandler(
              item.address,
              FaustSensors.convertToAxis(numAcc[0]),
              FaustSensors.convertToCurve(numAcc[1]),
              numAcc[2],
              numAcc[3],
              numAcc[4],
              item.min,
              item.init,
              item.max
            );
          }
        });
      } else if (item.type === "soundfile") {
        this.fSoundfiles.push({
          name: item.label,
          url: item.url,
          index: item.index,
          basePtr: -1
        });
      }
    };
    // Audio callback
    this.fProcessing = false;
    this.fDestroyed = false;
    this.fFirstCall = true;
    this.fBufferSize = bufferSize;
    this.fPtrSize = sampleSize;
    this.fSampleSize = sampleSize;
    this.fSoundfileBuffers = soundfiles;
    this.fAcc = { x: [], y: [], z: [] };
    this.fGyr = { x: [], y: [], z: [] };
  }
  /**
   * Report a parameter path that is in no control's alias list.
   *
   * Silence here is expensive: the path is a typo, or one kept from an
   * older version of the DSP, and without a word the control simply does
   * nothing while the caller believes it worked. But this can be reached
   * from the audio thread, at the rate a host moves a slider, so each path
   * is reported once and then let through quietly.
   *
   * @param path - the path that was not found
   * @param action - what was done instead
   */
  warnUnknownPath(path, action) {
    if (this.fUnknownPaths.has(path)) return;
    this.fUnknownPaths.add(path);
    console.warn(
      `Faust: unknown parameter path "${path}", ${action}. Use getParams() for the list of valid paths.`
    );
  }
  /**
   * Render a whole block through `render`, stopping at each event.
   *
   * Render up to the next event's frame, apply it, continue. Living in the
   * base class means mono and poly only have to supply what rendering a
   * slice means.
   *
   * With no events the block is one slice, which is what every caller that
   * passes no events gets.
   */
  renderBlock(events, render) {
    if (!events || events.length === 0) {
      render(0, this.fBufferSize);
      return;
    }
    let frame = 0;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const at = Math.min(Math.max(event.frame, 0), this.fBufferSize);
      if (at > frame) {
        render(frame, at - frame);
        frame = at;
      }
      event.apply();
    }
    if (frame < this.fBufferSize) {
      render(frame, this.fBufferSize - frame);
    }
  }
  /**
   * Apply every event without rendering.
   *
   * For the blocks `compute` returns early from: stopped, or an input or
   * output not connected yet. The events have already left the processor's
   * queue, so dropping them here loses them permanently -- a `keyOn` that
   * never sounds, or a parameter the DSP and the host disagree about from
   * then on.
   *
   * A destroyed DSP is the exception, and does drop them.
   */
  applyEvents(events) {
    if (!events) return;
    for (let i = 0; i < events.length; i++) events[i].apply();
  }
  /**
   * Point the wasm channel tables at frame `offset` of the block.
   *
   * Each slice sets this before rendering, so nothing outside `compute`
   * depends on where the previous slice left the tables.
   */
  setBufferOffset(offset) {
    const bytes = offset * this.fSampleSize;
    for (let chan = 0; chan < this.fInBase.length; chan++) {
      this.fHEAP32[(this.fAudioInputs >> 2) + chan] = this.fInBase[chan] + bytes;
    }
    for (let chan = 0; chan < this.fOutBase.length; chan++) {
      this.fHEAP32[(this.fAudioOutputs >> 2) + chan] = this.fOutBase[chan] + bytes;
    }
  }
  // Tools
  static remap(v, mn0, mx0, mn1, mx1) {
    return (v - mn0) / (mx0 - mn0) * (mx1 - mn1) + mn1;
  }
  // JSON parsing functions
  static parseUI(ui, callback) {
    ui.forEach((group) => this.parseGroup(group, callback));
  }
  static parseGroup(group, callback) {
    if (group.items) {
      this.parseItems(group.items, callback);
    }
  }
  static parseItems(items, callback) {
    items.forEach((item) => this.parseItem(item, callback));
  }
  static parseItem(item, callback) {
    if (item.type === "vgroup" || item.type === "hgroup" || item.type === "tgroup") {
      this.parseItems(item.items, callback);
    } else {
      callback(item);
    }
  }
  /** Split the soundfile names and return an array of names */
  static splitSoundfileNames(input) {
    const trimmed = input.replace(/^\{|\}$/g, "");
    return trimmed.split(";").map(
      (str) => str.length <= 2 ? "" : str.substring(1, str.length - 1)
    ).map((str) => str.trim()).filter((str) => str.length > 0);
  }
  get hasAccInput() {
    return this.fAcc.x.length + this.fAcc.y.length + this.fAcc.z.length > 0;
  }
  propagateAcc(accelerationIncludingGravity, invert = false) {
    const { x, y, z } = accelerationIncludingGravity;
    if (invert) {
      if (x !== null) this.fAcc.x.forEach((handler) => handler(-x));
      if (y !== null) this.fAcc.y.forEach((handler) => handler(-y));
      if (z !== null) this.fAcc.z.forEach((handler) => handler(-z));
    } else {
      if (x !== null) this.fAcc.x.forEach((handler) => handler(x));
      if (y !== null) this.fAcc.y.forEach((handler) => handler(y));
      if (z !== null) this.fAcc.z.forEach((handler) => handler(z));
    }
  }
  get hasGyrInput() {
    return this.fGyr.x.length + this.fGyr.y.length + this.fGyr.z.length > 0;
  }
  propagateGyr(event) {
    const { alpha, beta, gamma } = event;
    if (alpha !== null) this.fGyr.x.forEach((handler) => handler(alpha));
    if (beta !== null) this.fGyr.y.forEach((handler) => handler(beta));
    if (gamma !== null) this.fGyr.z.forEach((handler) => handler(gamma));
  }
  /** Build the accelerometer handler */
  setupAccHandler(path, axis, curve, amin, amid, amax, min, init, max) {
    const handler = FaustSensors.buildHandler(
      curve,
      amin,
      amid,
      amax,
      min,
      init,
      max
    );
    switch (axis) {
      case 0 /* x */:
        this.fAcc.x.push(
          (val) => this.setParamValue(path, handler.uiToFaust(val))
        );
        break;
      case 1 /* y */:
        this.fAcc.y.push(
          (val) => this.setParamValue(path, handler.uiToFaust(val))
        );
        break;
      case 2 /* z */:
        this.fAcc.z.push(
          (val) => this.setParamValue(path, handler.uiToFaust(val))
        );
        break;
    }
  }
  /** Build the gyroscope handler */
  setupGyrHandler(path, axis, curve, amin, amid, amax, min, init, max) {
    const handler = FaustSensors.buildHandler(
      curve,
      amin,
      amid,
      amax,
      min,
      init,
      max
    );
    switch (axis) {
      case 0 /* x */:
        this.fGyr.x.push(
          (val) => this.setParamValue(path, handler.uiToFaust(val))
        );
        break;
      case 1 /* y */:
        this.fGyr.y.push(
          (val) => this.setParamValue(path, handler.uiToFaust(val))
        );
        break;
      case 2 /* z */:
        this.fGyr.z.push(
          (val) => this.setParamValue(path, handler.uiToFaust(val))
        );
        break;
    }
  }
  static extractUrlsFromMeta(dspMeta) {
    const soundfilesEntry = dspMeta.meta.find(
      (entry) => entry.soundfiles !== void 0
    );
    if (soundfilesEntry) {
      return soundfilesEntry.soundfiles.split(";").filter((url) => url !== "");
    } else {
      return [];
    }
  }
  /**
   * Load a soundfile possibly containing several parts in the DSP struct.
   * Soundfile pointers are located at 'index' offset, to be read in the JSON file.
   * The DSP struct is located at baseDSP in the wasm memory,
   * either a monophonic DSP, or a voice in a polyphonic context.
   *
   * @param allocator : the wasm memory allocator
   * @param baseDSP : the base DSP in the wasm memory
   * @param name : the name of the soundfile
   * @param url : the url of the soundfile
   */
  loadSoundfile(allocator, baseDSP, name, url) {
    console.log(`Soundfile ${name} paths: ${url}`);
    const soundfileIds = _FaustBaseWebAudioDsp.splitSoundfileNames(url);
    const item = this.fSoundfiles.find((item2) => item2.url === url);
    if (!item) throw new Error(`Soundfile with ${url} cannot be found !}`);
    if (item.basePtr !== -1) {
      const HEAP32 = allocator.getInt32Array();
      console.log(
        `Soundfile CACHE ${url}} : ${name} loaded at ${item.basePtr} in wasm memory with index ${item.index}`
      );
      HEAP32[baseDSP + item.index >> 2] = item.basePtr;
    } else {
      const soundfile = this.createSoundfile(
        allocator,
        soundfileIds,
        this.fSoundfileBuffers
      );
      if (soundfile) {
        const HEAP32 = soundfile.getHEAP32();
        item.basePtr = soundfile.getPtr();
        console.log(
          `Soundfile ${name} loaded at ${item.basePtr} in wasm memory with index ${item.index}`
        );
        HEAP32[baseDSP + item.index >> 2] = item.basePtr;
      } else {
        console.log(
          `Soundfile ${name} for ${url} cannot be created !}`
        );
      }
    }
  }
  /**
   * Create a soundfile holding the max number of channels of all its parts.
   *
   * @param _maxChan - deprecated and ignored
   */
  createSoundfile(allocator, soundfileIdList, soundfiles, _maxChan) {
    let curChan = 1;
    let totalLength = 0;
    for (const soundfileId of soundfileIdList) {
      let chan = 0;
      let len = 0;
      const audioData = soundfiles == null ? void 0 : soundfiles[soundfileId];
      if (audioData) {
        chan = audioData.audioBuffer.length;
        len = audioData.audioBuffer[0].length;
      } else {
        len = Soundfile.BUFFER_SIZE;
        chan = 1;
      }
      curChan = Math.max(curChan, chan);
      totalLength += len;
    }
    totalLength += (Soundfile.MAX_SOUNDFILE_PARTS - soundfileIdList.length) * Soundfile.BUFFER_SIZE;
    const soundfile = new Soundfile(
      allocator,
      this.fSampleSize,
      curChan,
      totalLength,
      curChan,
      soundfileIdList.length
    );
    let offset = 0;
    for (let part = 0; part < soundfileIdList.length; part++) {
      const soundfileId = soundfileIdList[part];
      const audioData = soundfiles == null ? void 0 : soundfiles[soundfileId];
      if (audioData) {
        soundfile.copyToOut(part, curChan, offset, audioData);
        offset += audioData.audioBuffer[0].length;
      } else {
        offset = soundfile.emptyFile(part, offset);
      }
    }
    for (let part = soundfileIdList.length; part < Soundfile.MAX_SOUNDFILE_PARTS; part++) {
      offset = soundfile.emptyFile(part, offset);
    }
    return soundfile;
  }
  /**
   * Init soundfiles memory.
   *
   * @param allocator : the wasm memory allocator
   * @param baseDSP : the DSP struct (either a monophonic DSP of polyphonic voice) base DSP in the wasm memory
   */
  initSoundfileMemory(allocator, baseDSP) {
    for (const { name, url } of this.fSoundfiles) {
      this.loadSoundfile(allocator, baseDSP, name, url);
    }
  }
  updateOutputs() {
    if (this.fOutputsItems.length > 0 && this.fOutputHandler && this.fOutputsTimer-- === 0) {
      this.fOutputsTimer = 5;
      this.fOutputsItems.forEach(
        (item) => {
          var _a;
          return (_a = this.fOutputHandler) == null ? void 0 : _a.call(this, item, this.getParamValue(item));
        }
      );
    }
  }
  // Public API
  metadata(handler) {
    if (this.fJSONDsp.meta) {
      this.fJSONDsp.meta.forEach(
        (meta) => handler(Object.keys(meta)[0], meta[Object.keys(meta)[0]])
      );
    }
  }
  compute(input, output) {
    return false;
  }
  setOutputParamHandler(handler) {
    this.fOutputHandler = handler;
  }
  getOutputParamHandler() {
    return this.fOutputHandler;
  }
  callOutputParamHandler(path, value) {
    if (this.fOutputHandler) {
      this.fOutputHandler(path, value);
    }
  }
  setInputParamHandler(handler) {
    this.fInputHandler = handler;
  }
  getInputParamHandler() {
    return this.fInputHandler;
  }
  callInputParamHandler(path, value) {
    if (this.fInputHandler) {
      this.fInputHandler(path, value);
    }
  }
  setComputeHandler(handler) {
    this.fComputeHandler = handler;
  }
  getComputeHandler() {
    return this.fComputeHandler;
  }
  setPlotHandler(handler) {
    this.fPlotHandler = handler;
  }
  getPlotHandler() {
    return this.fPlotHandler;
  }
  setNonFiniteHandler(handler) {
    this.fNonFiniteHandler = handler;
  }
  getNonFiniteHandler() {
    return this.fNonFiniteHandler;
  }
  /**
   * With a non-finite handler set, replace every non-finite sample of the block
   * just computed with 0, and report the first one to the handler.
   *
   * A control the compiler cannot know -- a Q, a divisor -- can make Faust code
   * divide by zero. The NaN stays in the DSP's recursive state for good, and
   * handed on it would poison every stateful node after this one for good too.
   * Called on the DSP's own output channels, before they are copied or handed
   * to an output callback, so every path out of 'compute' is covered.
   */
  clearNonFinite() {
    if (!this.fNonFiniteHandler) return;
    let found = false;
    const outputs = this.getNumOutputs();
    for (let chan = 0; chan < outputs; chan++) {
      const dspOutput = this.fOutChannels[chan];
      let sum = 0;
      for (let frame = 0; frame < dspOutput.length; frame++) {
        sum += dspOutput[frame];
      }
      if (sum - sum === 0) continue;
      for (let frame = 0; frame < dspOutput.length; frame++) {
        const sample = dspOutput[frame];
        if (sample - sample !== 0) {
          dspOutput[frame] = 0;
          found = true;
        }
      }
    }
    if (found && !this.fNonFiniteReported) {
      this.fNonFiniteReported = true;
      this.fNonFiniteHandler();
    }
  }
  getNumInputs() {
    return -1;
  }
  getNumOutputs() {
    return -1;
  }
  /**
   * Read the received MIDI channel from the DSP metadata:
   * `declare options "[midichannel:N]";` or `declare midichannel "N";`.
   *
   * Same rules as `MidiMeta::getChannel` in the C++ architecture files: an
   * invalid value is reported and means all channels.
   *
   * @param meta - the `meta` array of the DSP JSON
   * @returns the channel in 1..16, or 0 for all channels
   */
  static parseMidiChannel(meta) {
    if (!meta) return 0;
    let value;
    let source = "";
    for (const item of meta) {
      if (typeof item.options === "string") {
        const match = item.options.match(/\[midichannel:([^\]]*)\]/);
        if (match) {
          value = match[1];
          source = "[midichannel] option";
        }
      }
    }
    if (value === void 0) {
      for (const item of meta) {
        if (typeof item.midichannel === "string") {
          value = item.midichannel;
          source = "midichannel metadata";
        }
      }
    }
    if (value === void 0 || value.trim() === "") return 0;
    const channel = /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
    if (!(channel >= 0 && channel <= 16)) {
      console.warn(
        `Faust: invalid MIDI channel '${value}' in ${source}: should be in 1..16, or 0 for all channels`
      );
      return 0;
    }
    return channel;
  }
  setMidiChannel(channel) {
    this.fMidiChannel = Number.isInteger(channel) && channel >= 0 && channel <= 16 ? channel : 0;
  }
  getMidiChannel() {
    return this.fMidiChannel;
  }
  /**
   * Whether `midiMessage` receives the channel voice message whose status
   * byte is `status`. Real-time and SysEx messages (0xF0..0xFF) always are.
   */
  acceptMidiStatus(status) {
    return this.fMidiChannel === 0 || status >= 240 || (status & 15) === this.fMidiChannel - 1;
  }
  midiMessage(data) {
    if (!this.acceptMidiStatus(data[0])) return;
    if (this.fPlotHandler) this.fCachedEvents.push({ data, type: "midi" });
    const cmd = data[0] >> 4;
    const channel = data[0] & 15;
    const data1 = data[1];
    const data2 = data[2];
    if (cmd === 11) return this.ctrlChange(channel, data1, data2);
    if (cmd === 14) return this.pitchWheel(channel, data2 * 128 + data1);
    if (cmd === 9) {
      if (data2 > 0) return this.keyOn(channel, data1, data2);
      else return this.keyOff(channel, data1, data2);
    }
    if (cmd === 8) {
      return this.keyOff(channel, data1, data2);
    }
  }
  ctrlChange(channel, ctrl, value) {
    if (this.fPlotHandler)
      this.fCachedEvents.push({
        type: "ctrlChange",
        data: [channel, ctrl, value]
      });
    if (this.fCtrlLabel[ctrl].length) {
      this.fCtrlLabel[ctrl].forEach((ctrl2) => {
        const { path, chan } = ctrl2;
        if (chan === 0 || channel === chan - 1) {
          this.setParamValue(
            path,
            _FaustBaseWebAudioDsp.remap(
              value,
              0,
              127,
              ctrl2.min,
              ctrl2.max
            )
          );
          if (this.fOutputHandler)
            this.fOutputHandler(path, this.getParamValue(path));
        }
      });
    }
  }
  keyOn(channel, pitch, velocity) {
    if (this.fPlotHandler)
      this.fCachedEvents.push({
        type: "keyOn",
        data: [channel, pitch, velocity]
      });
    this.fMidiKeyOnLabel[pitch].forEach((key) => {
      const { path, chan } = key;
      if (chan === 0 || channel === chan - 1) {
        this.setParamValue(
          path,
          _FaustBaseWebAudioDsp.remap(
            velocity,
            0,
            127,
            key.min,
            key.max
          )
        );
        if (this.fOutputHandler)
          this.fOutputHandler(path, this.getParamValue(path));
      }
    });
    this.fMidiKeyLabel[pitch].forEach((key) => {
      const { path, chan } = key;
      if (chan === 0 || channel === chan - 1) {
        this.setParamValue(
          path,
          _FaustBaseWebAudioDsp.remap(
            velocity,
            0,
            127,
            key.min,
            key.max
          )
        );
        if (this.fOutputHandler)
          this.fOutputHandler(path, this.getParamValue(path));
      }
    });
  }
  keyOff(channel, pitch, velocity) {
    if (this.fPlotHandler)
      this.fCachedEvents.push({
        type: "keyOff",
        data: [channel, pitch, velocity]
      });
    this.fMidiKeyOffLabel[pitch].forEach((key) => {
      const { path, chan } = key;
      if (chan === 0 || channel === chan - 1) {
        this.setParamValue(
          path,
          _FaustBaseWebAudioDsp.remap(
            velocity,
            0,
            127,
            key.min,
            key.max
          )
        );
        if (this.fOutputHandler)
          this.fOutputHandler(path, this.getParamValue(path));
      }
    });
    this.fMidiKeyLabel[pitch].forEach((key) => {
      const { path, chan } = key;
      if (chan === 0 || channel === chan - 1) {
        this.setParamValue(path, 0);
        if (this.fOutputHandler)
          this.fOutputHandler(path, this.getParamValue(path));
      }
    });
  }
  pitchWheel(channel, wheel) {
    if (this.fPlotHandler)
      this.fCachedEvents.push({
        type: "pitchWheel",
        data: [channel, wheel]
      });
    this.fPitchwheelLabel.forEach((pw) => {
      const { path, chan } = pw;
      if (chan === 0 || channel === chan - 1) {
        this.setParamValue(
          path,
          _FaustBaseWebAudioDsp.remap(wheel, 0, 16383, pw.min, pw.max)
        );
        if (this.fOutputHandler)
          this.fOutputHandler(path, this.getParamValue(path));
      }
    });
  }
  setParamValue(path, value) {
  }
  getParamValue(path) {
    return 0;
  }
  getParams() {
    return this.fInputsItems;
  }
  getMeta() {
    return this.fJSONDsp;
  }
  getJSON() {
    return JSON.stringify(this.getMeta());
  }
  getUI() {
    return this.fJSONDsp.ui;
  }
  getDescriptors() {
    return this.fDescriptor;
  }
  hasSoundfiles() {
    return this.fSoundfiles.length > 0;
  }
  startSensors() {
    this.startSensors();
  }
  stopSensors() {
    this.stopSensors();
  }
  init() {
  }
  instanceInit() {
  }
  instanceClear() {
  }
  instanceConstants() {
  }
  instanceResetUserInterface() {
  }
  start() {
    this.fProcessing = true;
  }
  stop() {
    this.fProcessing = false;
  }
  destroy() {
    this.fDestroyed = true;
    this.fOutputHandler = null;
    this.fInputHandler = null;
    this.fComputeHandler = null;
    this.fPlotHandler = null;
  }
};
var FaustMonoWebAudioDsp = class extends FaustBaseWebAudioDsp {
  constructor(instance, sampleRate, sampleSize, bufferSize, soundfiles) {
    super(sampleSize, bufferSize, soundfiles);
    /**
     * Render one slice, for `renderBlock`.
     *
     * A field rather than an inline closure so it is allocated once instead of
     * on every `compute` call.
     */
    this.fRenderSlice = (offset, count) => {
      this.setBufferOffset(offset);
      this.fInstance.api.compute(
        this.fDSP,
        count,
        this.fAudioInputs,
        this.fAudioOutputs
      );
    };
    this.fInstance = instance;
    this.fSampleRate = sampleRate;
    this.fJSONDsp = JSON.parse(this.fInstance.json);
    this.fMidiChannel = FaustBaseWebAudioDsp.parseMidiChannel(
      this.fJSONDsp.meta
    );
    FaustBaseWebAudioDsp.parseUI(this.fJSONDsp.ui, this.fUICallback);
    this.fEndMemory = this.initMemory();
    this.fInstance.api.init(this.fDSP, sampleRate);
    if (this.fSoundfiles.length > 0) {
      const allocator = new WasmAllocator(
        this.fInstance.memory,
        this.fEndMemory
      );
      this.initSoundfileMemory(allocator, this.fDSP);
    }
  }
  init() {
    this.fInstance.api.init(this.fDSP, this.fSampleRate);
  }
  instanceInit() {
    this.fInstance.api.instanceInit(this.fDSP, this.fSampleRate);
  }
  instanceClear() {
    this.fInstance.api.instanceClear(this.fDSP);
  }
  instanceConstants() {
    this.fInstance.api.instanceConstants(this.fDSP, this.fSampleRate);
  }
  instanceResetUserInterface() {
    this.fInstance.api.instanceResetUserInterface(this.fDSP);
  }
  initMemory() {
    this.fDSP = 0;
    const $audio = this.fJSONDsp.size;
    this.fAudioInputs = $audio;
    this.fAudioOutputs = this.fAudioInputs + this.getNumInputs() * this.fPtrSize;
    const $audioInputs = this.fAudioOutputs + this.getNumOutputs() * this.fPtrSize;
    const $audioOutputs = $audioInputs + this.getNumInputs() * this.fBufferSize * this.fSampleSize;
    const endMemory = $audioOutputs + this.getNumOutputs() * this.fBufferSize * this.fSampleSize;
    const HEAP = this.fInstance.memory.buffer;
    const HEAP32 = new Int32Array(HEAP);
    const HEAPF = this.fSampleSize === 4 ? new Float32Array(HEAP) : new Float64Array(HEAP);
    if (this.getNumInputs() > 0) {
      for (let chan = 0; chan < this.getNumInputs(); chan++) {
        HEAP32[(this.fAudioInputs >> 2) + chan] = $audioInputs + this.fBufferSize * this.fSampleSize * chan;
      }
      const dspInChans = HEAP32.subarray(
        this.fAudioInputs >> 2,
        this.fAudioInputs + this.getNumInputs() * this.fPtrSize >> 2
      );
      for (let chan = 0; chan < this.getNumInputs(); chan++) {
        this.fInChannels[chan] = HEAPF.subarray(
          dspInChans[chan] >> Math.log2(this.fSampleSize),
          dspInChans[chan] + this.fBufferSize * this.fSampleSize >> Math.log2(this.fSampleSize)
        );
      }
    }
    if (this.getNumOutputs() > 0) {
      for (let chan = 0; chan < this.getNumOutputs(); chan++) {
        HEAP32[(this.fAudioOutputs >> 2) + chan] = $audioOutputs + this.fBufferSize * this.fSampleSize * chan;
      }
      const dspOutChans = HEAP32.subarray(
        this.fAudioOutputs >> 2,
        this.fAudioOutputs + this.getNumOutputs() * this.fPtrSize >> 2
      );
      for (let chan = 0; chan < this.getNumOutputs(); chan++) {
        this.fOutChannels[chan] = HEAPF.subarray(
          dspOutChans[chan] >> Math.log2(this.fSampleSize),
          dspOutChans[chan] + this.fBufferSize * this.fSampleSize >> Math.log2(this.fSampleSize)
        );
      }
    }
    this.fHEAP32 = HEAP32;
    this.fInBase = [];
    for (let chan = 0; chan < this.getNumInputs(); chan++) {
      this.fInBase[chan] = HEAP32[(this.fAudioInputs >> 2) + chan];
    }
    this.fOutBase = [];
    for (let chan = 0; chan < this.getNumOutputs(); chan++) {
      this.fOutBase[chan] = HEAP32[(this.fAudioOutputs >> 2) + chan];
    }
    return endMemory;
  }
  toString() {
    return `============== Mono Memory layout ==============
        this.fBufferSize: ${this.fBufferSize}
        this.fJSONDsp.size: ${this.fJSONDsp.size}
        this.fAudioInputs: ${this.fAudioInputs}
        this.fAudioOutputs: ${this.fAudioOutputs}
        this.fDSP: ${this.fDSP}`;
  }
  // Public API
  compute(input, output, events) {
    if (this.fDestroyed) return false;
    if (!this.fProcessing) {
      this.applyEvents(events);
      return true;
    }
    if (this.fFirstCall) {
      this.initMemory();
      this.fFirstCall = false;
    }
    if (typeof input === "function") {
      input(this.fInChannels);
    } else {
      if (this.getNumInputs() > 0 && (!input || !input[0] || input[0].length === 0)) {
        this.applyEvents(events);
        return true;
      }
      if (this.getNumOutputs() > 0 && typeof output !== "function" && (!output || !output[0] || output[0].length === 0)) {
        this.applyEvents(events);
        return true;
      }
      if (input !== void 0) {
        for (let chan = 0; chan < Math.min(this.getNumInputs(), input.length); chan++) {
          const dspInput = this.fInChannels[chan];
          dspInput.set(input[chan]);
        }
      }
    }
    if (this.fComputeHandler) this.fComputeHandler(this.fBufferSize);
    this.renderBlock(events, this.fRenderSlice);
    this.updateOutputs();
    this.clearNonFinite();
    let forPlot = this.fOutChannels;
    if (typeof output === "function") {
      output(this.fOutChannels);
    } else {
      for (let chan = 0; chan < Math.min(this.getNumOutputs(), output.length); chan++) {
        const dspOutput = this.fOutChannels[chan];
        output[chan].set(dspOutput);
      }
      forPlot = output;
    }
    if (this.fPlotHandler) {
      this.fPlotHandler(
        forPlot,
        this.fBufferNum++,
        this.fCachedEvents.length ? this.fCachedEvents : void 0
      );
      this.fCachedEvents = [];
    }
    return true;
  }
  metadata(handler) {
    super.metadata(handler);
  }
  getNumInputs() {
    return this.fInstance.api.getNumInputs(this.fDSP);
  }
  getNumOutputs() {
    return this.fInstance.api.getNumOutputs(this.fDSP);
  }
  setParamValue(path, value) {
    const index = this.fPathTable[path];
    if (index === void 0) return this.warnUnknownPath(path, "ignored");
    if (this.fPlotHandler)
      this.fCachedEvents.push({ type: "param", data: { path, value } });
    this.fInstance.api.setParamValue(this.fDSP, index, value);
    this.callInputParamHandler(path, this.getParamValue(path));
  }
  getParamValue(path) {
    const index = this.fPathTable[path];
    if (index === void 0) {
      this.warnUnknownPath(path, "returning 0");
      return 0;
    }
    return this.fInstance.api.getParamValue(this.fDSP, index);
  }
  getMeta() {
    return this.fJSONDsp;
  }
  getJSON() {
    return this.fInstance.json;
  }
  getDescriptors() {
    return this.fDescriptor;
  }
  getUI() {
    return this.fJSONDsp.ui;
  }
};
var FaustWebAudioDspVoice = class _FaustWebAudioDspVoice {
  constructor($dsp, api, inputItems, pathTable, sampleRate) {
    // -90 db
    this.fFreqLabel = [];
    this.fGateLabel = [];
    this.fGainLabel = [];
    this.fKeyLabel = [];
    this.fVelLabel = [];
    // Accessed by PolyDSPImp class
    this.fCurNote = _FaustWebAudioDspVoice.kFreeVoice;
    this.fNextNote = -1;
    this.fNextVel = -1;
    // MIDI channel (0..15) of the current note, of the next one in kLegatoVoice state
    this.fChannel = 0;
    this.fDate = 0;
    this.fLevel = 0;
    this.fDSP = $dsp;
    this.fAPI = api;
    this.fSampleRate = sampleRate;
    this.init(sampleRate);
    this.extractPaths(inputItems, pathTable);
  }
  // Voice state
  static get kActiveVoice() {
    return 0;
  }
  static get kFreeVoice() {
    return -1;
  }
  static get kReleaseVoice() {
    return -2;
  }
  static get kLegatoVoice() {
    return -3;
  }
  static get kNoVoice() {
    return -4;
  }
  static get VOICE_STOP_LEVEL() {
    return 3162e-8;
  }
  static midiToFreq(note) {
    return 440 * 2 ** ((note - 69) / 12);
  }
  static normalizeVelocity(velocity) {
    return velocity / 127;
  }
  init(sampleRate) {
    this.fAPI.init(this.fDSP, sampleRate);
  }
  instanceInit() {
    this.fAPI.instanceInit(this.fDSP, this.fSampleRate);
  }
  instanceClear() {
    this.fAPI.instanceClear(this.fDSP);
  }
  instanceConstants() {
    this.fAPI.instanceConstants(this.fDSP, this.fSampleRate);
  }
  instanceResetUserInterface() {
    this.fAPI.instanceResetUserInterface(this.fDSP);
  }
  extractPaths(inputItems, pathTable) {
    inputItems.forEach((item) => {
      if (item.endsWith("/gate")) {
        this.fGateLabel.push(pathTable[item]);
      } else if (item.endsWith("/freq")) {
        this.fFreqLabel.push(pathTable[item]);
      } else if (item.endsWith("/key")) {
        this.fKeyLabel.push(pathTable[item]);
      } else if (item.endsWith("/gain")) {
        this.fGainLabel.push(pathTable[item]);
      } else if (item.endsWith("/vel") || item.endsWith("/velocity")) {
        this.fVelLabel.push(pathTable[item]);
      }
    });
  }
  // Public API
  keyOn(pitch, velocity, legato = false) {
    if (legato) {
      this.fNextNote = pitch;
      this.fNextVel = velocity;
    } else {
      this.fFreqLabel.forEach(
        (index) => this.fAPI.setParamValue(
          this.fDSP,
          index,
          _FaustWebAudioDspVoice.midiToFreq(pitch)
        )
      );
      this.fGateLabel.forEach(
        (index) => this.fAPI.setParamValue(this.fDSP, index, 1)
      );
      this.fGainLabel.forEach(
        (index) => this.fAPI.setParamValue(
          this.fDSP,
          index,
          _FaustWebAudioDspVoice.normalizeVelocity(velocity)
        )
      );
      this.fKeyLabel.forEach(
        (index) => this.fAPI.setParamValue(this.fDSP, index, pitch)
      );
      this.fVelLabel.forEach(
        (index) => this.fAPI.setParamValue(this.fDSP, index, velocity)
      );
      this.fCurNote = pitch;
    }
  }
  keyOff(hard = false) {
    this.fGateLabel.forEach(
      (index) => this.fAPI.setParamValue(this.fDSP, index, 0)
    );
    if (hard) {
      this.fCurNote = _FaustWebAudioDspVoice.kFreeVoice;
    } else {
      this.fCurNote = _FaustWebAudioDspVoice.kReleaseVoice;
    }
  }
  computeLegato(bufferSize, $inputs, $outputZero, $outputsHalf) {
    const size = bufferSize >> 1;
    this.fGateLabel.forEach(
      (index) => this.fAPI.setParamValue(this.fDSP, index, 0)
    );
    this.fAPI.compute(this.fDSP, size, $inputs, $outputZero);
    this.keyOn(this.fNextNote, this.fNextVel);
    this.fAPI.compute(this.fDSP, bufferSize - size, $inputs, $outputsHalf);
  }
  compute(bufferSize, $inputs, $outputs) {
    this.fAPI.compute(this.fDSP, bufferSize, $inputs, $outputs);
  }
  setParamValue(index, value) {
    this.fAPI.setParamValue(this.fDSP, index, value);
  }
  getParamValue(index) {
    return this.fAPI.getParamValue(this.fDSP, index);
  }
};
var FaustPolyWebAudioDsp = class _FaustPolyWebAudioDsp extends FaustBaseWebAudioDsp {
  /**
   * @param stopLevel - the level under which a released voice is freed, as a
   * linear amplitude (10^(dB/20)). It is compared to the RMS level of the
   * voice, measured on each block over all its output channels. Defaults to
   * `FaustWebAudioDspVoice.VOICE_STOP_LEVEL` (-90 dB). The accepted range is
   * ]0, 0.01], that is up to -40 dB included: any other value is rejected
   * with a warning, and the default is used. Same as the `stoplevel` of
   * `mydsp_poly` in the C++ poly-dsp.h.
   */
  constructor(instance, sampleRate, sampleSize, bufferSize, soundfiles, stopLevel = FaustWebAudioDspVoice.VOICE_STOP_LEVEL) {
    super(sampleSize, bufferSize, soundfiles);
    this.fMixingBase = [];
    /** Voices whose crossfade this block already rendered in full. */
    this.fStolen = [];
    /** The count last given to `fActiveVoicesHandler`. */
    this.fActiveVoices = 0;
    this.fActiveVoicesHandler = null;
    /** The level under which a released voice is freed (see the constructor). */
    this.fStopLevel = FaustWebAudioDspVoice.VOICE_STOP_LEVEL;
    /**
     * Render one slice: every live voice into the sum, then the effect.
     *
     * The mixer, the voices and the effect all take a frame count, so a slice
     * is the same work over fewer frames. A field rather than an inline
     * closure so it is allocated once instead of on every `compute` call.
     *
     * Two things `compute` does around this. The sum is cleared once for the
     * block, not per slice, because `renderStolenVoices` has already written
     * across the whole of it. And those stolen voices are skipped here.
     *
     * A voice that becomes `kLegatoVoice` partway through the block is not one
     * of them: it plays out the note it is losing and crossfades at the top of
     * the next block, as it did when a `keyOn` could only arrive between
     * blocks.
     */
    this.fRenderSlice = (offset, count) => {
      this.setBufferOffset(offset);
      this.setMixingOffset(offset, count);
      this.fVoiceTable.forEach((voice) => {
        if (voice.fCurNote === FaustWebAudioDspVoice.kFreeVoice) return;
        if (this.fStolen.length && this.fStolen.indexOf(voice) !== -1)
          return;
        voice.compute(count, this.fAudioInputs, this.fAudioMixing);
        const level = this.fInstance.mixerAPI.mixCheckVoice(
          count,
          this.getNumOutputs(),
          this.fAudioMixing,
          this.fAudioOutputs
        );
        if (level > voice.fLevel) voice.fLevel = level;
      });
      if (this.fInstance.effectAPI)
        this.fInstance.effectAPI.compute(
          this.fEffect,
          count,
          this.fAudioOutputs,
          this.fAudioOutputs
        );
    };
    /**
     * When each voice was last allocated, as one global monotonic date.
     *
     * Incrementing the voice's own `fDate` instead, as this used to, made the
     * date a per-slot reuse counter: notes played and released before a chord
     * kept reusing slot 0 and inflating only its date, and when the chord
     * then overflowed the pool, the allocator considered a younger note
     * "oldest" and stole the wrong voice.
     */
    this.fDate = 0;
    this.fInstance = instance;
    this.fSampleRate = sampleRate;
    if (typeof stopLevel === "number" && stopLevel > 0 && stopLevel <= 0.01)
      this.fStopLevel = stopLevel;
    else console.warn(`Invalid stop level ${stopLevel}, using default`);
    this.fJSONDsp = JSON.parse(this.fInstance.voiceJSON);
    this.fMidiChannel = FaustBaseWebAudioDsp.parseMidiChannel(
      this.fJSONDsp.meta
    );
    this.fJSONEffect = this.fInstance.effectAPI && this.fInstance.effectJSON ? JSON.parse(this.fInstance.effectJSON) : null;
    FaustBaseWebAudioDsp.parseUI(this.fJSONDsp.ui, this.fUICallback);
    if (this.fJSONEffect)
      FaustBaseWebAudioDsp.parseUI(this.fJSONEffect.ui, this.fUICallback);
    this.fEndMemory = this.initMemory();
    this.fVoiceTable = [];
    for (let voice = 0; voice < this.fInstance.voices; voice++) {
      this.fVoiceTable.push(
        new FaustWebAudioDspVoice(
          this.fJSONDsp.size * voice,
          this.fInstance.voiceAPI,
          this.fInputsItems,
          this.fPathTable,
          sampleRate
        )
      );
    }
    if (this.fInstance.effectAPI)
      this.fInstance.effectAPI.init(this.fEffect, sampleRate);
    if (this.fSoundfiles.length > 0) {
      const allocator = new WasmAllocator(
        this.fInstance.memory,
        this.fEndMemory
      );
      for (let voice = 0; voice < this.fInstance.voices; voice++) {
        this.initSoundfileMemory(allocator, this.fJSONDsp.size * voice);
      }
    }
  }
  /**
   * Render the stolen voices, each across the whole block.
   *
   * A steal is a hand-over: the voice plays the note it is losing over the
   * first half of the buffer, that half fades out, and the new note plays
   * the second half, faded in. Both fades are needed. `fadeOut` scales the
   * buffer, not the voice: after `keyOn` the DSP carries on from its live
   * state -- an envelope that never reached silence is still up -- so
   * without the fade-in the second half started at full level, a step on
   * every stolen note. On a monophonic patch whose voice never falls
   * silent that is a click on every note after the first (measured on a
   * long-release bass: 0, 0, 0, 0.1485, 0.2618 across the split).
   *
   * The fades have to be half a block -- 64 frames -- rather than half a
   * slice, which late in the block would be a frame or two, or nothing at
   * all. So this runs before the slicing, and `fRenderSlice` skips these
   * voices.
   */
  renderStolenVoices() {
    const stolen = this.fStolen;
    stolen.length = 0;
    this.fVoiceTable.forEach((voice) => {
      if (voice.fCurNote !== FaustWebAudioDspVoice.kLegatoVoice) return;
      stolen.push(voice);
      voice.computeLegato(
        this.fBufferSize,
        this.fAudioInputs,
        this.fAudioMixing,
        this.fAudioMixingHalf
      );
      this.fInstance.mixerAPI.fadeOut(
        this.fBufferSize >> 1,
        this.getNumOutputs(),
        this.fAudioMixing
      );
      this.fadeIn(
        this.fBufferSize - (this.fBufferSize >> 1),
        this.getNumOutputs(),
        this.fAudioMixingHalf
      );
      voice.fLevel = this.fInstance.mixerAPI.mixCheckVoice(
        this.fBufferSize,
        this.getNumOutputs(),
        this.fAudioMixing,
        this.fAudioOutputs
      );
    });
  }
  /**
   * Scale `count` frames of each channel at `$tables` from 1/count up to 1.
   *
   * The mixer has `fadeOut` in wasm; this is its counterpart on the JS
   * side, over the channel-pointer table the same way the mixer reads it.
   */
  fadeIn(count, chans, $tables) {
    const shift = Math.log2(this.fSampleSize);
    const HEAPF = this.fHEAPF;
    for (let chan = 0; chan < chans; chan++) {
      const start = this.fHEAP32[($tables >> 2) + chan] >> shift;
      for (let i = 0; i < count; i++) {
        HEAPF[start + i] *= (i + 1) / count;
      }
    }
  }
  /**
   * Move the mixing tables along with the input and output ones.
   *
   * `fAudioMixing` is where a voice renders before being summed into the
   * output, so it follows the slice. `fAudioMixingHalf` is the crossfade
   * split point, `count >> 1` frames in, matching `computeLegato`. Only
   * `renderStolenVoices` uses it, and always with the whole block.
   */
  setMixingOffset(offset, count) {
    const bytes = offset * this.fSampleSize;
    const half = (offset + (count >> 1)) * this.fSampleSize;
    for (let chan = 0; chan < this.fMixingBase.length; chan++) {
      this.fHEAP32[(this.fAudioMixing >> 2) + chan] = this.fMixingBase[chan] + bytes;
      this.fHEAP32[(this.fAudioMixingHalf >> 2) + chan] = this.fMixingBase[chan] + half;
    }
  }
  init() {
    this.fVoiceTable.forEach((voice) => voice.init(this.fSampleRate));
    if (this.fInstance.effectAPI)
      this.fInstance.effectAPI.init(this.fEffect, this.fSampleRate);
  }
  instanceInit() {
    this.fVoiceTable.forEach((voice) => voice.instanceInit());
    if (this.fInstance.effectAPI)
      this.fInstance.effectAPI.instanceInit(
        this.fEffect,
        this.fSampleRate
      );
  }
  instanceClear() {
    this.fVoiceTable.forEach((voice) => voice.instanceClear());
    if (this.fInstance.effectAPI)
      this.fInstance.effectAPI.instanceClear(this.fEffect);
  }
  instanceConstants() {
    this.fVoiceTable.forEach((voice) => voice.instanceConstants());
    if (this.fInstance.effectAPI)
      this.fInstance.effectAPI.instanceConstants(
        this.fEffect,
        this.fSampleRate
      );
  }
  instanceResetUserInterface() {
    this.fVoiceTable.forEach((voice) => voice.instanceResetUserInterface());
    if (this.fInstance.effectAPI)
      this.fInstance.effectAPI.instanceResetUserInterface(this.fEffect);
  }
  initMemory() {
    this.fEffect = this.fJSONDsp.size * this.fInstance.voices;
    const $audio = this.fEffect + (this.fJSONEffect ? this.fJSONEffect.size : 0);
    this.fAudioInputs = $audio;
    this.fAudioOutputs = this.fAudioInputs + this.getNumInputs() * this.fPtrSize;
    this.fAudioMixing = this.fAudioOutputs + this.getNumOutputs() * this.fPtrSize;
    this.fAudioMixingHalf = this.fAudioMixing + this.getNumOutputs() * this.fPtrSize;
    const $audioInputs = this.fAudioMixingHalf + this.getNumOutputs() * this.fPtrSize;
    const $audioOutputs = $audioInputs + this.getNumInputs() * this.fBufferSize * this.fSampleSize;
    const $audioMixing = $audioOutputs + this.getNumOutputs() * this.fBufferSize * this.fSampleSize;
    const endMemory = $audioMixing + this.getNumOutputs() * this.fBufferSize * this.fSampleSize;
    const HEAP = this.fInstance.memory.buffer;
    const HEAP32 = new Int32Array(HEAP);
    const HEAPF = this.fSampleSize === 4 ? new Float32Array(HEAP) : new Float64Array(HEAP);
    if (this.getNumInputs() > 0) {
      for (let chan = 0; chan < this.getNumInputs(); chan++) {
        HEAP32[(this.fAudioInputs >> 2) + chan] = $audioInputs + this.fBufferSize * this.fSampleSize * chan;
      }
      const dspInChans = HEAP32.subarray(
        this.fAudioInputs >> 2,
        this.fAudioInputs + this.getNumInputs() * this.fPtrSize >> 2
      );
      for (let chan = 0; chan < this.getNumInputs(); chan++) {
        this.fInChannels[chan] = HEAPF.subarray(
          dspInChans[chan] >> Math.log2(this.fSampleSize),
          dspInChans[chan] + this.fBufferSize * this.fSampleSize >> Math.log2(this.fSampleSize)
        );
      }
    }
    if (this.getNumOutputs() > 0) {
      for (let chan = 0; chan < this.getNumOutputs(); chan++) {
        HEAP32[(this.fAudioOutputs >> 2) + chan] = $audioOutputs + this.fBufferSize * this.fSampleSize * chan;
        HEAP32[(this.fAudioMixing >> 2) + chan] = $audioMixing + this.fBufferSize * this.fSampleSize * chan;
        HEAP32[(this.fAudioMixingHalf >> 2) + chan] = $audioMixing + this.fBufferSize * this.fSampleSize * chan + this.fBufferSize / 2 * this.fSampleSize;
      }
      const dspOutChans = HEAP32.subarray(
        this.fAudioOutputs >> 2,
        this.fAudioOutputs + this.getNumOutputs() * this.fPtrSize >> 2
      );
      for (let chan = 0; chan < this.getNumOutputs(); chan++) {
        this.fOutChannels[chan] = HEAPF.subarray(
          dspOutChans[chan] >> Math.log2(this.fSampleSize),
          dspOutChans[chan] + this.fBufferSize * this.fSampleSize >> Math.log2(this.fSampleSize)
        );
      }
    }
    this.fHEAP32 = HEAP32;
    this.fInBase = [];
    for (let chan = 0; chan < this.getNumInputs(); chan++) {
      this.fInBase[chan] = HEAP32[(this.fAudioInputs >> 2) + chan];
    }
    this.fHEAPF = HEAPF;
    this.fOutBase = [];
    this.fMixingBase = [];
    for (let chan = 0; chan < this.getNumOutputs(); chan++) {
      this.fOutBase[chan] = HEAP32[(this.fAudioOutputs >> 2) + chan];
      this.fMixingBase[chan] = HEAP32[(this.fAudioMixing >> 2) + chan];
    }
    return endMemory;
  }
  toString() {
    return `============== Poly Memory layout ==============
        this.fBufferSize: ${this.fBufferSize}
        this.fJSONDsp.size: ${this.fJSONDsp.size}
        this.fAudioInputs: ${this.fAudioInputs}
        this.fAudioOutputs: ${this.fAudioOutputs}
        this.fAudioMixing: ${this.fAudioMixing}
        this.fAudioMixingHalf: ${this.fAudioMixingHalf}`;
  }
  allocVoice(voice, type) {
    this.fVoiceTable[voice].fDate = this.fDate++;
    this.fVoiceTable[voice].fCurNote = type;
    return voice;
  }
  // The same pitch may be played on several channels at once: a note off
  // releases the voice of its own channel
  getPlayingVoice(channel, pitch) {
    let voicePlaying = FaustWebAudioDspVoice.kNoVoice;
    let oldestDatePlaying = Number.MAX_VALUE;
    for (let i = 0; i < this.fInstance.voices; i++) {
      if (this.fVoiceTable[i].fChannel !== channel) continue;
      const curNote = this.fVoiceTable[i].fCurNote;
      const nextNote = this.fVoiceTable[i].fNextNote;
      if (curNote === pitch || curNote === FaustWebAudioDspVoice.kLegatoVoice && nextNote === pitch) {
        if (this.fVoiceTable[i].fDate < oldestDatePlaying) {
          oldestDatePlaying = this.fVoiceTable[i].fDate;
          voicePlaying = i;
        }
      }
    }
    return voicePlaying;
  }
  getFreeVoice() {
    for (let voice = 0; voice < this.fInstance.voices; voice++) {
      if (this.fVoiceTable[voice].fCurNote === FaustWebAudioDspVoice.kFreeVoice) {
        return this.allocVoice(
          voice,
          FaustWebAudioDspVoice.kActiveVoice
        );
      }
    }
    let voiceRelease = FaustWebAudioDspVoice.kNoVoice;
    let voicePlaying = FaustWebAudioDspVoice.kNoVoice;
    let oldestDateRelease = Number.MAX_VALUE;
    let oldestDatePlaying = Number.MAX_VALUE;
    for (let voice = 0; voice < this.fInstance.voices; voice++) {
      if (this.fVoiceTable[voice].fCurNote === FaustWebAudioDspVoice.kReleaseVoice) {
        if (this.fVoiceTable[voice].fDate < oldestDateRelease) {
          oldestDateRelease = this.fVoiceTable[voice].fDate;
          voiceRelease = voice;
        }
      } else if (this.fVoiceTable[voice].fDate < oldestDatePlaying) {
        oldestDatePlaying = this.fVoiceTable[voice].fDate;
        voicePlaying = voice;
      }
    }
    if (oldestDateRelease !== Number.MAX_VALUE) {
      console.log(
        `Steal release voice : voice_date = ${this.fVoiceTable[voiceRelease].fDate} voice = ${voiceRelease}`
      );
      return this.allocVoice(
        voiceRelease,
        FaustWebAudioDspVoice.kLegatoVoice
      );
    }
    if (oldestDatePlaying !== Number.MAX_VALUE) {
      console.log(
        `Steal playing voice : voice_date = ${this.fVoiceTable[voicePlaying].fDate} voice = ${voicePlaying}`
      );
      return this.allocVoice(
        voicePlaying,
        FaustWebAudioDspVoice.kLegatoVoice
      );
    }
    return FaustWebAudioDspVoice.kNoVoice;
  }
  // Public API
  compute(input, output, events) {
    if (this.fDestroyed) return false;
    if (this.fFirstCall) {
      this.initMemory();
      this.fFirstCall = false;
    }
    if (!this.fProcessing) {
      this.applyEvents(events);
      return true;
    }
    if (this.getNumInputs() > 0 && (!input || !input[0] || input[0].length === 0)) {
      this.applyEvents(events);
      return true;
    }
    if (this.getNumOutputs() > 0 && (!output || !output[0] || output[0].length === 0)) {
      this.applyEvents(events);
      return true;
    }
    if (input !== void 0) {
      for (let chan = 0; chan < Math.min(this.getNumInputs(), input.length); ++chan) {
        const dspInput = this.fInChannels[chan];
        dspInput.set(input[chan]);
      }
    }
    if (this.fComputeHandler) this.fComputeHandler(this.fBufferSize);
    this.setBufferOffset(0);
    this.setMixingOffset(0, this.fBufferSize);
    this.fInstance.mixerAPI.clearOutput(
      this.fBufferSize,
      this.getNumOutputs(),
      this.fAudioOutputs
    );
    this.fVoiceTable.forEach((voice) => voice.fLevel = 0);
    this.renderStolenVoices();
    this.renderBlock(events, this.fRenderSlice);
    this.fVoiceTable.forEach((voice) => {
      if (voice.fCurNote === FaustWebAudioDspVoice.kReleaseVoice && voice.fLevel < this.fStopLevel) {
        voice.fCurNote = FaustWebAudioDspVoice.kFreeVoice;
      }
    });
    if (this.fActiveVoicesHandler) {
      const active = this.getNumActiveVoices();
      if (active !== this.fActiveVoices) {
        this.fActiveVoices = active;
        this.fActiveVoicesHandler(active);
      }
    }
    this.updateOutputs();
    this.clearNonFinite();
    if (output !== void 0) {
      for (let chan = 0; chan < Math.min(this.getNumOutputs(), output.length); chan++) {
        const dspOutput = this.fOutChannels[chan];
        output[chan].set(dspOutput);
      }
      if (this.fPlotHandler) {
        this.fPlotHandler(
          output,
          this.fBufferNum++,
          this.fCachedEvents.length ? this.fCachedEvents : void 0
        );
        this.fCachedEvents = [];
      }
    }
    return true;
  }
  getNumInputs() {
    return this.fInstance.voiceAPI.getNumInputs(0);
  }
  getNumOutputs() {
    return this.fInstance.voiceAPI.getNumOutputs(0);
  }
  static findPath(o, p) {
    if (typeof o !== "object") {
      return false;
    } else if (o.address) {
      return o.address === p;
    } else {
      for (const k in o) {
        if (_FaustPolyWebAudioDsp.findPath(o[k], p)) return true;
      }
      return false;
    }
  }
  setParamValue(path, value) {
    const index = this.fPathTable[path];
    if (index === void 0) return this.warnUnknownPath(path, "ignored");
    if (this.fPlotHandler)
      this.fCachedEvents.push({ type: "param", data: { path, value } });
    if (this.fJSONEffect && _FaustPolyWebAudioDsp.findPath(this.fJSONEffect.ui, path) && this.fInstance.effectAPI) {
      this.fInstance.effectAPI.setParamValue(this.fEffect, index, value);
    } else {
      this.fVoiceTable.forEach(
        (voice) => voice.setParamValue(index, value)
      );
    }
    this.callInputParamHandler(path, this.getParamValue(path));
  }
  getParamValue(path) {
    const index = this.fPathTable[path];
    if (index === void 0) {
      this.warnUnknownPath(path, "returning 0");
      return 0;
    }
    if (this.fJSONEffect && _FaustPolyWebAudioDsp.findPath(this.fJSONEffect.ui, path) && this.fInstance.effectAPI) {
      return this.fInstance.effectAPI.getParamValue(this.fEffect, index);
    } else {
      return this.fVoiceTable[0].getParamValue(index);
    }
  }
  getMeta() {
    const o = this.fJSONDsp;
    const e = this.fJSONEffect;
    const r = { ...o };
    if (e) {
      r.ui = [
        {
          type: "tgroup",
          label: "Sequencer",
          items: [
            { type: "vgroup", label: "Instrument", items: o.ui },
            { type: "vgroup", label: "Effect", items: e.ui }
          ]
        }
      ];
    } else {
      r.ui = [
        {
          type: "tgroup",
          label: "Polyphonic",
          items: [{ type: "vgroup", label: "Voices", items: o.ui }]
        }
      ];
    }
    return r;
  }
  getJSON() {
    return JSON.stringify(this.getMeta());
  }
  getUI() {
    return this.getMeta().ui;
  }
  getDescriptors() {
    return this.fDescriptor;
  }
  midiMessage(data) {
    if (!this.acceptMidiStatus(data[0])) return;
    const cmd = data[0] >> 4;
    const channel = data[0] & 15;
    const data1 = data[1];
    const data2 = data[2];
    if (cmd === 8 || cmd === 9 && data2 === 0)
      return this.keyOff(channel, data1, data2);
    else if (cmd === 9) return this.keyOn(channel, data1, data2);
    else super.midiMessage(data);
  }
  // Channel mode messages only end the voices started on their channel, as
  // in the C++ poly-dsp.h: All Notes Off releases them, All Sound Off mutes
  // them at once
  ctrlChange(channel, ctrl, value) {
    if (ctrl === 123) {
      this.channelNotesOff(channel, false);
    } else if (ctrl === 120) {
      this.channelNotesOff(channel, true);
    } else {
      super.ctrlChange(channel, ctrl, value);
    }
  }
  // An indexed loop: reachable from the audio thread, it must not allocate
  channelNotesOff(channel, hard) {
    if (this.fPlotHandler)
      this.fCachedEvents.push({
        type: "ctrlChange",
        data: [channel, hard ? 120 : 123, 0]
      });
    for (let i = 0; i < this.fVoiceTable.length; i++) {
      const voice = this.fVoiceTable[i];
      if (voice.fChannel === channel && voice.fCurNote !== FaustWebAudioDspVoice.kFreeVoice)
        voice.keyOff(hard);
    }
  }
  keyOn(channel, pitch, velocity) {
    if (this.fPlotHandler)
      this.fCachedEvents.push({
        type: "keyOn",
        data: [channel, pitch, velocity]
      });
    const voice = this.getFreeVoice();
    this.fVoiceTable[voice].fChannel = channel;
    this.fVoiceTable[voice].keyOn(
      pitch,
      velocity,
      this.fVoiceTable[voice].fCurNote == FaustWebAudioDspVoice.kLegatoVoice
    );
  }
  keyOff(channel, pitch, velocity) {
    if (this.fPlotHandler)
      this.fCachedEvents.push({
        type: "keyOff",
        data: [channel, pitch, velocity]
      });
    const voice = this.getPlayingVoice(channel, pitch);
    if (voice !== FaustWebAudioDspVoice.kNoVoice) {
      this.fVoiceTable[voice].keyOff();
    } else {
      console.log("Playing pitch = %d not found\n", pitch);
    }
  }
  allNotesOff(hard = true) {
    this.fCachedEvents.push({ type: "ctrlChange", data: [0, 123, 0] });
    this.fVoiceTable.forEach((voice) => voice.keyOff(hard));
  }
  // Same count as dsp_voice_group::getNumActiveVoices() in the C++ poly-dsp.h.
  // An indexed loop: called after every block when a handler is set, it must
  // not allocate an iterator.
  getNumActiveVoices() {
    let count = 0;
    for (let i = 0; i < this.fVoiceTable.length; i++) {
      if (this.fVoiceTable[i].fCurNote !== FaustWebAudioDspVoice.kFreeVoice)
        count++;
    }
    return count;
  }
  /**
   * Call `handler` with the number of sounding voices after each block in
   * which it changed (see `getNumActiveVoices`). The AudioWorklet processor
   * uses it to keep its node's count up to date.
   */
  setActiveVoicesHandler(handler) {
    this.fActiveVoicesHandler = handler;
    this.fActiveVoices = this.getNumActiveVoices();
  }
  getActiveVoicesHandler() {
    return this.fActiveVoicesHandler;
  }
};

// src/FaustOfflineProcessor.ts
var FaustOfflineProcessor = class {
  constructor(instance, bufferSize) {
    this.fDSPCode = instance;
    this.fBufferSize = bufferSize;
    this.fInputs = new Array(this.fDSPCode.getNumInputs()).fill(null).map(() => new Float32Array(bufferSize));
    this.fOutputs = new Array(this.fDSPCode.getNumOutputs()).fill(null).map(() => new Float32Array(bufferSize));
  }
  // Public API
  getParameterDescriptors() {
    const params = [];
    const callback = (item) => {
      let param = null;
      const polyKeywords = [
        "/gate",
        "/freq",
        "/gain",
        "/key",
        "/vel",
        "/velocity"
      ];
      const isPolyReserved = "address" in item && !!polyKeywords.find((k) => item.address.endsWith(k));
      if (this.fDSPCode instanceof FaustMonoWebAudioDsp || !isPolyReserved) {
        if (item.type === "vslider" || item.type === "hslider" || item.type === "nentry") {
          param = {
            name: item.address,
            defaultValue: item.init || 0,
            minValue: item.min || 0,
            maxValue: item.max || 0
          };
        } else if (item.type === "button" || item.type === "checkbox") {
          param = {
            name: item.address,
            defaultValue: item.init || 0,
            minValue: 0,
            maxValue: 1
          };
        }
      }
      if (param) params.push(param);
    };
    FaustBaseWebAudioDsp.parseUI(this.fDSPCode.getUI(), callback);
    return params;
  }
  compute(input, output) {
    return this.fDSPCode.compute(input, output);
  }
  setOutputParamHandler(handler) {
    this.fDSPCode.setOutputParamHandler(handler);
  }
  getOutputParamHandler() {
    return this.fDSPCode.getOutputParamHandler();
  }
  callOutputParamHandler(path, value) {
    this.fDSPCode.callOutputParamHandler(path, value);
  }
  setInputParamHandler(handler) {
    this.fDSPCode.setInputParamHandler(handler);
  }
  getInputParamHandler() {
    return this.fDSPCode.getInputParamHandler();
  }
  callInputParamHandler(path, value) {
    this.fDSPCode.callInputParamHandler(path, value);
  }
  setComputeHandler(handler) {
    this.fDSPCode.setComputeHandler(handler);
  }
  getComputeHandler() {
    return this.fDSPCode.getComputeHandler();
  }
  setPlotHandler(handler) {
    this.fDSPCode.setPlotHandler(handler);
  }
  getPlotHandler() {
    return this.fDSPCode.getPlotHandler();
  }
  setNonFiniteHandler(handler) {
    this.fDSPCode.setNonFiniteHandler(handler);
  }
  getNonFiniteHandler() {
    return this.fDSPCode.getNonFiniteHandler();
  }
  getNumInputs() {
    return this.fDSPCode.getNumInputs();
  }
  getNumOutputs() {
    return this.fDSPCode.getNumOutputs();
  }
  metadata(handler) {
  }
  midiMessage(data) {
    this.fDSPCode.midiMessage(data);
  }
  setMidiChannel(channel) {
    this.fDSPCode.setMidiChannel(channel);
  }
  getMidiChannel() {
    return this.fDSPCode.getMidiChannel();
  }
  ctrlChange(chan, ctrl, value) {
    this.fDSPCode.ctrlChange(chan, ctrl, value);
  }
  pitchWheel(chan, value) {
    this.fDSPCode.pitchWheel(chan, value);
  }
  keyOn(channel, pitch, velocity) {
    this.fDSPCode.keyOn(channel, pitch, velocity);
  }
  keyOff(channel, pitch, velocity) {
    this.fDSPCode.keyOff(channel, pitch, velocity);
  }
  setParamValue(path, value) {
    this.fDSPCode.setParamValue(path, value);
  }
  getParamValue(path) {
    return this.fDSPCode.getParamValue(path);
  }
  getParams() {
    return this.fDSPCode.getParams();
  }
  getMeta() {
    return this.fDSPCode.getMeta();
  }
  getJSON() {
    return this.fDSPCode.getJSON();
  }
  getDescriptors() {
    return this.fDSPCode.getDescriptors();
  }
  getUI() {
    return this.fDSPCode.getUI();
  }
  init() {
    this.fDSPCode.init();
  }
  instanceInit() {
    this.fDSPCode.instanceInit();
  }
  instanceClear() {
    this.fDSPCode.instanceClear();
  }
  instanceConstants() {
    this.fDSPCode.instanceConstants();
  }
  instanceResetUserInterface() {
    this.fDSPCode.instanceResetUserInterface();
  }
  start() {
    this.fDSPCode.start();
  }
  stop() {
    this.fDSPCode.stop();
  }
  destroy() {
    this.fDSPCode.destroy();
  }
  get hasAccInput() {
    return this.fDSPCode.hasAccInput;
  }
  propagateAcc(accelerationIncludingGravity, invert = false) {
    this.fDSPCode.propagateAcc(accelerationIncludingGravity, invert);
  }
  get hasGyrInput() {
    return this.fDSPCode.hasGyrInput;
  }
  propagateGyr(event) {
    this.fDSPCode.propagateGyr(event);
  }
  startSensors() {
  }
  stopSensors() {
  }
  /**
   * Render frames in an array.
   *
   * @param inputs - input signal
   * @param length - the number of frames to render (default: bufferSize)
   * @param onUpdate - a callback after each buffer calculated, with an argument "current sample"
   * @return an array of Float32Array with the rendered frames
   */
  render(inputs = [], length = this.fBufferSize, onUpdate) {
    let l = 0;
    const outputs = new Array(this.fDSPCode.getNumOutputs()).fill(null).map(() => new Float32Array(length));
    this.fDSPCode.start();
    while (l < length) {
      const sliceLength = Math.min(length - l, this.fBufferSize);
      for (let i = 0; i < this.fDSPCode.getNumInputs(); i++) {
        let input;
        if (inputs[i]) {
          if (inputs[i].length <= l) {
            input = new Float32Array(sliceLength);
          } else if (inputs[i].length > l + sliceLength) {
            input = inputs[i].subarray(l, l + sliceLength);
          } else {
            input = inputs[i].subarray(l, inputs[i].length);
          }
        } else {
          input = new Float32Array(sliceLength);
        }
        this.fInputs[i] = input;
      }
      this.fDSPCode.compute(this.fInputs, this.fOutputs);
      for (let i = 0; i < this.fDSPCode.getNumOutputs(); i++) {
        const output = this.fOutputs[i];
        if (sliceLength < this.fBufferSize) {
          outputs[i].set(output.subarray(0, sliceLength), l);
        } else {
          outputs[i].set(output, l);
        }
      }
      l += sliceLength;
      onUpdate == null ? void 0 : onUpdate(l);
    }
    this.fDSPCode.stop();
    return outputs;
  }
};
var FaustMonoOfflineProcessor = class extends FaustOfflineProcessor {
};
var FaustPolyOfflineProcessor = class extends FaustOfflineProcessor {
  keyOn(channel, pitch, velocity) {
    this.fDSPCode.keyOn(channel, pitch, velocity);
  }
  keyOff(channel, pitch, velocity) {
    this.fDSPCode.keyOff(channel, pitch, velocity);
  }
  allNotesOff(hard) {
    this.fDSPCode.allNotesOff(hard);
  }
  // The DSP renders on this thread: the count is always current
  getNumActiveVoices() {
    return this.fDSPCode.getNumActiveVoices();
  }
};
var FaustOfflineProcessor_default = FaustOfflineProcessor;

// src/FaustSvgDiagrams.ts
var FaustSvgDiagrams = class {
  constructor(compiler) {
    this.compiler = compiler;
  }
  from(name, code, args) {
    const fs = this.compiler.fs();
    try {
      const files2 = fs.readdir(`/${name}-svg/`);
      files2.filter((file) => file !== "." && file !== "..").forEach((file) => fs.unlink(`/${name}-svg/${file}`));
    } catch {
    }
    const success = this.compiler.generateAuxFiles(
      name,
      code,
      `-lang wasm -o binary -svg ${args}`
    );
    if (!success) throw new Error(this.compiler.getErrorMessage());
    const svgs = {};
    const files = fs.readdir(`/${name}-svg/`);
    files.filter((file) => file !== "." && file !== "..").forEach(
      (file) => svgs[file] = fs.readFile(`/${name}-svg/${file}`, {
        encoding: "utf8"
      })
    );
    return svgs;
  }
};
var FaustSvgDiagrams_default = FaustSvgDiagrams;

// src/FaustCmajor.ts
var FaustCmajor = class {
  constructor(compiler) {
    this.fCompiler = compiler;
  }
  compile(name, code, args) {
    const fs = this.fCompiler.fs();
    const success = this.fCompiler.generateAuxFiles(
      name,
      code,
      `-lang cmajor-hybrid -cn ${name} -o ${name}.cmajor`
    );
    return success ? fs.readFile(`${name}.cmajor`, { encoding: "utf8" }) : "";
  }
};
var FaustCmajor_default = FaustCmajor;

// src/LibFaust.ts
var LibFaust = class {
  constructor(module) {
    this.fModule = module;
    this.fCompiler = new module.libFaustWasm();
    this.fFileSystem = this.fModule.FS;
  }
  module() {
    return this.fModule;
  }
  fs() {
    return this.fFileSystem;
  }
  version() {
    return this.fCompiler.version();
  }
  createDSPFactory(name, code, args, useInternalMemory) {
    return this.fCompiler.createDSPFactory(
      name,
      code,
      args,
      useInternalMemory
    );
  }
  deleteDSPFactory(cFactory) {
    return this.fCompiler.deleteDSPFactory(cFactory);
  }
  expandDSP(name, code, args) {
    return this.fCompiler.expandDSP(name, code, args);
  }
  generateAuxFiles(name, code, args) {
    return this.fCompiler.generateAuxFiles(name, code, args);
  }
  deleteAllDSPFactories() {
    return this.fCompiler.deleteAllDSPFactories();
  }
  getErrorAfterException() {
    return this.fCompiler.getErrorAfterException();
  }
  cleanupAfterException() {
    return this.fCompiler.cleanupAfterException();
  }
  getInfos(what) {
    return this.fCompiler.getInfos(what);
  }
  toString() {
    return `LibFaust module: ${this.fModule}, compiler: ${this.fCompiler}`;
  }
};
var LibFaust_default = LibFaust;

// src/WavEncoder.ts
var WavEncoder = class {
  static encode(audioBuffer, options) {
    var _a;
    const numberOfChannels = audioBuffer.length;
    const length = audioBuffer[0].length;
    const { shared, float } = options;
    const bitDepth = float ? 32 : ((_a = options.bitDepth) != null ? _a : 0) | 0 || 16;
    const byteDepth = bitDepth >> 3;
    const byteLength = length * numberOfChannels * byteDepth;
    const AB = shared ? globalThis.SharedArrayBuffer || globalThis.ArrayBuffer : globalThis.ArrayBuffer;
    const ab = new AB((44 + byteLength) * Uint8Array.BYTES_PER_ELEMENT);
    const dataView = new DataView(ab);
    const writer = new Writer(dataView);
    const format = {
      formatId: float ? 3 : 1,
      float: !!float,
      numberOfChannels,
      sampleRate: options.sampleRate,
      symmetric: !!options.symmetric,
      length,
      bitDepth,
      byteDepth
    };
    this.writeHeader(writer, format);
    this.writeData(writer, audioBuffer, format);
    return ab;
  }
  static writeHeader(writer, format) {
    const {
      formatId,
      sampleRate,
      bitDepth,
      numberOfChannels,
      length,
      byteDepth
    } = format;
    writer.string("RIFF");
    writer.uint32(writer.dataView.byteLength - 8);
    writer.string("WAVE");
    writer.string("fmt ");
    writer.uint32(16);
    writer.uint16(formatId);
    writer.uint16(numberOfChannels);
    writer.uint32(sampleRate);
    writer.uint32(sampleRate * numberOfChannels * byteDepth);
    writer.uint16(numberOfChannels * byteDepth);
    writer.uint16(bitDepth);
    writer.string("data");
    writer.uint32(length * numberOfChannels * byteDepth);
    return writer.pos;
  }
  static writeData(writer, audioBuffer, format) {
    const { bitDepth, float, length, numberOfChannels, symmetric } = format;
    if (bitDepth === 32 && float) {
      const { dataView, pos } = writer;
      const ab = dataView.buffer;
      const f32View = new Float32Array(ab, pos);
      if (numberOfChannels === 1) {
        f32View.set(audioBuffer[0]);
        return;
      }
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const channel = audioBuffer[ch];
        for (let i = 0; i < length; i++) {
          f32View[i * numberOfChannels + ch] = channel[i];
        }
      }
      return;
    }
    const encoderOption = float ? "f" : symmetric ? "s" : "";
    const methodName = "pcm" + bitDepth + encoderOption;
    if (!writer[methodName]) {
      throw new TypeError("Not supported bit depth: " + bitDepth);
    }
    const write = writer[methodName].bind(
      writer
    );
    for (let i = 0; i < length; i++) {
      for (let j = 0; j < numberOfChannels; j++) {
        write(audioBuffer[j][i]);
      }
    }
  }
};
var Writer = class {
  constructor(dataView) {
    this.pos = 0;
    this.dataView = dataView;
  }
  int16(value) {
    this.dataView.setInt16(this.pos, value, true);
    this.pos += 2;
  }
  uint16(value) {
    this.dataView.setUint16(this.pos, value, true);
    this.pos += 2;
  }
  uint32(value) {
    this.dataView.setUint32(this.pos, value, true);
    this.pos += 4;
  }
  string(value) {
    for (let i = 0, imax = value.length; i < imax; i++) {
      this.dataView.setUint8(this.pos++, value.charCodeAt(i));
    }
  }
  pcm8(valueIn) {
    let value = valueIn;
    value = Math.max(-1, Math.min(value, 1));
    value = (value * 0.5 + 0.5) * 255;
    value = Math.round(value) | 0;
    this.dataView.setUint8(
      this.pos,
      value
      /* , true*/
    );
    this.pos += 1;
  }
  pcm8s(valueIn) {
    let value = valueIn;
    value = Math.round(value * 128) + 128;
    value = Math.max(0, Math.min(value, 255));
    this.dataView.setUint8(
      this.pos,
      value
      /* , true*/
    );
    this.pos += 1;
  }
  pcm16(valueIn) {
    let value = valueIn;
    value = Math.max(-1, Math.min(value, 1));
    value = value < 0 ? value * 32768 : value * 32767;
    value = Math.round(value) | 0;
    this.dataView.setInt16(this.pos, value, true);
    this.pos += 2;
  }
  pcm16s(valueIn) {
    let value = valueIn;
    value = Math.round(value * 32768);
    value = Math.max(-32768, Math.min(value, 32767));
    this.dataView.setInt16(this.pos, value, true);
    this.pos += 2;
  }
  pcm24(valueIn) {
    let value = valueIn;
    value = Math.max(-1, Math.min(value, 1));
    value = value < 0 ? 16777216 + value * 8388608 : value * 8388607;
    value = Math.round(value) | 0;
    const x0 = value >> 0 & 255;
    const x1 = value >> 8 & 255;
    const x2 = value >> 16 & 255;
    this.dataView.setUint8(this.pos + 0, x0);
    this.dataView.setUint8(this.pos + 1, x1);
    this.dataView.setUint8(this.pos + 2, x2);
    this.pos += 3;
  }
  pcm24s(valueIn) {
    let value = valueIn;
    value = Math.round(value * 8388608);
    value = Math.max(-8388608, Math.min(value, 8388607));
    const x0 = value >> 0 & 255;
    const x1 = value >> 8 & 255;
    const x2 = value >> 16 & 255;
    this.dataView.setUint8(this.pos + 0, x0);
    this.dataView.setUint8(this.pos + 1, x1);
    this.dataView.setUint8(this.pos + 2, x2);
    this.pos += 3;
  }
  pcm32(valueIn) {
    let value = valueIn;
    value = Math.max(-1, Math.min(value, 1));
    value = value < 0 ? value * 2147483648 : value * 2147483647;
    value = Math.round(value) | 0;
    this.dataView.setInt32(this.pos, value, true);
    this.pos += 4;
  }
  pcm32s(valueIn) {
    let value = valueIn;
    value = Math.round(value * 2147483648);
    value = Math.max(-2147483648, Math.min(value, 2147483647));
    this.dataView.setInt32(this.pos, value, true);
    this.pos += 4;
  }
  pcm32f(value) {
    this.dataView.setFloat32(this.pos, value, true);
    this.pos += 4;
  }
};
var WavEncoder_default = WavEncoder;

// src/WavDecoder.ts
var WavDecoder = class {
  // ArrayBufferLike, not ArrayBuffer: DataView takes either, and
  // WavEncoder.encode returns a SharedArrayBuffer under its `shared`
  // option -- so the encode/decode round trip, which is what
  // faust2sndfile -in does, could not type-check.
  static decode(buffer, options) {
    const dataView = new DataView(buffer);
    const reader = new Reader(dataView);
    if (reader.string(4) !== "RIFF") {
      throw new TypeError("Invalid WAV file");
    }
    reader.uint32();
    if (reader.string(4) !== "WAVE") {
      throw new TypeError("Invalid WAV file");
    }
    let format = null;
    let audioData = null;
    do {
      const chunkType = reader.string(4);
      const chunkSize = reader.uint32();
      if (chunkType === "fmt ") {
        format = this.decodeFormat(reader, chunkSize);
      } else if (chunkType === "data") {
        audioData = this.decodeData(
          reader,
          chunkSize,
          format,
          options || {}
        );
      } else {
        reader.skip(chunkSize);
      }
    } while (audioData === null);
    return audioData;
  }
  static decodeFormat(reader, chunkSize) {
    const formats = {
      1: "lpcm",
      3: "lpcm"
    };
    const formatId = reader.uint16();
    if (!Object.prototype.hasOwnProperty.call(formats, formatId)) {
      throw new TypeError(
        "Unsupported format in WAV file: 0x" + formatId.toString(16)
      );
    }
    const format = {
      formatId,
      float: formatId === 3,
      numberOfChannels: reader.uint16(),
      sampleRate: reader.uint32(),
      byteRate: reader.uint32(),
      blockSize: reader.uint16(),
      bitDepth: reader.uint16()
    };
    reader.skip(chunkSize - 16);
    return format;
  }
  static decodeData(reader, chunkSizeIn, format, options) {
    const chunkSize = Math.min(chunkSizeIn, reader.remain());
    const length = Math.floor(chunkSize / format.blockSize);
    const numberOfChannels = format.numberOfChannels;
    const sampleRate = format.sampleRate;
    const channelData = new Array(numberOfChannels);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const AB = options.shared ? globalThis.SharedArrayBuffer || globalThis.ArrayBuffer : globalThis.ArrayBuffer;
      const ab = new AB(length * Float32Array.BYTES_PER_ELEMENT);
      channelData[ch] = new Float32Array(ab);
    }
    this.readPCM(reader, channelData, length, format, options);
    return {
      numberOfChannels,
      length,
      sampleRate,
      channelData
    };
  }
  static readPCM(reader, channelData, length, format, options) {
    const bitDepth = format.bitDepth;
    const decoderOption = format.float ? "f" : options.symmetric ? "s" : "";
    const methodName = "pcm" + bitDepth + decoderOption;
    if (!reader[methodName]) {
      throw new TypeError("Not supported bit depth: " + format.bitDepth);
    }
    const read = reader[methodName].bind(reader);
    const numberOfChannels = format.numberOfChannels;
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numberOfChannels; ch++) {
        channelData[ch][i] = read();
      }
    }
  }
};
var Reader = class {
  constructor(dataView) {
    this.pos = 0;
    this.dataView = dataView;
  }
  remain() {
    return this.dataView.byteLength - this.pos;
  }
  skip(n) {
    this.pos += n;
  }
  uint8() {
    const data = this.dataView.getUint8(this.pos);
    this.pos += 1;
    return data;
  }
  int16() {
    const data = this.dataView.getInt16(this.pos, true);
    this.pos += 2;
    return data;
  }
  uint16() {
    const data = this.dataView.getUint16(this.pos, true);
    this.pos += 2;
    return data;
  }
  uint32() {
    const data = this.dataView.getUint32(this.pos, true);
    this.pos += 4;
    return data;
  }
  string(n) {
    let data = "";
    for (let i = 0; i < n; i++) {
      data += String.fromCharCode(this.uint8());
    }
    return data;
  }
  pcm8() {
    const data = this.dataView.getUint8(this.pos) - 128;
    this.pos += 1;
    return data < 0 ? data / 128 : data / 127;
  }
  pcm8s() {
    const data = this.dataView.getUint8(this.pos) - 127.5;
    this.pos += 1;
    return data / 127.5;
  }
  pcm16() {
    const data = this.dataView.getInt16(this.pos, true);
    this.pos += 2;
    return data < 0 ? data / 32768 : data / 32767;
  }
  pcm16s() {
    const data = this.dataView.getInt16(this.pos, true);
    this.pos += 2;
    return data / 32768;
  }
  pcm24() {
    const x0 = this.dataView.getUint8(this.pos + 0);
    const x1 = this.dataView.getUint8(this.pos + 1);
    const x2 = this.dataView.getUint8(this.pos + 2);
    const xx = x0 + (x1 << 8) + (x2 << 16);
    const data = xx >= 8388608 ? xx - 16777216 : xx;
    this.pos += 3;
    return data < 0 ? data / 8388608 : data / 8388607;
  }
  pcm24s() {
    const x0 = this.dataView.getUint8(this.pos + 0);
    const x1 = this.dataView.getUint8(this.pos + 1);
    const x2 = this.dataView.getUint8(this.pos + 2);
    const xx = x0 + (x1 << 8) + (x2 << 16);
    const data = xx >= 8388608 ? xx - 16777216 : xx;
    this.pos += 3;
    return data / 8388608;
  }
  pcm32() {
    const data = this.dataView.getInt32(this.pos, true);
    this.pos += 4;
    return data < 0 ? data / 2147483648 : data / 2147483647;
  }
  pcm32s() {
    const data = this.dataView.getInt32(this.pos, true);
    this.pos += 4;
    return data / 2147483648;
  }
  pcm32f() {
    const data = this.dataView.getFloat32(this.pos, true);
    this.pos += 4;
    return data;
  }
  pcm64f() {
    const data = this.dataView.getFloat64(this.pos, true);
    this.pos += 8;
    return data;
  }
};
var WavDecoder_default = WavDecoder;

// src/SoundfileReader.ts
var SoundfileReader = class {
  /**
   * Set fallback base URLs used to resolve soundfile paths.
   *
   * In Node or other non-browser runtimes, `location` may be undefined;
   * in that case this returns an empty list to avoid resolution errors.
   */
  static get fallbackPaths() {
    const loc = typeof location !== "undefined" ? location : null;
    const href = loc == null ? void 0 : loc.href;
    const origin = loc == null ? void 0 : loc.origin;
    const parent = href ? this.getParentUrl(href) : null;
    return [href, parent, origin].filter(
      (value) => typeof value === "string" && value.length > 0
    );
  }
  /**
   * Extract the parent URL from an URL.
   * @param url : the URL
   * @returns : the parent URL
   */
  static getParentUrl(url) {
    return url.substring(0, url.lastIndexOf("/") + 1);
  }
  /**
   * Convert an audio buffer to audio data.
   *
   * @param audioBuffer : the audio buffer to convert
   * @returns : the audio data
   */
  static toAudioData(audioBuffer) {
    const { sampleRate, numberOfChannels } = audioBuffer;
    return {
      sampleRate,
      audioBuffer: new Array(numberOfChannels).fill(null).map((v, i) => audioBuffer.getChannelData(i))
    };
  }
  static isWaveFile(buffer) {
    if (buffer.byteLength < 12) return false;
    const reader = new DataView(buffer);
    const riff = reader.getUint8(0) === 82 && reader.getUint8(1) === 73 && reader.getUint8(2) === 70 && reader.getUint8(3) === 70;
    const wave = reader.getUint8(8) === 87 && reader.getUint8(9) === 65 && reader.getUint8(10) === 86 && reader.getUint8(11) === 69;
    return riff && wave;
  }
  static decodeWaveFile(buffer) {
    const decoded = WavDecoder_default.decode(buffer);
    return {
      sampleRate: decoded.sampleRate,
      audioBuffer: decoded.channelData
    };
  }
  /**
   * Extract the URLs from the metadata.
   *
   * @param dspMeta : the metadata
   * @returns : the URLs
   */
  static findSoundfilesFromMeta(dspMeta) {
    const soundfiles = {};
    const callback = (item) => {
      if (item.type === "soundfile") {
        const urls = FaustBaseWebAudioDsp.splitSoundfileNames(item.url);
        urls.filter((url) => url.trim().length > 0).forEach(
          (url) => soundfiles[url] = null
        );
      }
    };
    FaustBaseWebAudioDsp.parseUI(dspMeta.ui, callback);
    return soundfiles;
  }
  /**
   * Fetch the soundfile.
   *
   * @param url : the url of the soundfile
   * @param audioCtx : the audio context
   * @returns : the audio data
   */
  static async fetchSoundfile(url, audioCtx) {
    console.log(`Loading sound file from ${url}`);
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(
        `Failed to load sound file from ${url}: ${response.statusText}`
      );
    const arrayBuffer = await response.arrayBuffer();
    if (this.isWaveFile(arrayBuffer)) {
      try {
        return this.decodeWaveFile(arrayBuffer);
      } catch (error) {
        console.error(error);
      }
    }
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    return this.toAudioData(audioBuffer);
  }
  /**
   * Load the soundfile.
   *
   * @param filename : the filename
   * @param metaUrls : the metadata URLs
   * @param soundfiles : the soundfiles
   * @param audioCtx : the audio context
   */
  static async loadSoundfile(filename, metaUrls, soundfiles, audioCtx) {
    if (soundfiles == null ? void 0 : soundfiles[filename]) return;
    const urlsToCheck = [
      filename,
      ...[...metaUrls, ...this.fallbackPaths].map(
        (path) => new URL(filename, path.endsWith("/") ? path : `${path}/`).href
      )
    ];
    let lastError = null;
    for (const url of urlsToCheck) {
      try {
        soundfiles[filename] = await this.fetchSoundfile(
          url,
          audioCtx
        );
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `Failed to load sound file ${filename}, all check failed. Last error: ${String(lastError)}`
    );
  }
  /**
   * Load the soundfiles, public API.
   *
   * @param dspMeta : the metadata
   * @param soundfilesIn : the soundfiles
   * @param audioCtx : the audio context
   * @returns : the soundfiles
   */
  static async loadSoundfiles(dspMeta, soundfilesIn, audioCtx) {
    const metaUrls = FaustBaseWebAudioDsp.extractUrlsFromMeta(dspMeta);
    const soundfiles = this.findSoundfilesFromMeta(dspMeta);
    for (const id in soundfiles) {
      if (soundfilesIn == null ? void 0 : soundfilesIn[id]) {
        soundfiles[id] = soundfilesIn[id];
        continue;
      }
      try {
        await this.loadSoundfile(id, metaUrls, soundfiles, audioCtx);
      } catch (error) {
        console.error(error);
      }
    }
    return soundfiles;
  }
};
var SoundfileReader_default = SoundfileReader;

// src/FaustAudioWorkletCommunicator.ts
var FaustAudioWorkletCommunicator = class {
  constructor(port) {
    this.port = port;
    this.supportSharedArrayBuffer = !!globalThis.SharedArrayBuffer;
    this.byteLength = 4 * Uint8Array.BYTES_PER_ELEMENT + 3 * Float32Array.BYTES_PER_ELEMENT + 3 * Float32Array.BYTES_PER_ELEMENT;
  }
  initializeBuffer(ab) {
    let ptr = 0;
    this.uin8Invert = new Uint8ClampedArray(ab, ptr, 1);
    ptr += Uint8ClampedArray.BYTES_PER_ELEMENT;
    this.uin8NewAccData = new Uint8ClampedArray(ab, ptr, 1);
    ptr += Uint8ClampedArray.BYTES_PER_ELEMENT;
    this.uin8NewGyrData = new Uint8ClampedArray(ab, ptr, 1);
    ptr += Uint8ClampedArray.BYTES_PER_ELEMENT;
    ptr += Uint8ClampedArray.BYTES_PER_ELEMENT;
    this.f32Acc = new Float32Array(ab, ptr, 3);
    ptr += 3 * Float32Array.BYTES_PER_ELEMENT;
    this.f32Gyr = new Float32Array(ab, ptr, 3);
    ptr += 3 * Float32Array.BYTES_PER_ELEMENT;
  }
  setNewAccDataAvailable(value) {
    if (!this.uin8NewAccData) return;
    this.uin8NewAccData[0] = +value;
  }
  getNewAccDataAvailable() {
    var _a;
    return !!((_a = this.uin8NewAccData) == null ? void 0 : _a[0]);
  }
  setNewGyrDataAvailable(value) {
    if (!this.uin8NewGyrData) return;
    this.uin8NewGyrData[0] = +value;
  }
  getNewGyrDataAvailable() {
    var _a;
    return !!((_a = this.uin8NewGyrData) == null ? void 0 : _a[0]);
  }
  setAcc({ x, y, z }, invert = false) {
    if (!this.supportSharedArrayBuffer) {
      const e = { type: "acc", data: { x, y, z }, invert };
      this.port.postMessage(e);
    }
    if (!this.uin8NewAccData) return;
    this.uin8Invert[0] = +invert;
    this.f32Acc[0] = x;
    this.f32Acc[1] = y;
    this.f32Acc[2] = z;
    this.uin8NewAccData[0] = 1;
  }
  getAcc() {
    if (!this.uin8NewAccData) return;
    const invert = !!this.uin8Invert[0];
    const [x, y, z] = this.f32Acc;
    return { x, y, z, invert };
  }
  setGyr({
    alpha,
    beta,
    gamma
  }) {
    if (!this.supportSharedArrayBuffer) {
      const e = { type: "gyr", data: { alpha, beta, gamma } };
      this.port.postMessage(e);
    }
    if (!this.uin8NewGyrData) return;
    this.f32Gyr[0] = alpha;
    this.f32Gyr[1] = beta;
    this.f32Gyr[2] = gamma;
    this.uin8NewGyrData[0] = 1;
  }
  getGyr() {
    if (!this.uin8NewGyrData) return;
    const [alpha, beta, gamma] = this.f32Gyr;
    return { alpha, beta, gamma };
  }
};
var FaustAudioWorkletNodeCommunicator = class extends FaustAudioWorkletCommunicator {
  constructor(port) {
    super(port);
    if (this.supportSharedArrayBuffer) {
      const sab = new SharedArrayBuffer(this.byteLength);
      this.initializeBuffer(sab);
      this.port.postMessage({ type: "initSab", sab });
    } else {
      const ab = new ArrayBuffer(this.byteLength);
      this.initializeBuffer(ab);
    }
  }
};
var FaustAudioWorkletProcessorCommunicator = class extends FaustAudioWorkletCommunicator {
  constructor(port) {
    super(port);
    if (this.supportSharedArrayBuffer) {
      this.port.addEventListener("message", (event) => {
        const { data } = event;
        if (data.type === "initSab") {
          this.initializeBuffer(data.sab);
        }
      });
    } else {
      const ab = new ArrayBuffer(this.byteLength);
      this.initializeBuffer(ab);
      this.port.addEventListener("message", (event) => {
        const msg = event.data;
        switch (msg.type) {
          // Sensors messages
          case "acc": {
            this.setAcc(msg.data, msg.invert);
            break;
          }
          case "gyr": {
            this.setGyr(msg.data);
            break;
          }
          default:
            break;
        }
      });
    }
  }
};

// src/FaustAudioWorkletNode.ts
var _hasAccInput, _hasGyrInput;
var FaustAudioWorkletNode = class extends (globalThis.AudioWorkletNode || null) {
  constructor(context, name, factory, options = {}) {
    const JSONObj = JSON.parse(factory.json);
    super(context, name, {
      numberOfInputs: JSONObj.inputs > 0 ? 1 : 0,
      numberOfOutputs: JSONObj.outputs > 0 ? 1 : 0,
      channelCount: Math.max(1, JSONObj.inputs),
      outputChannelCount: [JSONObj.outputs],
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: options.processorOptions,
      ...options
    });
    /** Received MIDI channel, as last sent to the processor. */
    this.fMidiChannel = 0;
    __privateAdd(this, _hasAccInput, false);
    __privateAdd(this, _hasGyrInput, false);
    this.handleMessageAux = (e) => {
      if (e.data.type === "out-param" && this.fOutputHandler) {
        this.fOutputHandler(e.data.path, e.data.value);
      } else if (e.data.type === "in-param" && this.fInputHandler) {
        this.fInputHandler(e.data.path, e.data.value);
      } else if (e.data.type === "plot" && this.fPlotHandler) {
        this.fPlotHandler(e.data.value, e.data.index, e.data.events);
      } else if (e.data.type === "nonfinite" && this.fNonFiniteHandler) {
        this.fNonFiniteHandler();
      }
    };
    // Accelerometer and gyroscope handlers
    this.handleDeviceMotion = ({
      accelerationIncludingGravity
    }) => {
      const isAndroid = /Android/i.test(navigator.userAgent);
      if (!accelerationIncludingGravity) return;
      const { x, y, z } = accelerationIncludingGravity;
      this.propagateAcc({ x, y, z }, isAndroid);
    };
    this.handleDeviceOrientation = ({
      alpha,
      beta,
      gamma
    }) => {
      this.propagateGyr({ alpha, beta, gamma });
    };
    this.fJSONDsp = JSONObj;
    this.fJSON = factory.json;
    this.fMidiChannel = FaustBaseWebAudioDsp.parseMidiChannel(
      this.fJSONDsp.meta
    );
    this.fOutputHandler = null;
    this.fInputHandler = null;
    this.fComputeHandler = null;
    this.fPlotHandler = null;
    this.fNonFiniteHandler = null;
    this.fDescriptor = [];
    this.fParamAliases = {};
    this.fInputsItems = [];
    this.fUICallback = (item) => {
      if (item.type === "vslider" || item.type === "hslider" || item.type === "button" || item.type === "checkbox" || item.type === "nentry") {
        this.fInputsItems.push(item.address);
        this.fDescriptor.push(item);
        const registerAlias = (alias) => {
          if (!this.fParamAliases[alias]) {
            this.fParamAliases[alias] = item.address;
          }
        };
        registerAlias(item.shortname);
        registerAlias(item.label);
        if (!item.meta) return;
        item.meta.forEach((meta) => {
          const { acc, gyr } = meta;
          if (acc) __privateSet(this, _hasAccInput, true);
          if (gyr) __privateSet(this, _hasGyrInput, true);
        });
      }
    };
    FaustBaseWebAudioDsp.parseUI(this.fJSONDsp.ui, this.fUICallback);
    this.fCommunicator = new FaustAudioWorkletNodeCommunicator(this.port);
    this.port.addEventListener("message", this.handleMessageAux);
    this.port.start();
  }
  // Public API
  /** Setup accelerometer and gyroscope handlers */
  async startSensors() {
    if (this.hasAccInput) {
      if (window.DeviceMotionEvent) {
        window.addEventListener(
          "devicemotion",
          this.handleDeviceMotion,
          true
        );
      } else {
        console.log("Cannot set the accelerometer handler.");
      }
    }
    if (this.hasGyrInput) {
      if (window.DeviceMotionEvent) {
        window.addEventListener(
          "deviceorientation",
          this.handleDeviceOrientation,
          true
        );
      } else {
        console.log("Cannot set the gyroscope handler.");
      }
    }
  }
  stopSensors() {
    if (this.hasAccInput) {
      window.removeEventListener(
        "devicemotion",
        this.handleDeviceMotion,
        true
      );
    }
    if (this.hasGyrInput) {
      window.removeEventListener(
        "deviceorientation",
        this.handleDeviceOrientation,
        true
      );
    }
  }
  setOutputParamHandler(handler) {
    this.fOutputHandler = handler;
  }
  getOutputParamHandler() {
    return this.fOutputHandler;
  }
  callOutputParamHandler(path, value) {
    if (this.fOutputHandler) {
      this.fOutputHandler(path, value);
    }
  }
  setInputParamHandler(handler) {
    this.fInputHandler = handler;
  }
  getInputParamHandler() {
    return this.fInputHandler;
  }
  callInputParamHandler(path, value) {
    if (this.fInputHandler) {
      this.fInputHandler(path, value);
    }
  }
  setComputeHandler(handler) {
    this.fComputeHandler = handler;
  }
  getComputeHandler() {
    return this.fComputeHandler;
  }
  setPlotHandler(handler) {
    this.fPlotHandler = handler;
    if (this.fPlotHandler) {
      this.port.postMessage({ type: "setPlotHandler", data: true });
    } else {
      this.port.postMessage({ type: "setPlotHandler", data: false });
    }
  }
  getPlotHandler() {
    return this.fPlotHandler;
  }
  setNonFiniteHandler(handler) {
    this.fNonFiniteHandler = handler;
    this.port.postMessage({
      type: "setNonFiniteHandler",
      data: !!this.fNonFiniteHandler
    });
  }
  getNonFiniteHandler() {
    return this.fNonFiniteHandler;
  }
  setupWamEventHandler() {
    this.port.postMessage({ type: "setupWamEventHandler" });
  }
  getNumInputs() {
    return this.fJSONDsp.inputs;
  }
  getNumOutputs() {
    return this.fJSONDsp.outputs;
  }
  // Implemented in subclasses
  compute(inputs, outputs) {
    return false;
  }
  metadata(handler) {
    if (this.fJSONDsp.meta) {
      this.fJSONDsp.meta.forEach(
        (meta) => handler(Object.keys(meta)[0], meta[Object.keys(meta)[0]])
      );
    }
  }
  /**
   * `time` is in AudioContext seconds, the clock `AudioParam` methods take.
   *
   * With a time, the processor holds the message until the block containing
   * that instant and applies it on the exact sample. Without one, it is
   * applied on arrival.
   *
   * A time already in the past is late, not rejected: the message happens at
   * the top of the next block. `setParamValue` is the exception -- it also
   * writes an `AudioParam`, and `setValueAtTime` throws on a negative time.
   */
  midiMessage(data, time) {
    this.port.postMessage({ type: "midi", data, time });
  }
  setMidiChannel(channel) {
    this.fMidiChannel = Number.isInteger(channel) && channel >= 0 && channel <= 16 ? channel : 0;
    this.port.postMessage({ type: "midiChannel", data: this.fMidiChannel });
  }
  getMidiChannel() {
    return this.fMidiChannel;
  }
  ctrlChange(channel, ctrl, value, time) {
    const e = { type: "ctrlChange", data: [channel, ctrl, value], time };
    this.port.postMessage(e);
  }
  pitchWheel(channel, wheel, time) {
    const e = { type: "pitchWheel", data: [channel, wheel], time };
    this.port.postMessage(e);
  }
  keyOn(channel, pitch, velocity, time) {
    const e = { type: "keyOn", data: [channel, pitch, velocity], time };
    this.port.postMessage(e);
  }
  keyOff(channel, pitch, velocity, time) {
    const e = { type: "keyOff", data: [channel, pitch, velocity], time };
    this.port.postMessage(e);
  }
  get hasAccInput() {
    return __privateGet(this, _hasAccInput);
  }
  propagateAcc(accelerationIncludingGravity, invert = false) {
    if (!accelerationIncludingGravity) return;
    const { x, y, z } = accelerationIncludingGravity;
    this.fCommunicator.setAcc({ x, y, z }, invert);
  }
  get hasGyrInput() {
    return __privateGet(this, _hasGyrInput);
  }
  propagateGyr(event) {
    if (!event) return;
    const { alpha, beta, gamma } = event;
    this.fCommunicator.setGyr({
      alpha,
      beta,
      gamma
    });
  }
  /**
   * `time` is in AudioContext seconds; see `midiMessage`.
   *
   * Unlike a note, a negative `time` throws instead of arriving late, and
   * nothing is sent. `AudioParam.setValueAtTime` is what rejects it, which
   * is why that call comes first.
   */
  setParamValue(path, value, time) {
    const resolved = this.fParamAliases[path] || path;
    const param = this.parameters.get(resolved);
    if (param)
      param.setValueAtTime(value, time != null ? time : this.context.currentTime);
    this.port.postMessage({
      type: "param",
      data: { path: resolved, value },
      time
    });
  }
  getParamValue(path) {
    const resolved = this.fParamAliases[path] || path;
    const param = this.parameters.get(resolved);
    return param ? param.value : 0;
  }
  getParams() {
    return this.fInputsItems;
  }
  getMeta() {
    return this.fJSONDsp;
  }
  getJSON() {
    return JSON.stringify(this.getMeta());
  }
  getUI() {
    return this.fJSONDsp.ui;
  }
  getDescriptors() {
    return this.fDescriptor;
  }
  init() {
    this.port.postMessage({ type: "init" });
  }
  instanceInit() {
    this.port.postMessage({ type: "instanceInit" });
  }
  instanceClear() {
    this.port.postMessage({ type: "instanceClear" });
  }
  instanceConstants() {
    this.port.postMessage({ type: "instanceConstants" });
  }
  instanceResetUserInterface() {
    this.port.postMessage({ type: "instanceResetUserInterface" });
  }
  start() {
    this.port.postMessage({ type: "start" });
  }
  stop() {
    this.port.postMessage({ type: "stop" });
  }
  destroy() {
    this.port.postMessage({ type: "destroy" });
    this.port.close();
  }
};
_hasAccInput = new WeakMap();
_hasGyrInput = new WeakMap();
var FaustMonoAudioWorkletNode = class extends FaustAudioWorkletNode {
  constructor(context, options) {
    super(
      context,
      options.processorOptions.name,
      options.processorOptions.factory,
      options
    );
    this.onprocessorerror = (e) => {
      throw e;
    };
  }
};
var FaustPolyAudioWorkletNode = class extends FaustAudioWorkletNode {
  constructor(context, options) {
    super(
      context,
      options.processorOptions.name,
      options.processorOptions.voiceFactory,
      options
    );
    /** The number of sounding voices, as last reported by the processor. */
    this.fNumActiveVoices = 0;
    this.onprocessorerror = (e) => {
      throw e;
    };
    this.handleActiveVoices = (e) => {
      if (e.data.type === "active-voices")
        this.fNumActiveVoices = e.data.value;
    };
    this.fJSONEffect = options.processorOptions.effectFactory ? JSON.parse(options.processorOptions.effectFactory.json) : null;
    if (this.fJSONEffect) {
      FaustBaseWebAudioDsp.parseUI(this.fJSONEffect.ui, this.fUICallback);
    }
    this.port.addEventListener("message", this.handleActiveVoices);
  }
  // Public API
  // `keyOn` and `keyOff` are inherited: the base posts the same message,
  // which the processor routes to the polyphonic DSP.
  allNotesOff(hard) {
    const e = { type: "allNotesOff", data: hard };
    this.port.postMessage(e);
  }
  // The DSP runs on the audio thread, which reports the count when it
  // changes: this is its value at the end of the latest such block
  getNumActiveVoices() {
    return this.fNumActiveVoices;
  }
  getMeta() {
    const o = this.fJSONDsp;
    const e = this.fJSONEffect;
    const r = { ...o };
    if (e) {
      r.ui = [
        {
          type: "tgroup",
          label: "Sequencer",
          items: [
            { type: "vgroup", label: "Instrument", items: o.ui },
            { type: "vgroup", label: "Effect", items: e.ui }
          ]
        }
      ];
    } else {
      r.ui = [
        {
          type: "tgroup",
          label: "Polyphonic",
          items: [{ type: "vgroup", label: "Voices", items: o.ui }]
        }
      ];
    }
    return r;
  }
  getJSON() {
    return JSON.stringify(this.getMeta());
  }
  getUI() {
    return this.getMeta().ui;
  }
};

// src/FaustScriptProcessorNode.ts
var FaustScriptProcessorNode = class extends (globalThis.ScriptProcessorNode || null) {
  constructor() {
    super(...arguments);
    this.handleDeviceMotion = void 0;
    this.handleDeviceOrientation = void 0;
  }
  setupNode(instance) {
    this.fDSPCode = instance;
    this.fInputs = new Array(this.fDSPCode.getNumInputs());
    this.fOutputs = new Array(this.fDSPCode.getNumOutputs());
    this.handleDeviceMotion = ({
      accelerationIncludingGravity
    }) => {
      const isAndroid = /Android/i.test(navigator.userAgent);
      if (!accelerationIncludingGravity) return;
      const { x, y, z } = accelerationIncludingGravity;
      this.propagateAcc({ x, y, z }, isAndroid);
    };
    this.handleDeviceOrientation = ({
      alpha,
      beta,
      gamma
    }) => {
      this.propagateGyr({ alpha, beta, gamma });
    };
    this.onaudioprocess = (e) => {
      for (let chan = 0; chan < this.fDSPCode.getNumInputs(); chan++) {
        this.fInputs[chan] = e.inputBuffer.getChannelData(chan);
      }
      for (let chan = 0; chan < this.fDSPCode.getNumOutputs(); chan++) {
        this.fOutputs[chan] = e.outputBuffer.getChannelData(chan);
      }
      return this.fDSPCode.compute(this.fInputs, this.fOutputs);
    };
    this.start();
  }
  init() {
    this.fDSPCode.init();
  }
  instanceInit() {
    this.fDSPCode.instanceInit();
  }
  instanceClear() {
    this.fDSPCode.instanceClear();
  }
  instanceConstants() {
    this.fDSPCode.instanceConstants();
  }
  instanceResetUserInterface() {
    this.fDSPCode.instanceResetUserInterface();
  }
  // Public API
  /** Start accelerometer and gyroscope handlers */
  async startSensors() {
    if (this.hasAccInput) {
      if (window.DeviceMotionEvent) {
        window.addEventListener(
          "devicemotion",
          this.handleDeviceMotion,
          true
        );
      } else {
        console.log("Cannot set the accelerometer handler.");
      }
    }
    if (this.hasGyrInput) {
      if (window.DeviceMotionEvent) {
        window.addEventListener(
          "deviceorientation",
          this.handleDeviceOrientation,
          true
        );
      } else {
        console.log("Cannot set the gyroscope handler.");
      }
    }
  }
  /** Stop accelerometer and gyroscope handlers */
  stopSensors() {
    if (this.hasAccInput) {
      window.removeEventListener(
        "devicemotion",
        this.handleDeviceMotion,
        true
      );
    }
    if (this.hasGyrInput) {
      window.removeEventListener(
        "deviceorientation",
        this.handleDeviceOrientation,
        true
      );
    }
  }
  compute(input, output) {
    return this.fDSPCode.compute(input, output);
  }
  setOutputParamHandler(handler) {
    this.fDSPCode.setOutputParamHandler(handler);
  }
  getOutputParamHandler() {
    return this.fDSPCode.getOutputParamHandler();
  }
  callOutputParamHandler(path, value) {
    this.fDSPCode.callOutputParamHandler(path, value);
  }
  setInputParamHandler(handler) {
    this.fDSPCode.setInputParamHandler(handler);
  }
  getInputParamHandler() {
    return this.fDSPCode.getInputParamHandler();
  }
  callInputParamHandler(path, value) {
    this.fDSPCode.callInputParamHandler(path, value);
  }
  setComputeHandler(handler) {
    this.fDSPCode.setComputeHandler(handler);
  }
  getComputeHandler() {
    return this.fDSPCode.getComputeHandler();
  }
  setPlotHandler(handler) {
    this.fDSPCode.setPlotHandler(handler);
  }
  getPlotHandler() {
    return this.fDSPCode.getPlotHandler();
  }
  setNonFiniteHandler(handler) {
    this.fDSPCode.setNonFiniteHandler(handler);
  }
  getNonFiniteHandler() {
    return this.fDSPCode.getNonFiniteHandler();
  }
  getNumInputs() {
    return this.fDSPCode.getNumInputs();
  }
  getNumOutputs() {
    return this.fDSPCode.getNumOutputs();
  }
  metadata(handler) {
  }
  midiMessage(data) {
    this.fDSPCode.midiMessage(data);
  }
  setMidiChannel(channel) {
    this.fDSPCode.setMidiChannel(channel);
  }
  getMidiChannel() {
    return this.fDSPCode.getMidiChannel();
  }
  ctrlChange(chan, ctrl, value) {
    this.fDSPCode.ctrlChange(chan, ctrl, value);
  }
  pitchWheel(chan, value) {
    this.fDSPCode.pitchWheel(chan, value);
  }
  keyOn(channel, pitch, velocity) {
    this.fDSPCode.keyOn(channel, pitch, velocity);
  }
  keyOff(channel, pitch, velocity) {
    this.fDSPCode.keyOff(channel, pitch, velocity);
  }
  setParamValue(path, value) {
    this.fDSPCode.setParamValue(path, value);
  }
  getParamValue(path) {
    return this.fDSPCode.getParamValue(path);
  }
  getParams() {
    return this.fDSPCode.getParams();
  }
  getMeta() {
    return this.fDSPCode.getMeta();
  }
  getJSON() {
    return this.fDSPCode.getJSON();
  }
  getDescriptors() {
    return this.fDSPCode.getDescriptors();
  }
  getUI() {
    return this.fDSPCode.getUI();
  }
  start() {
    this.fDSPCode.start();
  }
  stop() {
    this.fDSPCode.stop();
  }
  destroy() {
    this.fDSPCode.destroy();
  }
  get hasAccInput() {
    return this.fDSPCode.hasAccInput;
  }
  propagateAcc(accelerationIncludingGravity, invert = false) {
    this.fDSPCode.propagateAcc(accelerationIncludingGravity, invert);
  }
  get hasGyrInput() {
    return this.fDSPCode.hasGyrInput;
  }
  propagateGyr(event) {
    this.fDSPCode.propagateGyr(event);
  }
};
var FaustMonoScriptProcessorNode = class extends FaustScriptProcessorNode {
};
var FaustPolyScriptProcessorNode = class extends FaustScriptProcessorNode {
  keyOn(channel, pitch, velocity) {
    this.fDSPCode.keyOn(channel, pitch, velocity);
  }
  keyOff(channel, pitch, velocity) {
    this.fDSPCode.keyOff(channel, pitch, velocity);
  }
  allNotesOff(hard) {
    this.fDSPCode.allNotesOff(hard);
  }
  // The DSP runs on this thread: the count is always current
  getNumActiveVoices() {
    return this.fDSPCode.getNumActiveVoices();
  }
};

// src/generated/workletSources.ts
var monoProcessorSource = '(()=>{var ce=Object.defineProperty;var m=(B,e)=>ce(B,"name",{value:e,configurable:!0});var me=m((B,e,t=!0)=>{let{registerProcessor:s,AudioWorkletProcessor:n,sampleRate:r}=globalThis,a=globalThis,u=128,c=m(A=>A>=128&&A<240?A&15:-1,"statusChannel"),l=m(A=>{switch(A.type){case"midi":return c(A.data[0]);case"wam-midi":return c(A.data.bytes[0]);case"ctrlChange":case"pitchWheel":case"keyOn":case"keyOff":return A.data[0];default:return-1}},"messageChannel"),f=-2,b=-1,g=m(()=>{},"kCancelled"),S=16,E=16,{FaustBaseWebAudioDsp:T,FaustWasmInstantiator:N,FaustAudioWorkletProcessorCommunicator:z}=B,{processorName:k,dspName:x,dspMeta:V,effectMeta:ie,poly:W}=e,fe=m(A=>{let O=["/gate","/freq","/gain","/key","/vel","/velocity"],o="address"in A&&!!O.find(i=>A.address.endsWith(i));return W&&o?null:A.type==="vslider"||A.type==="hslider"||A.type==="nentry"?{name:A.address,defaultValue:A.init||0,minValue:A.min||0,maxValue:A.max||0}:A.type==="button"||A.type==="checkbox"?{name:A.address,defaultValue:A.init||0,minValue:0,maxValue:1}:null},"analysePolyParameters"),j=class j extends n{constructor(o){super(o);this.paramValuesCache={};this.fEventQueue=[];this.fEventSeq=0;this.fBlockEvents=[];this.fChangedFrames=[];this.fCommunicator=new z(this.port);let{parameterDescriptors:i}=this.constructor;i.forEach(I=>{this.paramValuesCache[I.name]=I.defaultValue||0});let{moduleId:h,instanceId:p}=o.processorOptions;!h||!p||(this.wamInfo={moduleId:h,instanceId:p})}static get parameterDescriptors(){let o=[],i=new Map,h=m(p=>I=>{let d=fe(I);if(!d)return;let P=i.get(d.name);if(P===p)throw new Error(`Faust: control "${d.name}" is declared twice in the ${p}. Two widgets resolved to the same path, so one of them would be unreachable. Give them distinct labels or groups.`);if(P!==void 0)throw new Error(`Faust: control "${d.name}" is declared both in the ${P} and in the ${p}. A polyphonic DSP cannot share a control path between \\`process\\` and \\`effect\\`: setParamValue routes a path to one side only, so the other would keep its default. Declare it under a distinct path on each side and have the host write both.`);i.set(d.name,p),o.push(d)},"collect");return T.parseUI(V.ui,h("voice")),ie&&T.parseUI(ie.ui,h("effect")),o}setupWamEventHandler(){var d;if(!this.wamInfo)return;let{moduleId:o,instanceId:i}=this.wamInfo,{webAudioModules:h}=globalThis,p=h.getModuleScope(o),I=(d=p==null?void 0:p.paramMgrProcessors)==null?void 0:d[i];I&&(I.handleEvent||(I.handleEvent=P=>{P.type==="wam-midi"&&this.atTime(P,()=>this.midiMessage(P.data.bytes))}))}messageFrame(o){let i=Number.isFinite(o.frame)?o.frame:Number.isFinite(o.time)?o.time*r:null;return i===null?null:Math.round(i)}atTime(o,i){let h=this.messageFrame(o);if(h===null){i();return}let p={frame:h,seq:this.fEventSeq++,channel:l(o),apply:m(()=>{try{i()}catch(d){console.error(`Faust: a message timed for frame ${h} threw and was dropped`,d)}},"apply")},I=this.fEventQueue.length;for(;I>0&&this.fEventQueue[I-1].frame>h;)I--;this.fEventQueue.splice(I,0,p)}flushEvents(){this.fEventQueue.length=0;for(let o of this.fBlockEvents)o.seq>=0&&(o.apply=g)}flushChannelEvents(o){let i=this.fEventQueue,h=0;for(let p=0;p<i.length;p++)i[p].channel!==o&&(i[h++]=i[p]);i.length=h;for(let p of this.fBlockEvents)p.seq>=0&&p.channel===o&&(p.apply=g)}acceptsMidiChannel(o){let i=this.fDSPCode.getMidiChannel();return i===0||o===i-1}isPanic(o){return o===120||o===123}collectAutomation(o,i,h){let p=this.fChangedFrames;p.length=0;let I=this.paramValuesCache[o];for(let v=0;v<i.length;v++)i[v]!==I&&(I=i[v],p.push(v));if(p.length===0)return;let d=p.length>S?E:1;for(let v=0;v<p.length;v+=d){let $=p[v];h.push(this.paramEvent(o,i[$],$))}let P=p.length-1;if(P%d){let v=p[P];h.push(this.paramEvent(o,i[v],v))}}paramEvent(o,i,h){return{frame:h,seq:f,apply:m(()=>this.setParamValue(o,i),"apply")}}collectEvents(o,i){let h=this.fBlockEvents;h.length=0;for(let d in o)this.collectAutomation(d,o[d],h);if(this.fCommunicator.getNewAccDataAvailable()){let d=this.fCommunicator.getAcc();if(d){this.fCommunicator.setNewAccDataAvailable(!1);let{invert:P,...v}=d;h.push({frame:0,seq:b,apply:m(()=>this.propagateAcc(v,P),"apply")})}}if(this.fCommunicator.getNewGyrDataAvailable()){let d=this.fCommunicator.getGyr();d&&(this.fCommunicator.setNewGyrDataAvailable(!1),h.push({frame:0,seq:b,apply:m(()=>this.propagateGyr(d),"apply")}))}let p=i+u,I=0;for(;this.fEventQueue.length&&this.fEventQueue[0].frame<p;){let d=this.fEventQueue.shift();d.frame=Math.max(0,d.frame-i),d.seq=I++,h.push(d)}return h.length>1&&h.sort((d,P)=>d.frame-P.frame||d.seq-P.seq),h}process(o,i,h){let p=this.collectEvents(h,a.currentFrame);return this.fDSPCode.compute(o[0],i[0],p)}handleMessageAux(o){let i=o.data;switch(i.type){case"midi":{this.atTime(i,()=>{let h=i.data[0]&15;i.data[0]>>4===11&&this.isPanic(i.data[1])&&this.acceptsMidiChannel(h)&&this.flushChannelEvents(h),this.midiMessage(i.data)});break}case"ctrlChange":{this.atTime(i,()=>{this.isPanic(i.data[1])&&this.flushChannelEvents(i.data[0]),this.ctrlChange(i.data[0],i.data[1],i.data[2])});break}case"midiChannel":{this.fDSPCode.setMidiChannel(i.data);break}case"pitchWheel":{this.atTime(i,()=>this.pitchWheel(i.data[0],i.data[1]));break}case"keyOn":{this.atTime(i,()=>this.keyOn(i.data[0],i.data[1],i.data[2]));break}case"keyOff":{this.atTime(i,()=>this.keyOff(i.data[0],i.data[1],i.data[2]));break}case"param":{this.atTime(i,()=>this.setParamValue(i.data.path,i.data.value));break}case"setPlotHandler":{i.data?this.fDSPCode.setPlotHandler((h,p,I)=>this.port.postMessage({type:"plot",value:h,index:p,events:I})):this.fDSPCode.setPlotHandler(null);break}case"setNonFiniteHandler":{this.fDSPCode.setNonFiniteHandler(i.data?()=>this.port.postMessage({type:"nonfinite"}):null);break}case"setupWamEventHandler":{this.setupWamEventHandler();break}case"init":{this.fDSPCode.init();break}case"instanceInit":{this.fDSPCode.instanceInit();break}case"instanceClear":{this.flushEvents(),this.fDSPCode.instanceClear();break}case"instanceConstants":{this.fDSPCode.instanceConstants();break}case"instanceResetUserInterface":{this.fDSPCode.instanceResetUserInterface();break}case"start":{this.fDSPCode.start();break}case"stop":{this.flushEvents(),this.fDSPCode.stop();break}case"destroy":{this.flushEvents(),this.port.close(),this.fDSPCode.destroy();break}default:break}}setParamValue(o,i){this.fDSPCode.setParamValue(o,i),this.paramValuesCache[o]=i}midiMessage(o){this.fDSPCode.midiMessage(o)}ctrlChange(o,i,h){this.fDSPCode.ctrlChange(o,i,h)}pitchWheel(o,i){this.fDSPCode.pitchWheel(o,i)}keyOn(o,i,h){this.fDSPCode.keyOn(o,i,h)}keyOff(o,i,h){this.fDSPCode.keyOff(o,i,h)}propagateAcc(o,i=!1){this.fDSPCode.propagateAcc(o,i)}propagateGyr(o){this.fDSPCode.propagateGyr(o)}};m(j,"FaustAudioWorkletProcessor");let L=j,q=class q extends L{constructor(o){super(o);this.handleMessageAux=m(o=>{super.handleMessageAux(o)},"handleMessageAux");let{FaustMonoWebAudioDsp:i}=B,{factory:h,sampleSize:p}=o.processorOptions,I=N.createSyncMonoDSPInstance(h);this.fDSPCode=new i(I,r,p,128,h.soundfiles),this.port.addEventListener("message",this.handleMessageAux),this.port.start(),this.fDSPCode.setOutputParamHandler((d,P)=>this.port.postMessage({path:d,value:P,type:"out-param"})),this.fDSPCode.setInputParamHandler((d,P)=>this.port.postMessage({path:d,value:P,type:"in-param"})),this.fDSPCode.start()}};m(q,"FaustMonoAudioWorkletProcessor");let R=q,K=class K extends L{constructor(o){super(o);this.handleMessageAux=m(o=>{if(o.data.type==="allNotesOff"){this.flushEvents(),this.allNotesOff(o.data.data);return}super.handleMessageAux(o)},"handleMessageAux");let{FaustPolyWebAudioDsp:i}=B,{voiceFactory:h,mixerModule:p,voices:I,effectFactory:d,sampleSize:P,stopLevel:v}=o.processorOptions,$=N.createSyncPolyDSPInstance(h,p,I,d),he={...d==null?void 0:d.soundfiles,...h.soundfiles};this.fDSPCode=new i($,r,P,128,he,v),this.port.addEventListener("message",this.handleMessageAux),this.port.start(),this.fDSPCode.setOutputParamHandler((U,X)=>this.port.postMessage({path:U,value:X,type:"out-param"})),this.fDSPCode.setInputParamHandler((U,X)=>this.port.postMessage({path:U,value:X,type:"in-param"})),this.fDSPCode.setActiveVoicesHandler(U=>this.port.postMessage({value:U,type:"active-voices"})),this.fDSPCode.start()}keyOn(o,i,h){this.fDSPCode.keyOn(o,i,h)}keyOff(o,i,h){this.fDSPCode.keyOff(o,i,h)}allNotesOff(o){this.fDSPCode.allNotesOff(o)}};m(K,"FaustPolyAudioWorkletProcessor");let _=K,le=W?_:R;if(t){let A=k||x||(W?"mydsp_poly":"mydsp"),O=globalThis;O.__faustRegisteredProcessors||(O.__faustRegisteredProcessors=new Set),O.__faustRegisteredProcessors.has(A)||(s(A,le),O.__faustRegisteredProcessors.add(A))}return W?_:R},"getFaustAudioWorkletProcessor"),oe=me;var Y=class Y{constructor(e){this.port=e,this.supportSharedArrayBuffer=!!globalThis.SharedArrayBuffer,this.byteLength=4*Uint8Array.BYTES_PER_ELEMENT+3*Float32Array.BYTES_PER_ELEMENT+3*Float32Array.BYTES_PER_ELEMENT}initializeBuffer(e){let t=0;this.uin8Invert=new Uint8ClampedArray(e,t,1),t+=Uint8ClampedArray.BYTES_PER_ELEMENT,this.uin8NewAccData=new Uint8ClampedArray(e,t,1),t+=Uint8ClampedArray.BYTES_PER_ELEMENT,this.uin8NewGyrData=new Uint8ClampedArray(e,t,1),t+=Uint8ClampedArray.BYTES_PER_ELEMENT,t+=Uint8ClampedArray.BYTES_PER_ELEMENT,this.f32Acc=new Float32Array(e,t,3),t+=3*Float32Array.BYTES_PER_ELEMENT,this.f32Gyr=new Float32Array(e,t,3),t+=3*Float32Array.BYTES_PER_ELEMENT}setNewAccDataAvailable(e){this.uin8NewAccData&&(this.uin8NewAccData[0]=+e)}getNewAccDataAvailable(){var e;return!!((e=this.uin8NewAccData)!=null&&e[0])}setNewGyrDataAvailable(e){this.uin8NewGyrData&&(this.uin8NewGyrData[0]=+e)}getNewGyrDataAvailable(){var e;return!!((e=this.uin8NewGyrData)!=null&&e[0])}setAcc({x:e,y:t,z:s},n=!1){if(!this.supportSharedArrayBuffer){let r={type:"acc",data:{x:e,y:t,z:s},invert:n};this.port.postMessage(r)}this.uin8NewAccData&&(this.uin8Invert[0]=+n,this.f32Acc[0]=e,this.f32Acc[1]=t,this.f32Acc[2]=s,this.uin8NewAccData[0]=1)}getAcc(){if(!this.uin8NewAccData)return;let e=!!this.uin8Invert[0],[t,s,n]=this.f32Acc;return{x:t,y:s,z:n,invert:e}}setGyr({alpha:e,beta:t,gamma:s}){if(!this.supportSharedArrayBuffer){let n={type:"gyr",data:{alpha:e,beta:t,gamma:s}};this.port.postMessage(n)}this.uin8NewGyrData&&(this.f32Gyr[0]=e,this.f32Gyr[1]=t,this.f32Gyr[2]=s,this.uin8NewGyrData[0]=1)}getGyr(){if(!this.uin8NewGyrData)return;let[e,t,s]=this.f32Gyr;return{alpha:e,beta:t,gamma:s}}};m(Y,"FaustAudioWorkletCommunicator");var Q=Y;var Z=class Z extends Q{constructor(e){if(super(e),this.supportSharedArrayBuffer)this.port.addEventListener("message",t=>{let{data:s}=t;s.type==="initSab"&&this.initializeBuffer(s.sab)});else{let t=new ArrayBuffer(this.byteLength);this.initializeBuffer(t),this.port.addEventListener("message",s=>{let n=s.data;switch(n.type){case"acc":{this.setAcc(n.data,n.invert);break}case"gyr":{this.setGyr(n.data);break}default:break}})}}};m(Z,"FaustAudioWorkletProcessorCommunicator");var G=Z;var ee=class ee{constructor(e){this.fExports=e}compute(e,t,s,n){this.fExports.compute(e,t,s,n)}getNumInputs(e){return this.fExports.getNumInputs(e)}getNumOutputs(e){return this.fExports.getNumOutputs(e)}getParamValue(e,t){return this.fExports.getParamValue(e,t)}getSampleRate(e){return this.fExports.getSampleRate(e)}init(e,t){this.fExports.init(e,t)}instanceClear(e){this.fExports.instanceClear(e)}instanceConstants(e,t){this.fExports.instanceConstants(e,t)}instanceInit(e,t){this.fExports.instanceInit(e,t)}instanceResetUserInterface(e){this.fExports.instanceResetUserInterface(e)}setParamValue(e,t,s){this.fExports.setParamValue(e,t,s)}};m(ee,"FaustDspInstance");var C=ee;var se=class se{static createWasmImport(e){return{env:{memory:e||new WebAssembly.Memory({initial:100}),memoryBase:0,tableBase:0,_abs:Math.abs,_acosf:Math.acos,_asinf:Math.asin,_atanf:Math.atan,_atan2f:Math.atan2,_ceilf:Math.ceil,_cosf:Math.cos,_expf:Math.exp,_floorf:Math.floor,_fmodf:m((t,s)=>t%s,"_fmodf"),_logf:Math.log,_log10f:Math.log10,_max_f:Math.max,_min_f:Math.min,_remainderf:m((t,s)=>t-Math.round(t/s)*s,"_remainderf"),_powf:Math.pow,_roundf:Math.round,_sinf:Math.sin,_sqrtf:Math.sqrt,_tanf:Math.tan,_acoshf:Math.acosh,_asinhf:Math.asinh,_atanhf:Math.atanh,_coshf:Math.cosh,_sinhf:Math.sinh,_tanhf:Math.tanh,_isnanf:Number.isNaN,_isinff:m(t=>!isFinite(t),"_isinff"),_copysignf:m((t,s)=>Math.sign(t)===Math.sign(s)?t:-t,"_copysignf"),_acos:Math.acos,_asin:Math.asin,_atan:Math.atan,_atan2:Math.atan2,_ceil:Math.ceil,_cos:Math.cos,_exp:Math.exp,_floor:Math.floor,_fmod:m((t,s)=>t%s,"_fmod"),_log:Math.log,_log10:Math.log10,_max_:Math.max,_min_:Math.min,_remainder:m((t,s)=>t-Math.round(t/s)*s,"_remainder"),_pow:Math.pow,_round:Math.round,_sin:Math.sin,_sqrt:Math.sqrt,_tan:Math.tan,_acosh:Math.acosh,_asinh:Math.asinh,_atanh:Math.atanh,_cosh:Math.cosh,_sinh:Math.sinh,_tanh:Math.tanh,_isnan:Number.isNaN,_isinf:m(t=>!isFinite(t),"_isinf"),_copysign:m((t,s)=>Math.sign(t)===Math.sign(s)?t:-t,"_copysign"),table:new WebAssembly.Table({initial:0,element:"anyfunc"})}}}static createWasmMemoryPoly(e,t,s,n,r){let a=Math.max(4,e),u=t,c=m(b=>{let g=65536;for(;g<b;)g*=2;return g},"pow2limit"),l=n?n.size:0,f=c(l+s.size*a+(s.inputs+s.outputs*2)*(u+r*t))/65536;return f=Math.max(2,f),new WebAssembly.Memory({initial:f})}static createWasmMemoryMono(e,t,s){let n=e,r=(t.size+(t.inputs+t.outputs)*(n+s*e))/65536;return new WebAssembly.Memory({initial:r*2})}static createMonoDSPInstanceAux(e,t,s=null){let n=e.exports,r=new C(n);return{memory:s||e.exports.memory,api:r,json:t}}static createMemoryMono(e){let t=JSON.parse(e.json),s=t.compile_options.match("-double")?8:4;return this.createWasmMemoryMono(s,t,8192)}static createMemoryPoly(e,t,s){let n=JSON.parse(t.json),r=s&&s.json?JSON.parse(s.json):null,a=n.compile_options.match("-double")?8:4;return this.createWasmMemoryPoly(e,a,n,r,8192)}static createMixerAux(e,t){let s={imports:{print:console.log},memory:{memory:t}};return new WebAssembly.Instance(e,s).exports}static async loadDSPFactory(e,t){let s=await fetch(e);if(!s.ok)throw new Error(`=> exception raised while running loadDSPFactory, file not found: ${e}`);let n=await s.arrayBuffer(),r=await WebAssembly.compile(n),u=await(await fetch(t)).text(),f=JSON.parse(u).compile_options.indexOf("wasm-e")!==-1;return{cfactory:0,code:new Uint8Array(n),module:r,json:u,poly:f}}static async loadDSPMixer(e,t){let s=null;return t?s=new Uint8Array(t.readFile(e,{encoding:"binary"})):s=await(await fetch(e)).arrayBuffer(),WebAssembly.compile(s)}static async createAsyncMonoDSPInstance(e){if(/"type":\\s*"soundfile"/.test(e.json)){let n=this.createMemoryMono(e),r=await WebAssembly.instantiate(e.module,this.createWasmImport(n));return this.createMonoDSPInstanceAux(r,e.json,n)}else{let n=await WebAssembly.instantiate(e.module,this.createWasmImport());return this.createMonoDSPInstanceAux(n,e.json)}}static createSyncMonoDSPInstance(e){if(/"type":\\s*"soundfile"/.test(e.json)){let n=this.createMemoryMono(e),r=new WebAssembly.Instance(e.module,this.createWasmImport(n));return this.createMonoDSPInstanceAux(r,e.json,n)}else{let n=new WebAssembly.Instance(e.module,this.createWasmImport());return this.createMonoDSPInstanceAux(n,e.json)}}static async createAsyncPolyDSPInstance(e,t,s,n){let r=this.createMemoryPoly(s,e,n),u=(await WebAssembly.instantiate(e.module,this.createWasmImport(r))).exports,c=new C(u),l=this.createMixerAux(t,r);if(n){let b=(await WebAssembly.instantiate(n.module,this.createWasmImport(r))).exports,g=new C(b);return{memory:r,voices:s,voiceAPI:c,effectAPI:g,mixerAPI:l,voiceJSON:e.json,effectJSON:n.json}}else return{memory:r,voices:s,voiceAPI:c,mixerAPI:l,voiceJSON:e.json}}static createSyncPolyDSPInstance(e,t,s,n){let r=this.createMemoryPoly(s,e,n),u=new WebAssembly.Instance(e.module,this.createWasmImport(r)).exports,c=new C(u),l=this.createMixerAux(t,r);if(n){let b=new WebAssembly.Instance(n.module,this.createWasmImport(r)).exports,g=new C(b);return{memory:r,voices:s,voiceAPI:c,effectAPI:g,mixerAPI:l,voiceJSON:e.json,effectJSON:n.json}}else return{memory:r,voices:s,voiceAPI:c,mixerAPI:l,voiceJSON:e.json}}};m(se,"FaustWasmInstantiator");var te=se,ue=te;var y=class y{static convertToAxis(e){switch(e){case 0:return 0;case 1:return 1;case 2:return 2;default:return console.error("Error: Axis not found value: "+e),0}}static convertToCurve(e){switch(e){case 0:return 0;case 1:return 1;case 2:return 2;case 3:return 3;default:return console.error("Error: Curve not found value: "+e),0}}static get Range(){return this._Range||(this._Range=class{constructor(e,t){this.fLo=Math.min(e,t),this.fHi=Math.max(e,t)}clip(e){return e<this.fLo?this.fLo:e>this.fHi?this.fHi:e}}),this._Range}static get Interpolator(){return this._Interpolator||(this._Interpolator=class{constructor(e,t,s,n){this.fRange=new y.Range(e,t),t!==e?(this.fCoef=(n-s)/(t-e),this.fOffset=s-e*this.fCoef):(this.fCoef=0,this.fOffset=(s+n)/2)}returnMappedValue(e){let t=this.fRange.clip(e);return this.fOffset+t*this.fCoef}getLowHigh(e,t){return{amin:this.fRange.fLo,amax:this.fRange.fHi}}}),this._Interpolator}static get Interpolator3pt(){return this._Interpolator3pt||(this._Interpolator3pt=class{constructor(e,t,s,n,r,a){this.fSegment1=new y.Interpolator(e,t,n,r),this.fSegment2=new y.Interpolator(t,s,r,a),this.fMid=t}returnMappedValue(e){return e<this.fMid?this.fSegment1.returnMappedValue(e):this.fSegment2.returnMappedValue(e)}getMappingValues(e,t,s){let n=this.fSegment1.getLowHigh(e,t),r=this.fSegment2.getLowHigh(t,s);return{amin:n.amin,amid:r.amin,amax:r.amax}}}),this._Interpolator3pt}static get UpConverter(){return this._UpConverter||(this._UpConverter=class{constructor(e,t,s,n,r,a){this.fActive=!0;this.fA2F=new y.Interpolator3pt(e,t,s,n,r,a),this.fF2A=new y.Interpolator3pt(n,r,a,e,t,s)}uiToFaust(e){return this.fA2F.returnMappedValue(e)}faustToUi(e){return this.fF2A.returnMappedValue(e)}setMappingValues(e,t,s,n,r,a){this.fA2F=new y.Interpolator3pt(e,t,s,n,r,a),this.fF2A=new y.Interpolator3pt(n,r,a,e,t,s)}getMappingValues(e,t,s){return this.fA2F.getMappingValues(e,t,s)}setActive(e){this.fActive=e}getActive(){return this.fActive}}),this._UpConverter}static get DownConverter(){return this._DownConverter||(this._DownConverter=class{constructor(e,t,s,n,r,a){this.fActive=!0;this.fA2F=new y.Interpolator3pt(e,t,s,a,r,n),this.fF2A=new y.Interpolator3pt(n,r,a,s,t,e)}uiToFaust(e){return this.fA2F.returnMappedValue(e)}faustToUi(e){return this.fF2A.returnMappedValue(e)}setMappingValues(e,t,s,n,r,a){this.fA2F=new y.Interpolator3pt(e,t,s,a,r,n),this.fF2A=new y.Interpolator3pt(n,r,a,s,t,e)}getMappingValues(e,t,s){return this.fA2F.getMappingValues(e,t,s)}setActive(e){this.fActive=e}getActive(){return this.fActive}}),this._DownConverter}static get UpDownConverter(){return this._UpDownConverter||(this._UpDownConverter=class{constructor(e,t,s,n,r,a){this.fActive=!0;this.fA2F=new y.Interpolator3pt(e,t,s,n,a,n),this.fF2A=new y.Interpolator(n,a,e,s)}uiToFaust(e){return this.fA2F.returnMappedValue(e)}faustToUi(e){return this.fF2A.returnMappedValue(e)}setMappingValues(e,t,s,n,r,a){this.fA2F=new y.Interpolator3pt(e,t,s,n,a,n),this.fF2A=new y.Interpolator(n,a,e,s)}getMappingValues(e,t,s){return this.fA2F.getMappingValues(e,t,s)}setActive(e){this.fActive=e}getActive(){return this.fActive}}),this._UpDownConverter}static get DownUpConverter(){return this._DownUpConverter||(this._DownUpConverter=class{constructor(e,t,s,n,r,a){this.fActive=!0;this.fA2F=new y.Interpolator3pt(e,t,s,a,n,a),this.fF2A=new y.Interpolator(n,a,e,s)}uiToFaust(e){return this.fA2F.returnMappedValue(e)}faustToUi(e){return this.fF2A.returnMappedValue(e)}setMappingValues(e,t,s,n,r,a){this.fA2F=new y.Interpolator3pt(e,t,s,a,n,a),this.fF2A=new y.Interpolator(n,a,e,s)}getMappingValues(e,t,s){return this.fA2F.getMappingValues(e,t,s)}setActive(e){this.fActive=e}getActive(){return this.fActive}}),this._DownUpConverter}static buildHandler(e,t,s,n,r,a,u){switch(e){case 0:return new y.UpConverter(t,s,n,r,a,u);case 1:return new y.DownConverter(t,s,n,r,a,u);case 2:return new y.UpDownConverter(t,s,n,r,a,u);case 3:return new y.DownUpConverter(t,s,n,r,a,u);default:return new y.UpConverter(t,s,n,r,a,u)}}};m(y,"FaustSensors");var F=y;var re=class re{constructor(e,t){this.memory=e,this.allocatedBytes=t}alloc(e){let t=this.allocatedBytes+7&-8,s=t+e,n=this.memory.buffer.byteLength;if(s>n){let r=Math.ceil((s-n)/65536);console.log(`GROW: ${r} pages`),this.memory.grow(r)}return this.allocatedBytes=s,t}getBuffer(){return this.memory.buffer}getInt32Array(){return new Int32Array(this.memory.buffer)}getInt64Array(){return new BigInt64Array(this.memory.buffer)}getFloat32Array(){return new Float32Array(this.memory.buffer)}getFloat64Array(){return new Float64Array(this.memory.buffer)}};m(re,"WasmAllocator");var ne=re,M=class M{static get MAX_SOUNDFILE_PARTS(){return 256}static get MAX_CHAN(){return 64}static get BUFFER_SIZE(){return 1024}static get SAMPLE_RATE(){return 44100}constructor(e,t,s,n,r,a){this.fSampleSize=t,this.fIntSize=this.fSampleSize,this.fPtrSize=4,this.fAllocator=e,console.log(`Soundfile constructor: curChan: ${s}, length: ${n}, totalParts: ${a}`),this.fPtr=e.alloc(4*this.fPtrSize+12),this.fLength=e.alloc(M.MAX_SOUNDFILE_PARTS*this.fIntSize),this.fSR=e.alloc(M.MAX_SOUNDFILE_PARTS*this.fIntSize),this.fOffset=e.alloc(M.MAX_SOUNDFILE_PARTS*this.fIntSize),this.fBuffers=this.allocBuffers(s,n);let u=this.fAllocator.getInt32Array();u[this.fPtr>>2]=this.fBuffers,u[this.fPtr+this.fPtrSize>>2]=this.fLength,u[this.fPtr+2*this.fPtrSize>>2]=this.fSR,u[this.fPtr+3*this.fPtrSize>>2]=this.fOffset,u[this.fPtr+4*this.fPtrSize>>2]=s,u[this.fPtr+4*this.fPtrSize+4>>2]=a,u[this.fPtr+4*this.fPtrSize+8>>2]=this.fSampleSize===8?1:0;for(let c=0;c<s;c++){let l=u[(this.fBuffers>>2)+c];console.log(`allocBuffers AFTER: ${c} - ${l}`)}}allocBuffers(e,t){let s=this.fAllocator.alloc(e*this.fPtrSize);console.log(`allocBuffers buffers: ${s}`);for(let n=0;n<e;n++){let r=this.fAllocator.alloc(t*this.fSampleSize),a=this.fAllocator.getInt32Array();a[(s>>2)+n]=r}return s}copyToOut(e,t,s,n){if(this.fIntSize===4){let r=this.fAllocator.getInt32Array();r[(this.fLength>>Math.log2(this.fIntSize))+e]=n.audioBuffer[0].length,r[(this.fSR>>Math.log2(this.fIntSize))+e]=n.sampleRate,r[(this.fOffset>>Math.log2(this.fIntSize))+e]=s}else{let r=this.fAllocator.getInt64Array();r[(this.fLength>>Math.log2(this.fIntSize))+e]=BigInt(n.audioBuffer[0].length),r[(this.fSR>>Math.log2(this.fIntSize))+e]=BigInt(n.sampleRate),r[(this.fOffset>>Math.log2(this.fIntSize))+e]=BigInt(s)}console.log(`copyToOut: part: ${e}, maxChannels: ${t}, offset: ${s}, buffer: ${n}`),this.fSampleSize===8?this.copyToOutReal64(t,s,n):this.copyToOutReal32(t,s,n)}copyToOutReal32(e,t,s){let n=this.fAllocator.getInt32Array(),r=this.fAllocator.getFloat32Array();for(let a=0;a<s.audioBuffer.length;a++){let u=s.audioBuffer[a],c=n[(this.fBuffers>>2)+a],l=c+t*this.fSampleSize>>Math.log2(this.fSampleSize),f=c+(t+u.length)*this.fSampleSize>>Math.log2(this.fSampleSize);console.log(`copyToOutReal32 begin: ${l}, end: ${f}, delta: ${f-l}`);let b=r.subarray(c+t*this.fSampleSize>>Math.log2(this.fSampleSize),c+(t+u.length)*this.fSampleSize>>Math.log2(this.fSampleSize));for(let g=0;g<u.length;g++)b[g]=u[g]}}copyToOutReal64(e,t,s){let n=this.fAllocator.getInt32Array(),r=this.fAllocator.getFloat64Array();for(let a=0;a<s.audioBuffer.length;a++){let u=s.audioBuffer[a],c=n[(this.fBuffers>>2)+a],l=c+t*this.fSampleSize>>Math.log2(this.fSampleSize),f=c+(t+u.length)*this.fSampleSize>>Math.log2(this.fSampleSize);console.log(`copyToOutReal64 begin: ${l}, end: ${f}, delta: ${f-l}`);let b=r.subarray(c+t*this.fSampleSize>>Math.log2(this.fSampleSize),c+(t+u.length)*this.fSampleSize>>Math.log2(this.fSampleSize));for(let g=0;g<u.length;g++)b[g]=u[g]}}emptyFile(e,t){if(this.fIntSize===4){let s=this.fAllocator.getInt32Array();s[(this.fLength>>Math.log2(this.fIntSize))+e]=M.BUFFER_SIZE,s[(this.fSR>>Math.log2(this.fIntSize))+e]=M.SAMPLE_RATE,s[(this.fOffset>>Math.log2(this.fIntSize))+e]=t}else{let s=this.fAllocator.getInt64Array();s[(this.fLength>>Math.log2(this.fIntSize))+e]=BigInt(M.BUFFER_SIZE),s[(this.fSR>>Math.log2(this.fIntSize))+e]=BigInt(M.SAMPLE_RATE),s[(this.fOffset>>Math.log2(this.fIntSize))+e]=BigInt(t)}return t+M.BUFFER_SIZE}displayMemory(e="",t=!1){console.log("Soundfile memory: "+e),console.log(`fPtr: ${this.fPtr}`),console.log(`fBuffers: ${this.fBuffers}`),console.log(`fLength: ${this.fLength}`),console.log(`fSR: ${this.fSR}`),console.log(`fOffset: ${this.fOffset}`);let s=this.fAllocator.getInt32Array();t&&console.log(`HEAP32: ${s}`),console.log(`HEAP32[this.fPtr >> 2]: ${s[this.fPtr>>2]}`),console.log(`HEAP32[(this.fPtr + ptrSize) >> 2]: ${s[this.fPtr+this.fPtrSize>>2]}`),console.log(`HEAP32[(this.fPtr + 2 * ptrSize) >> 2]: ${s[this.fPtr+2*this.fPtrSize>>2]}`),console.log(`HEAP32[(this.fPtr + 3 * ptrSize) >> 2]: ${s[this.fPtr+3*this.fPtrSize>>2]}`)}getPtr(){return this.fPtr}getHEAP32(){return this.fAllocator.getInt32Array()}getHEAPFloat32(){return this.fAllocator.getFloat32Array()}getHEAPFloat64(){return this.fAllocator.getFloat64Array()}};m(M,"Soundfile");var w=M,D=class D{constructor(e,t,s){this.fOutputHandler=null;this.fInputHandler=null;this.fComputeHandler=null;this.fNonFiniteHandler=null;this.fNonFiniteReported=!1;this.fPlotHandler=null;this.fCachedEvents=[];this.fBufferNum=0;this.fInChannels=[];this.fOutChannels=[];this.fOutputsTimer=5;this.fInputsItems=[];this.fOutputsItems=[];this.fDescriptor=[];this.fSoundfiles=[];this.fSoundfileBuffers={};this.fInBase=[];this.fOutBase=[];this.fPitchwheelLabel=[];this.fCtrlLabel=new Array(128).fill(null).map(()=>[]);this.fMidiKeyLabel=new Array(128).fill(null).map(()=>[]);this.fMidiKeyOnLabel=new Array(128).fill(null).map(()=>[]);this.fMidiKeyOffLabel=new Array(128).fill(null).map(()=>[]);this.fMidiChannel=0;this.fPathTable={};this.fUnknownPaths=new Set;this.fUICallback=m(e=>{if(e.type==="hbargraph"||e.type==="vbargraph"){let t=m(s=>{this.fPathTable[s]===void 0&&(this.fPathTable[s]=e.index)},"registerPath");this.fOutputsItems.push(e.address),t(e.address),t(e.shortname),t(e.label)}else if(e.type==="vslider"||e.type==="hslider"||e.type==="button"||e.type==="checkbox"||e.type==="nentry"){let t=m(s=>{this.fPathTable[s]===void 0&&(this.fPathTable[s]=e.index)},"registerPath");if(this.fInputsItems.push(e.address),t(e.address),t(e.shortname),t(e.label),this.fDescriptor.push(e),!e.meta)return;e.meta.forEach(s=>{var u,c,l,f,b,g;let{midi:n,acc:r,gyr:a}=s;if(n){let S=n.trim();if(S==="pitchwheel"){let E=S.match(/^pitchwheel\\s(\\d+)/);E?this.fPitchwheelLabel.push({path:e.address,chan:parseInt(E[1]),min:e.min,max:e.max}):this.fPitchwheelLabel.push({path:e.address,chan:0,min:e.min,max:e.max})}else{let E=S.match(/^ctrl\\s(\\d+)\\s(\\d+)/),T=S.match(/^ctrl\\s(\\d+)/),N=S.match(/^key\\s+(\\d+)(?:\\s+(\\d+))?$/),z=S.match(/^keyon\\s+(\\d+)(?:\\s+(\\d+))?$/),k=S.match(/^keyoff\\s+(\\d+)(?:\\s+(\\d+))?$/);if(E)this.fCtrlLabel[parseInt(E[1])].push({path:e.address,chan:parseInt(E[2]),min:e.min,max:e.max});else if(T)this.fCtrlLabel[parseInt(T[1])].push({path:e.address,chan:0,min:e.min,max:e.max});else if(N){let x=parseInt(N[1]),V=N[2]?parseInt(N[2]):0;this.fMidiKeyLabel[x].push({path:e.address,chan:V,min:(u=e.min)!=null?u:0,max:(c=e.max)!=null?c:1})}else if(z){let x=parseInt(z[1]),V=z[2]?parseInt(z[2]):0;this.fMidiKeyOnLabel[x].push({path:e.address,chan:V,min:(l=e.min)!=null?l:0,max:(f=e.max)!=null?f:1})}else if(k){let x=parseInt(k[1]),V=k[2]?parseInt(k[2]):0;this.fMidiKeyOffLabel[x].push({path:e.address,chan:V,min:(b=e.min)!=null?b:0,max:(g=e.max)!=null?g:1})}}}if(r){let S=r.trim().split(" ").map(Number);this.setupAccHandler(e.address,F.convertToAxis(S[0]),F.convertToCurve(S[1]),S[2],S[3],S[4],e.min,e.init,e.max)}if(a){let S=a.trim().split(" ").map(Number);this.setupGyrHandler(e.address,F.convertToAxis(S[0]),F.convertToCurve(S[1]),S[2],S[3],S[4],e.min,e.init,e.max)}})}else e.type==="soundfile"&&this.fSoundfiles.push({name:e.label,url:e.url,index:e.index,basePtr:-1})},"fUICallback");this.fProcessing=!1;this.fDestroyed=!1;this.fFirstCall=!0;this.fBufferSize=t,this.fPtrSize=e,this.fSampleSize=e,this.fSoundfileBuffers=s,this.fAcc={x:[],y:[],z:[]},this.fGyr={x:[],y:[],z:[]}}warnUnknownPath(e,t){this.fUnknownPaths.has(e)||(this.fUnknownPaths.add(e),console.warn(`Faust: unknown parameter path "${e}", ${t}. Use getParams() for the list of valid paths.`))}renderBlock(e,t){if(!e||e.length===0){t(0,this.fBufferSize);return}let s=0;for(let n=0;n<e.length;n++){let r=e[n],a=Math.min(Math.max(r.frame,0),this.fBufferSize);a>s&&(t(s,a-s),s=a),r.apply()}s<this.fBufferSize&&t(s,this.fBufferSize-s)}applyEvents(e){if(e)for(let t=0;t<e.length;t++)e[t].apply()}setBufferOffset(e){let t=e*this.fSampleSize;for(let s=0;s<this.fInBase.length;s++)this.fHEAP32[(this.fAudioInputs>>2)+s]=this.fInBase[s]+t;for(let s=0;s<this.fOutBase.length;s++)this.fHEAP32[(this.fAudioOutputs>>2)+s]=this.fOutBase[s]+t}static remap(e,t,s,n,r){return(e-t)/(s-t)*(r-n)+n}static parseUI(e,t){e.forEach(s=>this.parseGroup(s,t))}static parseGroup(e,t){e.items&&this.parseItems(e.items,t)}static parseItems(e,t){e.forEach(s=>this.parseItem(s,t))}static parseItem(e,t){e.type==="vgroup"||e.type==="hgroup"||e.type==="tgroup"?this.parseItems(e.items,t):t(e)}static splitSoundfileNames(e){return e.replace(/^\\{|\\}$/g,"").split(";").map(s=>s.length<=2?"":s.substring(1,s.length-1)).map(s=>s.trim()).filter(s=>s.length>0)}get hasAccInput(){return this.fAcc.x.length+this.fAcc.y.length+this.fAcc.z.length>0}propagateAcc(e,t=!1){let{x:s,y:n,z:r}=e;t?(s!==null&&this.fAcc.x.forEach(a=>a(-s)),n!==null&&this.fAcc.y.forEach(a=>a(-n)),r!==null&&this.fAcc.z.forEach(a=>a(-r))):(s!==null&&this.fAcc.x.forEach(a=>a(s)),n!==null&&this.fAcc.y.forEach(a=>a(n)),r!==null&&this.fAcc.z.forEach(a=>a(r)))}get hasGyrInput(){return this.fGyr.x.length+this.fGyr.y.length+this.fGyr.z.length>0}propagateGyr(e){let{alpha:t,beta:s,gamma:n}=e;t!==null&&this.fGyr.x.forEach(r=>r(t)),s!==null&&this.fGyr.y.forEach(r=>r(s)),n!==null&&this.fGyr.z.forEach(r=>r(n))}setupAccHandler(e,t,s,n,r,a,u,c,l){let f=F.buildHandler(s,n,r,a,u,c,l);switch(t){case 0:this.fAcc.x.push(b=>this.setParamValue(e,f.uiToFaust(b)));break;case 1:this.fAcc.y.push(b=>this.setParamValue(e,f.uiToFaust(b)));break;case 2:this.fAcc.z.push(b=>this.setParamValue(e,f.uiToFaust(b)));break}}setupGyrHandler(e,t,s,n,r,a,u,c,l){let f=F.buildHandler(s,n,r,a,u,c,l);switch(t){case 0:this.fGyr.x.push(b=>this.setParamValue(e,f.uiToFaust(b)));break;case 1:this.fGyr.y.push(b=>this.setParamValue(e,f.uiToFaust(b)));break;case 2:this.fGyr.z.push(b=>this.setParamValue(e,f.uiToFaust(b)));break}}static extractUrlsFromMeta(e){let t=e.meta.find(s=>s.soundfiles!==void 0);return t?t.soundfiles.split(";").filter(s=>s!==""):[]}loadSoundfile(e,t,s,n){console.log(`Soundfile ${s} paths: ${n}`);let r=D.splitSoundfileNames(n),a=this.fSoundfiles.find(u=>u.url===n);if(!a)throw new Error(`Soundfile with ${n} cannot be found !}`);if(a.basePtr!==-1){let u=e.getInt32Array();console.log(`Soundfile CACHE ${n}} : ${s} loaded at ${a.basePtr} in wasm memory with index ${a.index}`),u[t+a.index>>2]=a.basePtr}else{let u=this.createSoundfile(e,r,this.fSoundfileBuffers);if(u){let c=u.getHEAP32();a.basePtr=u.getPtr(),console.log(`Soundfile ${s} loaded at ${a.basePtr} in wasm memory with index ${a.index}`),c[t+a.index>>2]=a.basePtr}else console.log(`Soundfile ${s} for ${n} cannot be created !}`)}}createSoundfile(e,t,s,n){let r=1,a=0;for(let l of t){let f=0,b=0,g=s==null?void 0:s[l];g?(f=g.audioBuffer.length,b=g.audioBuffer[0].length):(b=w.BUFFER_SIZE,f=1),r=Math.max(r,f),a+=b}a+=(w.MAX_SOUNDFILE_PARTS-t.length)*w.BUFFER_SIZE;let u=new w(e,this.fSampleSize,r,a,r,t.length),c=0;for(let l=0;l<t.length;l++){let f=t[l],b=s==null?void 0:s[f];b?(u.copyToOut(l,r,c,b),c+=b.audioBuffer[0].length):c=u.emptyFile(l,c)}for(let l=t.length;l<w.MAX_SOUNDFILE_PARTS;l++)c=u.emptyFile(l,c);return u}initSoundfileMemory(e,t){for(let{name:s,url:n}of this.fSoundfiles)this.loadSoundfile(e,t,s,n)}updateOutputs(){this.fOutputsItems.length>0&&this.fOutputHandler&&this.fOutputsTimer--===0&&(this.fOutputsTimer=5,this.fOutputsItems.forEach(e=>{var t;return(t=this.fOutputHandler)==null?void 0:t.call(this,e,this.getParamValue(e))}))}metadata(e){this.fJSONDsp.meta&&this.fJSONDsp.meta.forEach(t=>e(Object.keys(t)[0],t[Object.keys(t)[0]]))}compute(e,t){return!1}setOutputParamHandler(e){this.fOutputHandler=e}getOutputParamHandler(){return this.fOutputHandler}callOutputParamHandler(e,t){this.fOutputHandler&&this.fOutputHandler(e,t)}setInputParamHandler(e){this.fInputHandler=e}getInputParamHandler(){return this.fInputHandler}callInputParamHandler(e,t){this.fInputHandler&&this.fInputHandler(e,t)}setComputeHandler(e){this.fComputeHandler=e}getComputeHandler(){return this.fComputeHandler}setPlotHandler(e){this.fPlotHandler=e}getPlotHandler(){return this.fPlotHandler}setNonFiniteHandler(e){this.fNonFiniteHandler=e}getNonFiniteHandler(){return this.fNonFiniteHandler}clearNonFinite(){if(!this.fNonFiniteHandler)return;let e=!1,t=this.getNumOutputs();for(let s=0;s<t;s++){let n=this.fOutChannels[s],r=0;for(let a=0;a<n.length;a++)r+=n[a];if(r-r!==0)for(let a=0;a<n.length;a++){let u=n[a];u-u!==0&&(n[a]=0,e=!0)}}e&&!this.fNonFiniteReported&&(this.fNonFiniteReported=!0,this.fNonFiniteHandler())}getNumInputs(){return-1}getNumOutputs(){return-1}static parseMidiChannel(e){if(!e)return 0;let t,s="";for(let r of e)if(typeof r.options=="string"){let a=r.options.match(/\\[midichannel:([^\\]]*)\\]/);a&&(t=a[1],s="[midichannel] option")}if(t===void 0)for(let r of e)typeof r.midichannel=="string"&&(t=r.midichannel,s="midichannel metadata");if(t===void 0||t.trim()==="")return 0;let n=/^\\s*\\d+\\s*$/.test(t)?Number(t):NaN;return n>=0&&n<=16?n:(console.warn(`Faust: invalid MIDI channel \'${t}\' in ${s}: should be in 1..16, or 0 for all channels`),0)}setMidiChannel(e){this.fMidiChannel=Number.isInteger(e)&&e>=0&&e<=16?e:0}getMidiChannel(){return this.fMidiChannel}acceptMidiStatus(e){return this.fMidiChannel===0||e>=240||(e&15)===this.fMidiChannel-1}midiMessage(e){if(!this.acceptMidiStatus(e[0]))return;this.fPlotHandler&&this.fCachedEvents.push({data:e,type:"midi"});let t=e[0]>>4,s=e[0]&15,n=e[1],r=e[2];if(t===11)return this.ctrlChange(s,n,r);if(t===14)return this.pitchWheel(s,r*128+n);if(t===9)return r>0?this.keyOn(s,n,r):this.keyOff(s,n,r);if(t===8)return this.keyOff(s,n,r)}ctrlChange(e,t,s){this.fPlotHandler&&this.fCachedEvents.push({type:"ctrlChange",data:[e,t,s]}),this.fCtrlLabel[t].length&&this.fCtrlLabel[t].forEach(n=>{let{path:r,chan:a}=n;(a===0||e===a-1)&&(this.setParamValue(r,D.remap(s,0,127,n.min,n.max)),this.fOutputHandler&&this.fOutputHandler(r,this.getParamValue(r)))})}keyOn(e,t,s){this.fPlotHandler&&this.fCachedEvents.push({type:"keyOn",data:[e,t,s]}),this.fMidiKeyOnLabel[t].forEach(n=>{let{path:r,chan:a}=n;(a===0||e===a-1)&&(this.setParamValue(r,D.remap(s,0,127,n.min,n.max)),this.fOutputHandler&&this.fOutputHandler(r,this.getParamValue(r)))}),this.fMidiKeyLabel[t].forEach(n=>{let{path:r,chan:a}=n;(a===0||e===a-1)&&(this.setParamValue(r,D.remap(s,0,127,n.min,n.max)),this.fOutputHandler&&this.fOutputHandler(r,this.getParamValue(r)))})}keyOff(e,t,s){this.fPlotHandler&&this.fCachedEvents.push({type:"keyOff",data:[e,t,s]}),this.fMidiKeyOffLabel[t].forEach(n=>{let{path:r,chan:a}=n;(a===0||e===a-1)&&(this.setParamValue(r,D.remap(s,0,127,n.min,n.max)),this.fOutputHandler&&this.fOutputHandler(r,this.getParamValue(r)))}),this.fMidiKeyLabel[t].forEach(n=>{let{path:r,chan:a}=n;(a===0||e===a-1)&&(this.setParamValue(r,0),this.fOutputHandler&&this.fOutputHandler(r,this.getParamValue(r)))})}pitchWheel(e,t){this.fPlotHandler&&this.fCachedEvents.push({type:"pitchWheel",data:[e,t]}),this.fPitchwheelLabel.forEach(s=>{let{path:n,chan:r}=s;(r===0||e===r-1)&&(this.setParamValue(n,D.remap(t,0,16383,s.min,s.max)),this.fOutputHandler&&this.fOutputHandler(n,this.getParamValue(n)))})}setParamValue(e,t){}getParamValue(e){return 0}getParams(){return this.fInputsItems}getMeta(){return this.fJSONDsp}getJSON(){return JSON.stringify(this.getMeta())}getUI(){return this.fJSONDsp.ui}getDescriptors(){return this.fDescriptor}hasSoundfiles(){return this.fSoundfiles.length>0}startSensors(){this.startSensors()}stopSensors(){this.stopSensors()}init(){}instanceInit(){}instanceClear(){}instanceConstants(){}instanceResetUserInterface(){}start(){this.fProcessing=!0}stop(){this.fProcessing=!1}destroy(){this.fDestroyed=!0,this.fOutputHandler=null,this.fInputHandler=null,this.fComputeHandler=null,this.fPlotHandler=null}};m(D,"FaustBaseWebAudioDsp");var H=D,ae=class ae extends H{constructor(t,s,n,r,a){super(n,r,a);this.fRenderSlice=m((t,s)=>{this.setBufferOffset(t),this.fInstance.api.compute(this.fDSP,s,this.fAudioInputs,this.fAudioOutputs)},"fRenderSlice");if(this.fInstance=t,this.fSampleRate=s,this.fJSONDsp=JSON.parse(this.fInstance.json),this.fMidiChannel=H.parseMidiChannel(this.fJSONDsp.meta),H.parseUI(this.fJSONDsp.ui,this.fUICallback),this.fEndMemory=this.initMemory(),this.fInstance.api.init(this.fDSP,s),this.fSoundfiles.length>0){let u=new ne(this.fInstance.memory,this.fEndMemory);this.initSoundfileMemory(u,this.fDSP)}}init(){this.fInstance.api.init(this.fDSP,this.fSampleRate)}instanceInit(){this.fInstance.api.instanceInit(this.fDSP,this.fSampleRate)}instanceClear(){this.fInstance.api.instanceClear(this.fDSP)}instanceConstants(){this.fInstance.api.instanceConstants(this.fDSP,this.fSampleRate)}instanceResetUserInterface(){this.fInstance.api.instanceResetUserInterface(this.fDSP)}initMemory(){this.fDSP=0;let t=this.fJSONDsp.size;this.fAudioInputs=t,this.fAudioOutputs=this.fAudioInputs+this.getNumInputs()*this.fPtrSize;let s=this.fAudioOutputs+this.getNumOutputs()*this.fPtrSize,n=s+this.getNumInputs()*this.fBufferSize*this.fSampleSize,r=n+this.getNumOutputs()*this.fBufferSize*this.fSampleSize,a=this.fInstance.memory.buffer,u=new Int32Array(a),c=this.fSampleSize===4?new Float32Array(a):new Float64Array(a);if(this.getNumInputs()>0){for(let f=0;f<this.getNumInputs();f++)u[(this.fAudioInputs>>2)+f]=s+this.fBufferSize*this.fSampleSize*f;let l=u.subarray(this.fAudioInputs>>2,this.fAudioInputs+this.getNumInputs()*this.fPtrSize>>2);for(let f=0;f<this.getNumInputs();f++)this.fInChannels[f]=c.subarray(l[f]>>Math.log2(this.fSampleSize),l[f]+this.fBufferSize*this.fSampleSize>>Math.log2(this.fSampleSize))}if(this.getNumOutputs()>0){for(let f=0;f<this.getNumOutputs();f++)u[(this.fAudioOutputs>>2)+f]=n+this.fBufferSize*this.fSampleSize*f;let l=u.subarray(this.fAudioOutputs>>2,this.fAudioOutputs+this.getNumOutputs()*this.fPtrSize>>2);for(let f=0;f<this.getNumOutputs();f++)this.fOutChannels[f]=c.subarray(l[f]>>Math.log2(this.fSampleSize),l[f]+this.fBufferSize*this.fSampleSize>>Math.log2(this.fSampleSize))}this.fHEAP32=u,this.fInBase=[];for(let l=0;l<this.getNumInputs();l++)this.fInBase[l]=u[(this.fAudioInputs>>2)+l];this.fOutBase=[];for(let l=0;l<this.getNumOutputs();l++)this.fOutBase[l]=u[(this.fAudioOutputs>>2)+l];return r}toString(){return`============== Mono Memory layout ==============\n        this.fBufferSize: ${this.fBufferSize}\n        this.fJSONDsp.size: ${this.fJSONDsp.size}\n        this.fAudioInputs: ${this.fAudioInputs}\n        this.fAudioOutputs: ${this.fAudioOutputs}\n        this.fDSP: ${this.fDSP}`}compute(t,s,n){if(this.fDestroyed)return!1;if(!this.fProcessing)return this.applyEvents(n),!0;if(this.fFirstCall&&(this.initMemory(),this.fFirstCall=!1),typeof t=="function")t(this.fInChannels);else{if(this.getNumInputs()>0&&(!t||!t[0]||t[0].length===0))return this.applyEvents(n),!0;if(this.getNumOutputs()>0&&typeof s!="function"&&(!s||!s[0]||s[0].length===0))return this.applyEvents(n),!0;if(t!==void 0)for(let a=0;a<Math.min(this.getNumInputs(),t.length);a++)this.fInChannels[a].set(t[a])}this.fComputeHandler&&this.fComputeHandler(this.fBufferSize),this.renderBlock(n,this.fRenderSlice),this.updateOutputs(),this.clearNonFinite();let r=this.fOutChannels;if(typeof s=="function")s(this.fOutChannels);else{for(let a=0;a<Math.min(this.getNumOutputs(),s.length);a++){let u=this.fOutChannels[a];s[a].set(u)}r=s}return this.fPlotHandler&&(this.fPlotHandler(r,this.fBufferNum++,this.fCachedEvents.length?this.fCachedEvents:void 0),this.fCachedEvents=[]),!0}metadata(t){super.metadata(t)}getNumInputs(){return this.fInstance.api.getNumInputs(this.fDSP)}getNumOutputs(){return this.fInstance.api.getNumOutputs(this.fDSP)}setParamValue(t,s){let n=this.fPathTable[t];if(n===void 0)return this.warnUnknownPath(t,"ignored");this.fPlotHandler&&this.fCachedEvents.push({type:"param",data:{path:t,value:s}}),this.fInstance.api.setParamValue(this.fDSP,n,s),this.callInputParamHandler(t,this.getParamValue(t))}getParamValue(t){let s=this.fPathTable[t];return s===void 0?(this.warnUnknownPath(t,"returning 0"),0):this.fInstance.api.getParamValue(this.fDSP,s)}getMeta(){return this.fJSONDsp}getJSON(){return this.fInstance.json}getDescriptors(){return this.fDescriptor}getUI(){return this.fJSONDsp.ui}};m(ae,"FaustMonoWebAudioDsp");var J=ae;oe({FaustBaseWebAudioDsp:H,FaustMonoWebAudioDsp:J,FaustWasmInstantiator:ue,FaustAudioWorkletProcessorCommunicator:G,FaustPolyWebAudioDsp:void 0,FaustWebAudioDspVoice:void 0},faustData);})();\n';
var polyProcessorSource = '(()=>{var pe=Object.defineProperty;var p=(W,e)=>pe(W,"name",{value:e,configurable:!0});var de=p((W,e,t=!0)=>{let{registerProcessor:s,AudioWorkletProcessor:n,sampleRate:r}=globalThis,a=globalThis,u=128,f=p(A=>A>=128&&A<240?A&15:-1,"statusChannel"),c=p(A=>{switch(A.type){case"midi":return f(A.data[0]);case"wam-midi":return f(A.data.bytes[0]);case"ctrlChange":case"pitchWheel":case"keyOn":case"keyOff":return A.data[0];default:return-1}},"messageChannel"),m=-2,l=-1,g=p(()=>{},"kCancelled"),P=16,C=16,{FaustBaseWebAudioDsp:L,FaustWasmInstantiator:w,FaustAudioWorkletProcessorCommunicator:B}=W,{processorName:T,dspName:H,dspMeta:z,effectMeta:ue,poly:_}=e,he=p(A=>{let D=["/gate","/freq","/gain","/key","/vel","/velocity"],o="address"in A&&!!D.find(i=>A.address.endsWith(i));return _&&o?null:A.type==="vslider"||A.type==="hslider"||A.type==="nentry"?{name:A.address,defaultValue:A.init||0,minValue:A.min||0,maxValue:A.max||0}:A.type==="button"||A.type==="checkbox"?{name:A.address,defaultValue:A.init||0,minValue:0,maxValue:1}:null},"analysePolyParameters"),X=class X extends n{constructor(o){super(o);this.paramValuesCache={};this.fEventQueue=[];this.fEventSeq=0;this.fBlockEvents=[];this.fChangedFrames=[];this.fCommunicator=new B(this.port);let{parameterDescriptors:i}=this.constructor;i.forEach(S=>{this.paramValuesCache[S.name]=S.defaultValue||0});let{moduleId:h,instanceId:d}=o.processorOptions;!h||!d||(this.wamInfo={moduleId:h,instanceId:d})}static get parameterDescriptors(){let o=[],i=new Map,h=p(d=>S=>{let b=he(S);if(!b)return;let v=i.get(b.name);if(v===d)throw new Error(`Faust: control "${b.name}" is declared twice in the ${d}. Two widgets resolved to the same path, so one of them would be unreachable. Give them distinct labels or groups.`);if(v!==void 0)throw new Error(`Faust: control "${b.name}" is declared both in the ${v} and in the ${d}. A polyphonic DSP cannot share a control path between \\`process\\` and \\`effect\\`: setParamValue routes a path to one side only, so the other would keep its default. Declare it under a distinct path on each side and have the host write both.`);i.set(b.name,d),o.push(b)},"collect");return L.parseUI(z.ui,h("voice")),ue&&L.parseUI(ue.ui,h("effect")),o}setupWamEventHandler(){var b;if(!this.wamInfo)return;let{moduleId:o,instanceId:i}=this.wamInfo,{webAudioModules:h}=globalThis,d=h.getModuleScope(o),S=(b=d==null?void 0:d.paramMgrProcessors)==null?void 0:b[i];S&&(S.handleEvent||(S.handleEvent=v=>{v.type==="wam-midi"&&this.atTime(v,()=>this.midiMessage(v.data.bytes))}))}messageFrame(o){let i=Number.isFinite(o.frame)?o.frame:Number.isFinite(o.time)?o.time*r:null;return i===null?null:Math.round(i)}atTime(o,i){let h=this.messageFrame(o);if(h===null){i();return}let d={frame:h,seq:this.fEventSeq++,channel:c(o),apply:p(()=>{try{i()}catch(b){console.error(`Faust: a message timed for frame ${h} threw and was dropped`,b)}},"apply")},S=this.fEventQueue.length;for(;S>0&&this.fEventQueue[S-1].frame>h;)S--;this.fEventQueue.splice(S,0,d)}flushEvents(){this.fEventQueue.length=0;for(let o of this.fBlockEvents)o.seq>=0&&(o.apply=g)}flushChannelEvents(o){let i=this.fEventQueue,h=0;for(let d=0;d<i.length;d++)i[d].channel!==o&&(i[h++]=i[d]);i.length=h;for(let d of this.fBlockEvents)d.seq>=0&&d.channel===o&&(d.apply=g)}acceptsMidiChannel(o){let i=this.fDSPCode.getMidiChannel();return i===0||o===i-1}isPanic(o){return o===120||o===123}collectAutomation(o,i,h){let d=this.fChangedFrames;d.length=0;let S=this.paramValuesCache[o];for(let M=0;M<i.length;M++)i[M]!==S&&(S=i[M],d.push(M));if(d.length===0)return;let b=d.length>P?C:1;for(let M=0;M<d.length;M+=b){let j=d[M];h.push(this.paramEvent(o,i[j],j))}let v=d.length-1;if(v%b){let M=d[v];h.push(this.paramEvent(o,i[M],M))}}paramEvent(o,i,h){return{frame:h,seq:m,apply:p(()=>this.setParamValue(o,i),"apply")}}collectEvents(o,i){let h=this.fBlockEvents;h.length=0;for(let b in o)this.collectAutomation(b,o[b],h);if(this.fCommunicator.getNewAccDataAvailable()){let b=this.fCommunicator.getAcc();if(b){this.fCommunicator.setNewAccDataAvailable(!1);let{invert:v,...M}=b;h.push({frame:0,seq:l,apply:p(()=>this.propagateAcc(M,v),"apply")})}}if(this.fCommunicator.getNewGyrDataAvailable()){let b=this.fCommunicator.getGyr();b&&(this.fCommunicator.setNewGyrDataAvailable(!1),h.push({frame:0,seq:l,apply:p(()=>this.propagateGyr(b),"apply")}))}let d=i+u,S=0;for(;this.fEventQueue.length&&this.fEventQueue[0].frame<d;){let b=this.fEventQueue.shift();b.frame=Math.max(0,b.frame-i),b.seq=S++,h.push(b)}return h.length>1&&h.sort((b,v)=>b.frame-v.frame||b.seq-v.seq),h}process(o,i,h){let d=this.collectEvents(h,a.currentFrame);return this.fDSPCode.compute(o[0],i[0],d)}handleMessageAux(o){let i=o.data;switch(i.type){case"midi":{this.atTime(i,()=>{let h=i.data[0]&15;i.data[0]>>4===11&&this.isPanic(i.data[1])&&this.acceptsMidiChannel(h)&&this.flushChannelEvents(h),this.midiMessage(i.data)});break}case"ctrlChange":{this.atTime(i,()=>{this.isPanic(i.data[1])&&this.flushChannelEvents(i.data[0]),this.ctrlChange(i.data[0],i.data[1],i.data[2])});break}case"midiChannel":{this.fDSPCode.setMidiChannel(i.data);break}case"pitchWheel":{this.atTime(i,()=>this.pitchWheel(i.data[0],i.data[1]));break}case"keyOn":{this.atTime(i,()=>this.keyOn(i.data[0],i.data[1],i.data[2]));break}case"keyOff":{this.atTime(i,()=>this.keyOff(i.data[0],i.data[1],i.data[2]));break}case"param":{this.atTime(i,()=>this.setParamValue(i.data.path,i.data.value));break}case"setPlotHandler":{i.data?this.fDSPCode.setPlotHandler((h,d,S)=>this.port.postMessage({type:"plot",value:h,index:d,events:S})):this.fDSPCode.setPlotHandler(null);break}case"setNonFiniteHandler":{this.fDSPCode.setNonFiniteHandler(i.data?()=>this.port.postMessage({type:"nonfinite"}):null);break}case"setupWamEventHandler":{this.setupWamEventHandler();break}case"init":{this.fDSPCode.init();break}case"instanceInit":{this.fDSPCode.instanceInit();break}case"instanceClear":{this.flushEvents(),this.fDSPCode.instanceClear();break}case"instanceConstants":{this.fDSPCode.instanceConstants();break}case"instanceResetUserInterface":{this.fDSPCode.instanceResetUserInterface();break}case"start":{this.fDSPCode.start();break}case"stop":{this.flushEvents(),this.fDSPCode.stop();break}case"destroy":{this.flushEvents(),this.port.close(),this.fDSPCode.destroy();break}default:break}}setParamValue(o,i){this.fDSPCode.setParamValue(o,i),this.paramValuesCache[o]=i}midiMessage(o){this.fDSPCode.midiMessage(o)}ctrlChange(o,i,h){this.fDSPCode.ctrlChange(o,i,h)}pitchWheel(o,i){this.fDSPCode.pitchWheel(o,i)}keyOn(o,i,h){this.fDSPCode.keyOn(o,i,h)}keyOff(o,i,h){this.fDSPCode.keyOff(o,i,h)}propagateAcc(o,i=!1){this.fDSPCode.propagateAcc(o,i)}propagateGyr(o){this.fDSPCode.propagateGyr(o)}};p(X,"FaustAudioWorkletProcessor");let $=X,Q=class Q extends ${constructor(o){super(o);this.handleMessageAux=p(o=>{super.handleMessageAux(o)},"handleMessageAux");let{FaustMonoWebAudioDsp:i}=W,{factory:h,sampleSize:d}=o.processorOptions,S=w.createSyncMonoDSPInstance(h);this.fDSPCode=new i(S,r,d,128,h.soundfiles),this.port.addEventListener("message",this.handleMessageAux),this.port.start(),this.fDSPCode.setOutputParamHandler((b,v)=>this.port.postMessage({path:b,value:v,type:"out-param"})),this.fDSPCode.setInputParamHandler((b,v)=>this.port.postMessage({path:b,value:v,type:"in-param"})),this.fDSPCode.start()}};p(Q,"FaustMonoAudioWorkletProcessor");let G=Q,Y=class Y extends ${constructor(o){super(o);this.handleMessageAux=p(o=>{if(o.data.type==="allNotesOff"){this.flushEvents(),this.allNotesOff(o.data.data);return}super.handleMessageAux(o)},"handleMessageAux");let{FaustPolyWebAudioDsp:i}=W,{voiceFactory:h,mixerModule:d,voices:S,effectFactory:b,sampleSize:v,stopLevel:M}=o.processorOptions,j=w.createSyncPolyDSPInstance(h,d,S,b),me={...b==null?void 0:b.soundfiles,...h.soundfiles};this.fDSPCode=new i(j,r,v,128,me,M),this.port.addEventListener("message",this.handleMessageAux),this.port.start(),this.fDSPCode.setOutputParamHandler((R,Z)=>this.port.postMessage({path:R,value:Z,type:"out-param"})),this.fDSPCode.setInputParamHandler((R,Z)=>this.port.postMessage({path:R,value:Z,type:"in-param"})),this.fDSPCode.setActiveVoicesHandler(R=>this.port.postMessage({value:R,type:"active-voices"})),this.fDSPCode.start()}keyOn(o,i,h){this.fDSPCode.keyOn(o,i,h)}keyOff(o,i,h){this.fDSPCode.keyOff(o,i,h)}allNotesOff(o){this.fDSPCode.allNotesOff(o)}};p(Y,"FaustPolyAudioWorkletProcessor");let J=Y,ce=_?J:G;if(t){let A=T||H||(_?"mydsp_poly":"mydsp"),D=globalThis;D.__faustRegisteredProcessors||(D.__faustRegisteredProcessors=new Set),D.__faustRegisteredProcessors.has(A)||(s(A,ce),D.__faustRegisteredProcessors.add(A))}return _?J:G},"getFaustAudioWorkletProcessor"),fe=de;var te=class te{constructor(e){this.port=e,this.supportSharedArrayBuffer=!!globalThis.SharedArrayBuffer,this.byteLength=4*Uint8Array.BYTES_PER_ELEMENT+3*Float32Array.BYTES_PER_ELEMENT+3*Float32Array.BYTES_PER_ELEMENT}initializeBuffer(e){let t=0;this.uin8Invert=new Uint8ClampedArray(e,t,1),t+=Uint8ClampedArray.BYTES_PER_ELEMENT,this.uin8NewAccData=new Uint8ClampedArray(e,t,1),t+=Uint8ClampedArray.BYTES_PER_ELEMENT,this.uin8NewGyrData=new Uint8ClampedArray(e,t,1),t+=Uint8ClampedArray.BYTES_PER_ELEMENT,t+=Uint8ClampedArray.BYTES_PER_ELEMENT,this.f32Acc=new Float32Array(e,t,3),t+=3*Float32Array.BYTES_PER_ELEMENT,this.f32Gyr=new Float32Array(e,t,3),t+=3*Float32Array.BYTES_PER_ELEMENT}setNewAccDataAvailable(e){this.uin8NewAccData&&(this.uin8NewAccData[0]=+e)}getNewAccDataAvailable(){var e;return!!((e=this.uin8NewAccData)!=null&&e[0])}setNewGyrDataAvailable(e){this.uin8NewGyrData&&(this.uin8NewGyrData[0]=+e)}getNewGyrDataAvailable(){var e;return!!((e=this.uin8NewGyrData)!=null&&e[0])}setAcc({x:e,y:t,z:s},n=!1){if(!this.supportSharedArrayBuffer){let r={type:"acc",data:{x:e,y:t,z:s},invert:n};this.port.postMessage(r)}this.uin8NewAccData&&(this.uin8Invert[0]=+n,this.f32Acc[0]=e,this.f32Acc[1]=t,this.f32Acc[2]=s,this.uin8NewAccData[0]=1)}getAcc(){if(!this.uin8NewAccData)return;let e=!!this.uin8Invert[0],[t,s,n]=this.f32Acc;return{x:t,y:s,z:n,invert:e}}setGyr({alpha:e,beta:t,gamma:s}){if(!this.supportSharedArrayBuffer){let n={type:"gyr",data:{alpha:e,beta:t,gamma:s}};this.port.postMessage(n)}this.uin8NewGyrData&&(this.f32Gyr[0]=e,this.f32Gyr[1]=t,this.f32Gyr[2]=s,this.uin8NewGyrData[0]=1)}getGyr(){if(!this.uin8NewGyrData)return;let[e,t,s]=this.f32Gyr;return{alpha:e,beta:t,gamma:s}}};p(te,"FaustAudioWorkletCommunicator");var ee=te;var se=class se extends ee{constructor(e){if(super(e),this.supportSharedArrayBuffer)this.port.addEventListener("message",t=>{let{data:s}=t;s.type==="initSab"&&this.initializeBuffer(s.sab)});else{let t=new ArrayBuffer(this.byteLength);this.initializeBuffer(t),this.port.addEventListener("message",s=>{let n=s.data;switch(n.type){case"acc":{this.setAcc(n.data,n.invert);break}case"gyr":{this.setGyr(n.data);break}default:break}})}}};p(se,"FaustAudioWorkletProcessorCommunicator");var q=se;var ne=class ne{constructor(e){this.fExports=e}compute(e,t,s,n){this.fExports.compute(e,t,s,n)}getNumInputs(e){return this.fExports.getNumInputs(e)}getNumOutputs(e){return this.fExports.getNumOutputs(e)}getParamValue(e,t){return this.fExports.getParamValue(e,t)}getSampleRate(e){return this.fExports.getSampleRate(e)}init(e,t){this.fExports.init(e,t)}instanceClear(e){this.fExports.instanceClear(e)}instanceConstants(e,t){this.fExports.instanceConstants(e,t)}instanceInit(e,t){this.fExports.instanceInit(e,t)}instanceResetUserInterface(e){this.fExports.instanceResetUserInterface(e)}setParamValue(e,t,s){this.fExports.setParamValue(e,t,s)}};p(ne,"FaustDspInstance");var N=ne;var ae=class ae{static createWasmImport(e){return{env:{memory:e||new WebAssembly.Memory({initial:100}),memoryBase:0,tableBase:0,_abs:Math.abs,_acosf:Math.acos,_asinf:Math.asin,_atanf:Math.atan,_atan2f:Math.atan2,_ceilf:Math.ceil,_cosf:Math.cos,_expf:Math.exp,_floorf:Math.floor,_fmodf:p((t,s)=>t%s,"_fmodf"),_logf:Math.log,_log10f:Math.log10,_max_f:Math.max,_min_f:Math.min,_remainderf:p((t,s)=>t-Math.round(t/s)*s,"_remainderf"),_powf:Math.pow,_roundf:Math.round,_sinf:Math.sin,_sqrtf:Math.sqrt,_tanf:Math.tan,_acoshf:Math.acosh,_asinhf:Math.asinh,_atanhf:Math.atanh,_coshf:Math.cosh,_sinhf:Math.sinh,_tanhf:Math.tanh,_isnanf:Number.isNaN,_isinff:p(t=>!isFinite(t),"_isinff"),_copysignf:p((t,s)=>Math.sign(t)===Math.sign(s)?t:-t,"_copysignf"),_acos:Math.acos,_asin:Math.asin,_atan:Math.atan,_atan2:Math.atan2,_ceil:Math.ceil,_cos:Math.cos,_exp:Math.exp,_floor:Math.floor,_fmod:p((t,s)=>t%s,"_fmod"),_log:Math.log,_log10:Math.log10,_max_:Math.max,_min_:Math.min,_remainder:p((t,s)=>t-Math.round(t/s)*s,"_remainder"),_pow:Math.pow,_round:Math.round,_sin:Math.sin,_sqrt:Math.sqrt,_tan:Math.tan,_acosh:Math.acosh,_asinh:Math.asinh,_atanh:Math.atanh,_cosh:Math.cosh,_sinh:Math.sinh,_tanh:Math.tanh,_isnan:Number.isNaN,_isinf:p(t=>!isFinite(t),"_isinf"),_copysign:p((t,s)=>Math.sign(t)===Math.sign(s)?t:-t,"_copysign"),table:new WebAssembly.Table({initial:0,element:"anyfunc"})}}}static createWasmMemoryPoly(e,t,s,n,r){let a=Math.max(4,e),u=t,f=p(l=>{let g=65536;for(;g<l;)g*=2;return g},"pow2limit"),c=n?n.size:0,m=f(c+s.size*a+(s.inputs+s.outputs*2)*(u+r*t))/65536;return m=Math.max(2,m),new WebAssembly.Memory({initial:m})}static createWasmMemoryMono(e,t,s){let n=e,r=(t.size+(t.inputs+t.outputs)*(n+s*e))/65536;return new WebAssembly.Memory({initial:r*2})}static createMonoDSPInstanceAux(e,t,s=null){let n=e.exports,r=new N(n);return{memory:s||e.exports.memory,api:r,json:t}}static createMemoryMono(e){let t=JSON.parse(e.json),s=t.compile_options.match("-double")?8:4;return this.createWasmMemoryMono(s,t,8192)}static createMemoryPoly(e,t,s){let n=JSON.parse(t.json),r=s&&s.json?JSON.parse(s.json):null,a=n.compile_options.match("-double")?8:4;return this.createWasmMemoryPoly(e,a,n,r,8192)}static createMixerAux(e,t){let s={imports:{print:console.log},memory:{memory:t}};return new WebAssembly.Instance(e,s).exports}static async loadDSPFactory(e,t){let s=await fetch(e);if(!s.ok)throw new Error(`=> exception raised while running loadDSPFactory, file not found: ${e}`);let n=await s.arrayBuffer(),r=await WebAssembly.compile(n),u=await(await fetch(t)).text(),m=JSON.parse(u).compile_options.indexOf("wasm-e")!==-1;return{cfactory:0,code:new Uint8Array(n),module:r,json:u,poly:m}}static async loadDSPMixer(e,t){let s=null;return t?s=new Uint8Array(t.readFile(e,{encoding:"binary"})):s=await(await fetch(e)).arrayBuffer(),WebAssembly.compile(s)}static async createAsyncMonoDSPInstance(e){if(/"type":\\s*"soundfile"/.test(e.json)){let n=this.createMemoryMono(e),r=await WebAssembly.instantiate(e.module,this.createWasmImport(n));return this.createMonoDSPInstanceAux(r,e.json,n)}else{let n=await WebAssembly.instantiate(e.module,this.createWasmImport());return this.createMonoDSPInstanceAux(n,e.json)}}static createSyncMonoDSPInstance(e){if(/"type":\\s*"soundfile"/.test(e.json)){let n=this.createMemoryMono(e),r=new WebAssembly.Instance(e.module,this.createWasmImport(n));return this.createMonoDSPInstanceAux(r,e.json,n)}else{let n=new WebAssembly.Instance(e.module,this.createWasmImport());return this.createMonoDSPInstanceAux(n,e.json)}}static async createAsyncPolyDSPInstance(e,t,s,n){let r=this.createMemoryPoly(s,e,n),u=(await WebAssembly.instantiate(e.module,this.createWasmImport(r))).exports,f=new N(u),c=this.createMixerAux(t,r);if(n){let l=(await WebAssembly.instantiate(n.module,this.createWasmImport(r))).exports,g=new N(l);return{memory:r,voices:s,voiceAPI:f,effectAPI:g,mixerAPI:c,voiceJSON:e.json,effectJSON:n.json}}else return{memory:r,voices:s,voiceAPI:f,mixerAPI:c,voiceJSON:e.json}}static createSyncPolyDSPInstance(e,t,s,n){let r=this.createMemoryPoly(s,e,n),u=new WebAssembly.Instance(e.module,this.createWasmImport(r)).exports,f=new N(u),c=this.createMixerAux(t,r);if(n){let l=new WebAssembly.Instance(n.module,this.createWasmImport(r)).exports,g=new N(l);return{memory:r,voices:s,voiceAPI:f,effectAPI:g,mixerAPI:c,voiceJSON:e.json,effectJSON:n.json}}else return{memory:r,voices:s,voiceAPI:f,mixerAPI:c,voiceJSON:e.json}}};p(ae,"FaustWasmInstantiator");var re=ae,le=re;var y=class y{static convertToAxis(e){switch(e){case 0:return 0;case 1:return 1;case 2:return 2;default:return console.error("Error: Axis not found value: "+e),0}}static convertToCurve(e){switch(e){case 0:return 0;case 1:return 1;case 2:return 2;case 3:return 3;default:return console.error("Error: Curve not found value: "+e),0}}static get Range(){return this._Range||(this._Range=class{constructor(e,t){this.fLo=Math.min(e,t),this.fHi=Math.max(e,t)}clip(e){return e<this.fLo?this.fLo:e>this.fHi?this.fHi:e}}),this._Range}static get Interpolator(){return this._Interpolator||(this._Interpolator=class{constructor(e,t,s,n){this.fRange=new y.Range(e,t),t!==e?(this.fCoef=(n-s)/(t-e),this.fOffset=s-e*this.fCoef):(this.fCoef=0,this.fOffset=(s+n)/2)}returnMappedValue(e){let t=this.fRange.clip(e);return this.fOffset+t*this.fCoef}getLowHigh(e,t){return{amin:this.fRange.fLo,amax:this.fRange.fHi}}}),this._Interpolator}static get Interpolator3pt(){return this._Interpolator3pt||(this._Interpolator3pt=class{constructor(e,t,s,n,r,a){this.fSegment1=new y.Interpolator(e,t,n,r),this.fSegment2=new y.Interpolator(t,s,r,a),this.fMid=t}returnMappedValue(e){return e<this.fMid?this.fSegment1.returnMappedValue(e):this.fSegment2.returnMappedValue(e)}getMappingValues(e,t,s){let n=this.fSegment1.getLowHigh(e,t),r=this.fSegment2.getLowHigh(t,s);return{amin:n.amin,amid:r.amin,amax:r.amax}}}),this._Interpolator3pt}static get UpConverter(){return this._UpConverter||(this._UpConverter=class{constructor(e,t,s,n,r,a){this.fActive=!0;this.fA2F=new y.Interpolator3pt(e,t,s,n,r,a),this.fF2A=new y.Interpolator3pt(n,r,a,e,t,s)}uiToFaust(e){return this.fA2F.returnMappedValue(e)}faustToUi(e){return this.fF2A.returnMappedValue(e)}setMappingValues(e,t,s,n,r,a){this.fA2F=new y.Interpolator3pt(e,t,s,n,r,a),this.fF2A=new y.Interpolator3pt(n,r,a,e,t,s)}getMappingValues(e,t,s){return this.fA2F.getMappingValues(e,t,s)}setActive(e){this.fActive=e}getActive(){return this.fActive}}),this._UpConverter}static get DownConverter(){return this._DownConverter||(this._DownConverter=class{constructor(e,t,s,n,r,a){this.fActive=!0;this.fA2F=new y.Interpolator3pt(e,t,s,a,r,n),this.fF2A=new y.Interpolator3pt(n,r,a,s,t,e)}uiToFaust(e){return this.fA2F.returnMappedValue(e)}faustToUi(e){return this.fF2A.returnMappedValue(e)}setMappingValues(e,t,s,n,r,a){this.fA2F=new y.Interpolator3pt(e,t,s,a,r,n),this.fF2A=new y.Interpolator3pt(n,r,a,s,t,e)}getMappingValues(e,t,s){return this.fA2F.getMappingValues(e,t,s)}setActive(e){this.fActive=e}getActive(){return this.fActive}}),this._DownConverter}static get UpDownConverter(){return this._UpDownConverter||(this._UpDownConverter=class{constructor(e,t,s,n,r,a){this.fActive=!0;this.fA2F=new y.Interpolator3pt(e,t,s,n,a,n),this.fF2A=new y.Interpolator(n,a,e,s)}uiToFaust(e){return this.fA2F.returnMappedValue(e)}faustToUi(e){return this.fF2A.returnMappedValue(e)}setMappingValues(e,t,s,n,r,a){this.fA2F=new y.Interpolator3pt(e,t,s,n,a,n),this.fF2A=new y.Interpolator(n,a,e,s)}getMappingValues(e,t,s){return this.fA2F.getMappingValues(e,t,s)}setActive(e){this.fActive=e}getActive(){return this.fActive}}),this._UpDownConverter}static get DownUpConverter(){return this._DownUpConverter||(this._DownUpConverter=class{constructor(e,t,s,n,r,a){this.fActive=!0;this.fA2F=new y.Interpolator3pt(e,t,s,a,n,a),this.fF2A=new y.Interpolator(n,a,e,s)}uiToFaust(e){return this.fA2F.returnMappedValue(e)}faustToUi(e){return this.fF2A.returnMappedValue(e)}setMappingValues(e,t,s,n,r,a){this.fA2F=new y.Interpolator3pt(e,t,s,a,n,a),this.fF2A=new y.Interpolator(n,a,e,s)}getMappingValues(e,t,s){return this.fA2F.getMappingValues(e,t,s)}setActive(e){this.fActive=e}getActive(){return this.fActive}}),this._DownUpConverter}static buildHandler(e,t,s,n,r,a,u){switch(e){case 0:return new y.UpConverter(t,s,n,r,a,u);case 1:return new y.DownConverter(t,s,n,r,a,u);case 2:return new y.UpDownConverter(t,s,n,r,a,u);case 3:return new y.DownUpConverter(t,s,n,r,a,u);default:return new y.UpConverter(t,s,n,r,a,u)}}};p(y,"FaustSensors");var O=y;var oe=class oe{constructor(e,t){this.memory=e,this.allocatedBytes=t}alloc(e){let t=this.allocatedBytes+7&-8,s=t+e,n=this.memory.buffer.byteLength;if(s>n){let r=Math.ceil((s-n)/65536);console.log(`GROW: ${r} pages`),this.memory.grow(r)}return this.allocatedBytes=s,t}getBuffer(){return this.memory.buffer}getInt32Array(){return new Int32Array(this.memory.buffer)}getInt64Array(){return new BigInt64Array(this.memory.buffer)}getFloat32Array(){return new Float32Array(this.memory.buffer)}getFloat64Array(){return new Float64Array(this.memory.buffer)}};p(oe,"WasmAllocator");var ie=oe,F=class F{static get MAX_SOUNDFILE_PARTS(){return 256}static get MAX_CHAN(){return 64}static get BUFFER_SIZE(){return 1024}static get SAMPLE_RATE(){return 44100}constructor(e,t,s,n,r,a){this.fSampleSize=t,this.fIntSize=this.fSampleSize,this.fPtrSize=4,this.fAllocator=e,console.log(`Soundfile constructor: curChan: ${s}, length: ${n}, totalParts: ${a}`),this.fPtr=e.alloc(4*this.fPtrSize+12),this.fLength=e.alloc(F.MAX_SOUNDFILE_PARTS*this.fIntSize),this.fSR=e.alloc(F.MAX_SOUNDFILE_PARTS*this.fIntSize),this.fOffset=e.alloc(F.MAX_SOUNDFILE_PARTS*this.fIntSize),this.fBuffers=this.allocBuffers(s,n);let u=this.fAllocator.getInt32Array();u[this.fPtr>>2]=this.fBuffers,u[this.fPtr+this.fPtrSize>>2]=this.fLength,u[this.fPtr+2*this.fPtrSize>>2]=this.fSR,u[this.fPtr+3*this.fPtrSize>>2]=this.fOffset,u[this.fPtr+4*this.fPtrSize>>2]=s,u[this.fPtr+4*this.fPtrSize+4>>2]=a,u[this.fPtr+4*this.fPtrSize+8>>2]=this.fSampleSize===8?1:0;for(let f=0;f<s;f++){let c=u[(this.fBuffers>>2)+f];console.log(`allocBuffers AFTER: ${f} - ${c}`)}}allocBuffers(e,t){let s=this.fAllocator.alloc(e*this.fPtrSize);console.log(`allocBuffers buffers: ${s}`);for(let n=0;n<e;n++){let r=this.fAllocator.alloc(t*this.fSampleSize),a=this.fAllocator.getInt32Array();a[(s>>2)+n]=r}return s}copyToOut(e,t,s,n){if(this.fIntSize===4){let r=this.fAllocator.getInt32Array();r[(this.fLength>>Math.log2(this.fIntSize))+e]=n.audioBuffer[0].length,r[(this.fSR>>Math.log2(this.fIntSize))+e]=n.sampleRate,r[(this.fOffset>>Math.log2(this.fIntSize))+e]=s}else{let r=this.fAllocator.getInt64Array();r[(this.fLength>>Math.log2(this.fIntSize))+e]=BigInt(n.audioBuffer[0].length),r[(this.fSR>>Math.log2(this.fIntSize))+e]=BigInt(n.sampleRate),r[(this.fOffset>>Math.log2(this.fIntSize))+e]=BigInt(s)}console.log(`copyToOut: part: ${e}, maxChannels: ${t}, offset: ${s}, buffer: ${n}`),this.fSampleSize===8?this.copyToOutReal64(t,s,n):this.copyToOutReal32(t,s,n)}copyToOutReal32(e,t,s){let n=this.fAllocator.getInt32Array(),r=this.fAllocator.getFloat32Array();for(let a=0;a<s.audioBuffer.length;a++){let u=s.audioBuffer[a],f=n[(this.fBuffers>>2)+a],c=f+t*this.fSampleSize>>Math.log2(this.fSampleSize),m=f+(t+u.length)*this.fSampleSize>>Math.log2(this.fSampleSize);console.log(`copyToOutReal32 begin: ${c}, end: ${m}, delta: ${m-c}`);let l=r.subarray(f+t*this.fSampleSize>>Math.log2(this.fSampleSize),f+(t+u.length)*this.fSampleSize>>Math.log2(this.fSampleSize));for(let g=0;g<u.length;g++)l[g]=u[g]}}copyToOutReal64(e,t,s){let n=this.fAllocator.getInt32Array(),r=this.fAllocator.getFloat64Array();for(let a=0;a<s.audioBuffer.length;a++){let u=s.audioBuffer[a],f=n[(this.fBuffers>>2)+a],c=f+t*this.fSampleSize>>Math.log2(this.fSampleSize),m=f+(t+u.length)*this.fSampleSize>>Math.log2(this.fSampleSize);console.log(`copyToOutReal64 begin: ${c}, end: ${m}, delta: ${m-c}`);let l=r.subarray(f+t*this.fSampleSize>>Math.log2(this.fSampleSize),f+(t+u.length)*this.fSampleSize>>Math.log2(this.fSampleSize));for(let g=0;g<u.length;g++)l[g]=u[g]}}emptyFile(e,t){if(this.fIntSize===4){let s=this.fAllocator.getInt32Array();s[(this.fLength>>Math.log2(this.fIntSize))+e]=F.BUFFER_SIZE,s[(this.fSR>>Math.log2(this.fIntSize))+e]=F.SAMPLE_RATE,s[(this.fOffset>>Math.log2(this.fIntSize))+e]=t}else{let s=this.fAllocator.getInt64Array();s[(this.fLength>>Math.log2(this.fIntSize))+e]=BigInt(F.BUFFER_SIZE),s[(this.fSR>>Math.log2(this.fIntSize))+e]=BigInt(F.SAMPLE_RATE),s[(this.fOffset>>Math.log2(this.fIntSize))+e]=BigInt(t)}return t+F.BUFFER_SIZE}displayMemory(e="",t=!1){console.log("Soundfile memory: "+e),console.log(`fPtr: ${this.fPtr}`),console.log(`fBuffers: ${this.fBuffers}`),console.log(`fLength: ${this.fLength}`),console.log(`fSR: ${this.fSR}`),console.log(`fOffset: ${this.fOffset}`);let s=this.fAllocator.getInt32Array();t&&console.log(`HEAP32: ${s}`),console.log(`HEAP32[this.fPtr >> 2]: ${s[this.fPtr>>2]}`),console.log(`HEAP32[(this.fPtr + ptrSize) >> 2]: ${s[this.fPtr+this.fPtrSize>>2]}`),console.log(`HEAP32[(this.fPtr + 2 * ptrSize) >> 2]: ${s[this.fPtr+2*this.fPtrSize>>2]}`),console.log(`HEAP32[(this.fPtr + 3 * ptrSize) >> 2]: ${s[this.fPtr+3*this.fPtrSize>>2]}`)}getPtr(){return this.fPtr}getHEAP32(){return this.fAllocator.getInt32Array()}getHEAPFloat32(){return this.fAllocator.getFloat32Array()}getHEAPFloat64(){return this.fAllocator.getFloat64Array()}};p(F,"Soundfile");var k=F,E=class E{constructor(e,t,s){this.fOutputHandler=null;this.fInputHandler=null;this.fComputeHandler=null;this.fNonFiniteHandler=null;this.fNonFiniteReported=!1;this.fPlotHandler=null;this.fCachedEvents=[];this.fBufferNum=0;this.fInChannels=[];this.fOutChannels=[];this.fOutputsTimer=5;this.fInputsItems=[];this.fOutputsItems=[];this.fDescriptor=[];this.fSoundfiles=[];this.fSoundfileBuffers={};this.fInBase=[];this.fOutBase=[];this.fPitchwheelLabel=[];this.fCtrlLabel=new Array(128).fill(null).map(()=>[]);this.fMidiKeyLabel=new Array(128).fill(null).map(()=>[]);this.fMidiKeyOnLabel=new Array(128).fill(null).map(()=>[]);this.fMidiKeyOffLabel=new Array(128).fill(null).map(()=>[]);this.fMidiChannel=0;this.fPathTable={};this.fUnknownPaths=new Set;this.fUICallback=p(e=>{if(e.type==="hbargraph"||e.type==="vbargraph"){let t=p(s=>{this.fPathTable[s]===void 0&&(this.fPathTable[s]=e.index)},"registerPath");this.fOutputsItems.push(e.address),t(e.address),t(e.shortname),t(e.label)}else if(e.type==="vslider"||e.type==="hslider"||e.type==="button"||e.type==="checkbox"||e.type==="nentry"){let t=p(s=>{this.fPathTable[s]===void 0&&(this.fPathTable[s]=e.index)},"registerPath");if(this.fInputsItems.push(e.address),t(e.address),t(e.shortname),t(e.label),this.fDescriptor.push(e),!e.meta)return;e.meta.forEach(s=>{var u,f,c,m,l,g;let{midi:n,acc:r,gyr:a}=s;if(n){let P=n.trim();if(P==="pitchwheel"){let C=P.match(/^pitchwheel\\s(\\d+)/);C?this.fPitchwheelLabel.push({path:e.address,chan:parseInt(C[1]),min:e.min,max:e.max}):this.fPitchwheelLabel.push({path:e.address,chan:0,min:e.min,max:e.max})}else{let C=P.match(/^ctrl\\s(\\d+)\\s(\\d+)/),L=P.match(/^ctrl\\s(\\d+)/),w=P.match(/^key\\s+(\\d+)(?:\\s+(\\d+))?$/),B=P.match(/^keyon\\s+(\\d+)(?:\\s+(\\d+))?$/),T=P.match(/^keyoff\\s+(\\d+)(?:\\s+(\\d+))?$/);if(C)this.fCtrlLabel[parseInt(C[1])].push({path:e.address,chan:parseInt(C[2]),min:e.min,max:e.max});else if(L)this.fCtrlLabel[parseInt(L[1])].push({path:e.address,chan:0,min:e.min,max:e.max});else if(w){let H=parseInt(w[1]),z=w[2]?parseInt(w[2]):0;this.fMidiKeyLabel[H].push({path:e.address,chan:z,min:(u=e.min)!=null?u:0,max:(f=e.max)!=null?f:1})}else if(B){let H=parseInt(B[1]),z=B[2]?parseInt(B[2]):0;this.fMidiKeyOnLabel[H].push({path:e.address,chan:z,min:(c=e.min)!=null?c:0,max:(m=e.max)!=null?m:1})}else if(T){let H=parseInt(T[1]),z=T[2]?parseInt(T[2]):0;this.fMidiKeyOffLabel[H].push({path:e.address,chan:z,min:(l=e.min)!=null?l:0,max:(g=e.max)!=null?g:1})}}}if(r){let P=r.trim().split(" ").map(Number);this.setupAccHandler(e.address,O.convertToAxis(P[0]),O.convertToCurve(P[1]),P[2],P[3],P[4],e.min,e.init,e.max)}if(a){let P=a.trim().split(" ").map(Number);this.setupGyrHandler(e.address,O.convertToAxis(P[0]),O.convertToCurve(P[1]),P[2],P[3],P[4],e.min,e.init,e.max)}})}else e.type==="soundfile"&&this.fSoundfiles.push({name:e.label,url:e.url,index:e.index,basePtr:-1})},"fUICallback");this.fProcessing=!1;this.fDestroyed=!1;this.fFirstCall=!0;this.fBufferSize=t,this.fPtrSize=e,this.fSampleSize=e,this.fSoundfileBuffers=s,this.fAcc={x:[],y:[],z:[]},this.fGyr={x:[],y:[],z:[]}}warnUnknownPath(e,t){this.fUnknownPaths.has(e)||(this.fUnknownPaths.add(e),console.warn(`Faust: unknown parameter path "${e}", ${t}. Use getParams() for the list of valid paths.`))}renderBlock(e,t){if(!e||e.length===0){t(0,this.fBufferSize);return}let s=0;for(let n=0;n<e.length;n++){let r=e[n],a=Math.min(Math.max(r.frame,0),this.fBufferSize);a>s&&(t(s,a-s),s=a),r.apply()}s<this.fBufferSize&&t(s,this.fBufferSize-s)}applyEvents(e){if(e)for(let t=0;t<e.length;t++)e[t].apply()}setBufferOffset(e){let t=e*this.fSampleSize;for(let s=0;s<this.fInBase.length;s++)this.fHEAP32[(this.fAudioInputs>>2)+s]=this.fInBase[s]+t;for(let s=0;s<this.fOutBase.length;s++)this.fHEAP32[(this.fAudioOutputs>>2)+s]=this.fOutBase[s]+t}static remap(e,t,s,n,r){return(e-t)/(s-t)*(r-n)+n}static parseUI(e,t){e.forEach(s=>this.parseGroup(s,t))}static parseGroup(e,t){e.items&&this.parseItems(e.items,t)}static parseItems(e,t){e.forEach(s=>this.parseItem(s,t))}static parseItem(e,t){e.type==="vgroup"||e.type==="hgroup"||e.type==="tgroup"?this.parseItems(e.items,t):t(e)}static splitSoundfileNames(e){return e.replace(/^\\{|\\}$/g,"").split(";").map(s=>s.length<=2?"":s.substring(1,s.length-1)).map(s=>s.trim()).filter(s=>s.length>0)}get hasAccInput(){return this.fAcc.x.length+this.fAcc.y.length+this.fAcc.z.length>0}propagateAcc(e,t=!1){let{x:s,y:n,z:r}=e;t?(s!==null&&this.fAcc.x.forEach(a=>a(-s)),n!==null&&this.fAcc.y.forEach(a=>a(-n)),r!==null&&this.fAcc.z.forEach(a=>a(-r))):(s!==null&&this.fAcc.x.forEach(a=>a(s)),n!==null&&this.fAcc.y.forEach(a=>a(n)),r!==null&&this.fAcc.z.forEach(a=>a(r)))}get hasGyrInput(){return this.fGyr.x.length+this.fGyr.y.length+this.fGyr.z.length>0}propagateGyr(e){let{alpha:t,beta:s,gamma:n}=e;t!==null&&this.fGyr.x.forEach(r=>r(t)),s!==null&&this.fGyr.y.forEach(r=>r(s)),n!==null&&this.fGyr.z.forEach(r=>r(n))}setupAccHandler(e,t,s,n,r,a,u,f,c){let m=O.buildHandler(s,n,r,a,u,f,c);switch(t){case 0:this.fAcc.x.push(l=>this.setParamValue(e,m.uiToFaust(l)));break;case 1:this.fAcc.y.push(l=>this.setParamValue(e,m.uiToFaust(l)));break;case 2:this.fAcc.z.push(l=>this.setParamValue(e,m.uiToFaust(l)));break}}setupGyrHandler(e,t,s,n,r,a,u,f,c){let m=O.buildHandler(s,n,r,a,u,f,c);switch(t){case 0:this.fGyr.x.push(l=>this.setParamValue(e,m.uiToFaust(l)));break;case 1:this.fGyr.y.push(l=>this.setParamValue(e,m.uiToFaust(l)));break;case 2:this.fGyr.z.push(l=>this.setParamValue(e,m.uiToFaust(l)));break}}static extractUrlsFromMeta(e){let t=e.meta.find(s=>s.soundfiles!==void 0);return t?t.soundfiles.split(";").filter(s=>s!==""):[]}loadSoundfile(e,t,s,n){console.log(`Soundfile ${s} paths: ${n}`);let r=E.splitSoundfileNames(n),a=this.fSoundfiles.find(u=>u.url===n);if(!a)throw new Error(`Soundfile with ${n} cannot be found !}`);if(a.basePtr!==-1){let u=e.getInt32Array();console.log(`Soundfile CACHE ${n}} : ${s} loaded at ${a.basePtr} in wasm memory with index ${a.index}`),u[t+a.index>>2]=a.basePtr}else{let u=this.createSoundfile(e,r,this.fSoundfileBuffers);if(u){let f=u.getHEAP32();a.basePtr=u.getPtr(),console.log(`Soundfile ${s} loaded at ${a.basePtr} in wasm memory with index ${a.index}`),f[t+a.index>>2]=a.basePtr}else console.log(`Soundfile ${s} for ${n} cannot be created !}`)}}createSoundfile(e,t,s,n){let r=1,a=0;for(let c of t){let m=0,l=0,g=s==null?void 0:s[c];g?(m=g.audioBuffer.length,l=g.audioBuffer[0].length):(l=k.BUFFER_SIZE,m=1),r=Math.max(r,m),a+=l}a+=(k.MAX_SOUNDFILE_PARTS-t.length)*k.BUFFER_SIZE;let u=new k(e,this.fSampleSize,r,a,r,t.length),f=0;for(let c=0;c<t.length;c++){let m=t[c],l=s==null?void 0:s[m];l?(u.copyToOut(c,r,f,l),f+=l.audioBuffer[0].length):f=u.emptyFile(c,f)}for(let c=t.length;c<k.MAX_SOUNDFILE_PARTS;c++)f=u.emptyFile(c,f);return u}initSoundfileMemory(e,t){for(let{name:s,url:n}of this.fSoundfiles)this.loadSoundfile(e,t,s,n)}updateOutputs(){this.fOutputsItems.length>0&&this.fOutputHandler&&this.fOutputsTimer--===0&&(this.fOutputsTimer=5,this.fOutputsItems.forEach(e=>{var t;return(t=this.fOutputHandler)==null?void 0:t.call(this,e,this.getParamValue(e))}))}metadata(e){this.fJSONDsp.meta&&this.fJSONDsp.meta.forEach(t=>e(Object.keys(t)[0],t[Object.keys(t)[0]]))}compute(e,t){return!1}setOutputParamHandler(e){this.fOutputHandler=e}getOutputParamHandler(){return this.fOutputHandler}callOutputParamHandler(e,t){this.fOutputHandler&&this.fOutputHandler(e,t)}setInputParamHandler(e){this.fInputHandler=e}getInputParamHandler(){return this.fInputHandler}callInputParamHandler(e,t){this.fInputHandler&&this.fInputHandler(e,t)}setComputeHandler(e){this.fComputeHandler=e}getComputeHandler(){return this.fComputeHandler}setPlotHandler(e){this.fPlotHandler=e}getPlotHandler(){return this.fPlotHandler}setNonFiniteHandler(e){this.fNonFiniteHandler=e}getNonFiniteHandler(){return this.fNonFiniteHandler}clearNonFinite(){if(!this.fNonFiniteHandler)return;let e=!1,t=this.getNumOutputs();for(let s=0;s<t;s++){let n=this.fOutChannels[s],r=0;for(let a=0;a<n.length;a++)r+=n[a];if(r-r!==0)for(let a=0;a<n.length;a++){let u=n[a];u-u!==0&&(n[a]=0,e=!0)}}e&&!this.fNonFiniteReported&&(this.fNonFiniteReported=!0,this.fNonFiniteHandler())}getNumInputs(){return-1}getNumOutputs(){return-1}static parseMidiChannel(e){if(!e)return 0;let t,s="";for(let r of e)if(typeof r.options=="string"){let a=r.options.match(/\\[midichannel:([^\\]]*)\\]/);a&&(t=a[1],s="[midichannel] option")}if(t===void 0)for(let r of e)typeof r.midichannel=="string"&&(t=r.midichannel,s="midichannel metadata");if(t===void 0||t.trim()==="")return 0;let n=/^\\s*\\d+\\s*$/.test(t)?Number(t):NaN;return n>=0&&n<=16?n:(console.warn(`Faust: invalid MIDI channel \'${t}\' in ${s}: should be in 1..16, or 0 for all channels`),0)}setMidiChannel(e){this.fMidiChannel=Number.isInteger(e)&&e>=0&&e<=16?e:0}getMidiChannel(){return this.fMidiChannel}acceptMidiStatus(e){return this.fMidiChannel===0||e>=240||(e&15)===this.fMidiChannel-1}midiMessage(e){if(!this.acceptMidiStatus(e[0]))return;this.fPlotHandler&&this.fCachedEvents.push({data:e,type:"midi"});let t=e[0]>>4,s=e[0]&15,n=e[1],r=e[2];if(t===11)return this.ctrlChange(s,n,r);if(t===14)return this.pitchWheel(s,r*128+n);if(t===9)return r>0?this.keyOn(s,n,r):this.keyOff(s,n,r);if(t===8)return this.keyOff(s,n,r)}ctrlChange(e,t,s){this.fPlotHandler&&this.fCachedEvents.push({type:"ctrlChange",data:[e,t,s]}),this.fCtrlLabel[t].length&&this.fCtrlLabel[t].forEach(n=>{let{path:r,chan:a}=n;(a===0||e===a-1)&&(this.setParamValue(r,E.remap(s,0,127,n.min,n.max)),this.fOutputHandler&&this.fOutputHandler(r,this.getParamValue(r)))})}keyOn(e,t,s){this.fPlotHandler&&this.fCachedEvents.push({type:"keyOn",data:[e,t,s]}),this.fMidiKeyOnLabel[t].forEach(n=>{let{path:r,chan:a}=n;(a===0||e===a-1)&&(this.setParamValue(r,E.remap(s,0,127,n.min,n.max)),this.fOutputHandler&&this.fOutputHandler(r,this.getParamValue(r)))}),this.fMidiKeyLabel[t].forEach(n=>{let{path:r,chan:a}=n;(a===0||e===a-1)&&(this.setParamValue(r,E.remap(s,0,127,n.min,n.max)),this.fOutputHandler&&this.fOutputHandler(r,this.getParamValue(r)))})}keyOff(e,t,s){this.fPlotHandler&&this.fCachedEvents.push({type:"keyOff",data:[e,t,s]}),this.fMidiKeyOffLabel[t].forEach(n=>{let{path:r,chan:a}=n;(a===0||e===a-1)&&(this.setParamValue(r,E.remap(s,0,127,n.min,n.max)),this.fOutputHandler&&this.fOutputHandler(r,this.getParamValue(r)))}),this.fMidiKeyLabel[t].forEach(n=>{let{path:r,chan:a}=n;(a===0||e===a-1)&&(this.setParamValue(r,0),this.fOutputHandler&&this.fOutputHandler(r,this.getParamValue(r)))})}pitchWheel(e,t){this.fPlotHandler&&this.fCachedEvents.push({type:"pitchWheel",data:[e,t]}),this.fPitchwheelLabel.forEach(s=>{let{path:n,chan:r}=s;(r===0||e===r-1)&&(this.setParamValue(n,E.remap(t,0,16383,s.min,s.max)),this.fOutputHandler&&this.fOutputHandler(n,this.getParamValue(n)))})}setParamValue(e,t){}getParamValue(e){return 0}getParams(){return this.fInputsItems}getMeta(){return this.fJSONDsp}getJSON(){return JSON.stringify(this.getMeta())}getUI(){return this.fJSONDsp.ui}getDescriptors(){return this.fDescriptor}hasSoundfiles(){return this.fSoundfiles.length>0}startSensors(){this.startSensors()}stopSensors(){this.stopSensors()}init(){}instanceInit(){}instanceClear(){}instanceConstants(){}instanceResetUserInterface(){}start(){this.fProcessing=!0}stop(){this.fProcessing=!1}destroy(){this.fDestroyed=!0,this.fOutputHandler=null,this.fInputHandler=null,this.fComputeHandler=null,this.fPlotHandler=null}};p(E,"FaustBaseWebAudioDsp");var V=E;var x=class x{constructor(e,t,s,n,r){this.fFreqLabel=[];this.fGateLabel=[];this.fGainLabel=[];this.fKeyLabel=[];this.fVelLabel=[];this.fCurNote=x.kFreeVoice;this.fNextNote=-1;this.fNextVel=-1;this.fChannel=0;this.fDate=0;this.fLevel=0;this.fDSP=e,this.fAPI=t,this.fSampleRate=r,this.init(r),this.extractPaths(s,n)}static get kActiveVoice(){return 0}static get kFreeVoice(){return-1}static get kReleaseVoice(){return-2}static get kLegatoVoice(){return-3}static get kNoVoice(){return-4}static get VOICE_STOP_LEVEL(){return 3162e-8}static midiToFreq(e){return 440*2**((e-69)/12)}static normalizeVelocity(e){return e/127}init(e){this.fAPI.init(this.fDSP,e)}instanceInit(){this.fAPI.instanceInit(this.fDSP,this.fSampleRate)}instanceClear(){this.fAPI.instanceClear(this.fDSP)}instanceConstants(){this.fAPI.instanceConstants(this.fDSP,this.fSampleRate)}instanceResetUserInterface(){this.fAPI.instanceResetUserInterface(this.fDSP)}extractPaths(e,t){e.forEach(s=>{s.endsWith("/gate")?this.fGateLabel.push(t[s]):s.endsWith("/freq")?this.fFreqLabel.push(t[s]):s.endsWith("/key")?this.fKeyLabel.push(t[s]):s.endsWith("/gain")?this.fGainLabel.push(t[s]):(s.endsWith("/vel")||s.endsWith("/velocity"))&&this.fVelLabel.push(t[s])})}keyOn(e,t,s=!1){s?(this.fNextNote=e,this.fNextVel=t):(this.fFreqLabel.forEach(n=>this.fAPI.setParamValue(this.fDSP,n,x.midiToFreq(e))),this.fGateLabel.forEach(n=>this.fAPI.setParamValue(this.fDSP,n,1)),this.fGainLabel.forEach(n=>this.fAPI.setParamValue(this.fDSP,n,x.normalizeVelocity(t))),this.fKeyLabel.forEach(n=>this.fAPI.setParamValue(this.fDSP,n,e)),this.fVelLabel.forEach(n=>this.fAPI.setParamValue(this.fDSP,n,t)),this.fCurNote=e)}keyOff(e=!1){this.fGateLabel.forEach(t=>this.fAPI.setParamValue(this.fDSP,t,0)),e?this.fCurNote=x.kFreeVoice:this.fCurNote=x.kReleaseVoice}computeLegato(e,t,s,n){let r=e>>1;this.fGateLabel.forEach(a=>this.fAPI.setParamValue(this.fDSP,a,0)),this.fAPI.compute(this.fDSP,r,t,s),this.keyOn(this.fNextNote,this.fNextVel),this.fAPI.compute(this.fDSP,e-r,t,n)}compute(e,t,s){this.fAPI.compute(this.fDSP,e,t,s)}setParamValue(e,t){this.fAPI.setParamValue(this.fDSP,e,t)}getParamValue(e){return this.fAPI.getParamValue(this.fDSP,e)}};p(x,"FaustWebAudioDspVoice");var I=x,U=class U extends V{constructor(t,s,n,r,a,u=I.VOICE_STOP_LEVEL){super(n,r,a);this.fMixingBase=[];this.fStolen=[];this.fActiveVoices=0;this.fActiveVoicesHandler=null;this.fStopLevel=I.VOICE_STOP_LEVEL;this.fRenderSlice=p((t,s)=>{this.setBufferOffset(t),this.setMixingOffset(t,s),this.fVoiceTable.forEach(n=>{if(n.fCurNote===I.kFreeVoice||this.fStolen.length&&this.fStolen.indexOf(n)!==-1)return;n.compute(s,this.fAudioInputs,this.fAudioMixing);let r=this.fInstance.mixerAPI.mixCheckVoice(s,this.getNumOutputs(),this.fAudioMixing,this.fAudioOutputs);r>n.fLevel&&(n.fLevel=r)}),this.fInstance.effectAPI&&this.fInstance.effectAPI.compute(this.fEffect,s,this.fAudioOutputs,this.fAudioOutputs)},"fRenderSlice");this.fDate=0;this.fInstance=t,this.fSampleRate=s,typeof u=="number"&&u>0&&u<=.01?this.fStopLevel=u:console.warn(`Invalid stop level ${u}, using default`),this.fJSONDsp=JSON.parse(this.fInstance.voiceJSON),this.fMidiChannel=V.parseMidiChannel(this.fJSONDsp.meta),this.fJSONEffect=this.fInstance.effectAPI&&this.fInstance.effectJSON?JSON.parse(this.fInstance.effectJSON):null,V.parseUI(this.fJSONDsp.ui,this.fUICallback),this.fJSONEffect&&V.parseUI(this.fJSONEffect.ui,this.fUICallback),this.fEndMemory=this.initMemory(),this.fVoiceTable=[];for(let f=0;f<this.fInstance.voices;f++)this.fVoiceTable.push(new I(this.fJSONDsp.size*f,this.fInstance.voiceAPI,this.fInputsItems,this.fPathTable,s));if(this.fInstance.effectAPI&&this.fInstance.effectAPI.init(this.fEffect,s),this.fSoundfiles.length>0){let f=new ie(this.fInstance.memory,this.fEndMemory);for(let c=0;c<this.fInstance.voices;c++)this.initSoundfileMemory(f,this.fJSONDsp.size*c)}}renderStolenVoices(){let t=this.fStolen;t.length=0,this.fVoiceTable.forEach(s=>{s.fCurNote===I.kLegatoVoice&&(t.push(s),s.computeLegato(this.fBufferSize,this.fAudioInputs,this.fAudioMixing,this.fAudioMixingHalf),this.fInstance.mixerAPI.fadeOut(this.fBufferSize>>1,this.getNumOutputs(),this.fAudioMixing),this.fadeIn(this.fBufferSize-(this.fBufferSize>>1),this.getNumOutputs(),this.fAudioMixingHalf),s.fLevel=this.fInstance.mixerAPI.mixCheckVoice(this.fBufferSize,this.getNumOutputs(),this.fAudioMixing,this.fAudioOutputs))})}fadeIn(t,s,n){let r=Math.log2(this.fSampleSize),a=this.fHEAPF;for(let u=0;u<s;u++){let f=this.fHEAP32[(n>>2)+u]>>r;for(let c=0;c<t;c++)a[f+c]*=(c+1)/t}}setMixingOffset(t,s){let n=t*this.fSampleSize,r=(t+(s>>1))*this.fSampleSize;for(let a=0;a<this.fMixingBase.length;a++)this.fHEAP32[(this.fAudioMixing>>2)+a]=this.fMixingBase[a]+n,this.fHEAP32[(this.fAudioMixingHalf>>2)+a]=this.fMixingBase[a]+r}init(){this.fVoiceTable.forEach(t=>t.init(this.fSampleRate)),this.fInstance.effectAPI&&this.fInstance.effectAPI.init(this.fEffect,this.fSampleRate)}instanceInit(){this.fVoiceTable.forEach(t=>t.instanceInit()),this.fInstance.effectAPI&&this.fInstance.effectAPI.instanceInit(this.fEffect,this.fSampleRate)}instanceClear(){this.fVoiceTable.forEach(t=>t.instanceClear()),this.fInstance.effectAPI&&this.fInstance.effectAPI.instanceClear(this.fEffect)}instanceConstants(){this.fVoiceTable.forEach(t=>t.instanceConstants()),this.fInstance.effectAPI&&this.fInstance.effectAPI.instanceConstants(this.fEffect,this.fSampleRate)}instanceResetUserInterface(){this.fVoiceTable.forEach(t=>t.instanceResetUserInterface()),this.fInstance.effectAPI&&this.fInstance.effectAPI.instanceResetUserInterface(this.fEffect)}initMemory(){this.fEffect=this.fJSONDsp.size*this.fInstance.voices;let t=this.fEffect+(this.fJSONEffect?this.fJSONEffect.size:0);this.fAudioInputs=t,this.fAudioOutputs=this.fAudioInputs+this.getNumInputs()*this.fPtrSize,this.fAudioMixing=this.fAudioOutputs+this.getNumOutputs()*this.fPtrSize,this.fAudioMixingHalf=this.fAudioMixing+this.getNumOutputs()*this.fPtrSize;let s=this.fAudioMixingHalf+this.getNumOutputs()*this.fPtrSize,n=s+this.getNumInputs()*this.fBufferSize*this.fSampleSize,r=n+this.getNumOutputs()*this.fBufferSize*this.fSampleSize,a=r+this.getNumOutputs()*this.fBufferSize*this.fSampleSize,u=this.fInstance.memory.buffer,f=new Int32Array(u),c=this.fSampleSize===4?new Float32Array(u):new Float64Array(u);if(this.getNumInputs()>0){for(let l=0;l<this.getNumInputs();l++)f[(this.fAudioInputs>>2)+l]=s+this.fBufferSize*this.fSampleSize*l;let m=f.subarray(this.fAudioInputs>>2,this.fAudioInputs+this.getNumInputs()*this.fPtrSize>>2);for(let l=0;l<this.getNumInputs();l++)this.fInChannels[l]=c.subarray(m[l]>>Math.log2(this.fSampleSize),m[l]+this.fBufferSize*this.fSampleSize>>Math.log2(this.fSampleSize))}if(this.getNumOutputs()>0){for(let l=0;l<this.getNumOutputs();l++)f[(this.fAudioOutputs>>2)+l]=n+this.fBufferSize*this.fSampleSize*l,f[(this.fAudioMixing>>2)+l]=r+this.fBufferSize*this.fSampleSize*l,f[(this.fAudioMixingHalf>>2)+l]=r+this.fBufferSize*this.fSampleSize*l+this.fBufferSize/2*this.fSampleSize;let m=f.subarray(this.fAudioOutputs>>2,this.fAudioOutputs+this.getNumOutputs()*this.fPtrSize>>2);for(let l=0;l<this.getNumOutputs();l++)this.fOutChannels[l]=c.subarray(m[l]>>Math.log2(this.fSampleSize),m[l]+this.fBufferSize*this.fSampleSize>>Math.log2(this.fSampleSize))}this.fHEAP32=f,this.fInBase=[];for(let m=0;m<this.getNumInputs();m++)this.fInBase[m]=f[(this.fAudioInputs>>2)+m];this.fHEAPF=c,this.fOutBase=[],this.fMixingBase=[];for(let m=0;m<this.getNumOutputs();m++)this.fOutBase[m]=f[(this.fAudioOutputs>>2)+m],this.fMixingBase[m]=f[(this.fAudioMixing>>2)+m];return a}toString(){return`============== Poly Memory layout ==============\n        this.fBufferSize: ${this.fBufferSize}\n        this.fJSONDsp.size: ${this.fJSONDsp.size}\n        this.fAudioInputs: ${this.fAudioInputs}\n        this.fAudioOutputs: ${this.fAudioOutputs}\n        this.fAudioMixing: ${this.fAudioMixing}\n        this.fAudioMixingHalf: ${this.fAudioMixingHalf}`}allocVoice(t,s){return this.fVoiceTable[t].fDate=this.fDate++,this.fVoiceTable[t].fCurNote=s,t}getPlayingVoice(t,s){let n=I.kNoVoice,r=Number.MAX_VALUE;for(let a=0;a<this.fInstance.voices;a++){if(this.fVoiceTable[a].fChannel!==t)continue;let u=this.fVoiceTable[a].fCurNote,f=this.fVoiceTable[a].fNextNote;(u===s||u===I.kLegatoVoice&&f===s)&&this.fVoiceTable[a].fDate<r&&(r=this.fVoiceTable[a].fDate,n=a)}return n}getFreeVoice(){for(let a=0;a<this.fInstance.voices;a++)if(this.fVoiceTable[a].fCurNote===I.kFreeVoice)return this.allocVoice(a,I.kActiveVoice);let t=I.kNoVoice,s=I.kNoVoice,n=Number.MAX_VALUE,r=Number.MAX_VALUE;for(let a=0;a<this.fInstance.voices;a++)this.fVoiceTable[a].fCurNote===I.kReleaseVoice?this.fVoiceTable[a].fDate<n&&(n=this.fVoiceTable[a].fDate,t=a):this.fVoiceTable[a].fDate<r&&(r=this.fVoiceTable[a].fDate,s=a);return n!==Number.MAX_VALUE?(console.log(`Steal release voice : voice_date = ${this.fVoiceTable[t].fDate} voice = ${t}`),this.allocVoice(t,I.kLegatoVoice)):r!==Number.MAX_VALUE?(console.log(`Steal playing voice : voice_date = ${this.fVoiceTable[s].fDate} voice = ${s}`),this.allocVoice(s,I.kLegatoVoice)):I.kNoVoice}compute(t,s,n){if(this.fDestroyed)return!1;if(this.fFirstCall&&(this.initMemory(),this.fFirstCall=!1),!this.fProcessing)return this.applyEvents(n),!0;if(this.getNumInputs()>0&&(!t||!t[0]||t[0].length===0))return this.applyEvents(n),!0;if(this.getNumOutputs()>0&&(!s||!s[0]||s[0].length===0))return this.applyEvents(n),!0;if(t!==void 0)for(let r=0;r<Math.min(this.getNumInputs(),t.length);++r)this.fInChannels[r].set(t[r]);if(this.fComputeHandler&&this.fComputeHandler(this.fBufferSize),this.setBufferOffset(0),this.setMixingOffset(0,this.fBufferSize),this.fInstance.mixerAPI.clearOutput(this.fBufferSize,this.getNumOutputs(),this.fAudioOutputs),this.fVoiceTable.forEach(r=>r.fLevel=0),this.renderStolenVoices(),this.renderBlock(n,this.fRenderSlice),this.fVoiceTable.forEach(r=>{r.fCurNote===I.kReleaseVoice&&r.fLevel<this.fStopLevel&&(r.fCurNote=I.kFreeVoice)}),this.fActiveVoicesHandler){let r=this.getNumActiveVoices();r!==this.fActiveVoices&&(this.fActiveVoices=r,this.fActiveVoicesHandler(r))}if(this.updateOutputs(),this.clearNonFinite(),s!==void 0){for(let r=0;r<Math.min(this.getNumOutputs(),s.length);r++){let a=this.fOutChannels[r];s[r].set(a)}this.fPlotHandler&&(this.fPlotHandler(s,this.fBufferNum++,this.fCachedEvents.length?this.fCachedEvents:void 0),this.fCachedEvents=[])}return!0}getNumInputs(){return this.fInstance.voiceAPI.getNumInputs(0)}getNumOutputs(){return this.fInstance.voiceAPI.getNumOutputs(0)}static findPath(t,s){if(typeof t!="object")return!1;if(t.address)return t.address===s;for(let n in t)if(U.findPath(t[n],s))return!0;return!1}setParamValue(t,s){let n=this.fPathTable[t];if(n===void 0)return this.warnUnknownPath(t,"ignored");this.fPlotHandler&&this.fCachedEvents.push({type:"param",data:{path:t,value:s}}),this.fJSONEffect&&U.findPath(this.fJSONEffect.ui,t)&&this.fInstance.effectAPI?this.fInstance.effectAPI.setParamValue(this.fEffect,n,s):this.fVoiceTable.forEach(r=>r.setParamValue(n,s)),this.callInputParamHandler(t,this.getParamValue(t))}getParamValue(t){let s=this.fPathTable[t];return s===void 0?(this.warnUnknownPath(t,"returning 0"),0):this.fJSONEffect&&U.findPath(this.fJSONEffect.ui,t)&&this.fInstance.effectAPI?this.fInstance.effectAPI.getParamValue(this.fEffect,s):this.fVoiceTable[0].getParamValue(s)}getMeta(){let t=this.fJSONDsp,s=this.fJSONEffect,n={...t};return s?n.ui=[{type:"tgroup",label:"Sequencer",items:[{type:"vgroup",label:"Instrument",items:t.ui},{type:"vgroup",label:"Effect",items:s.ui}]}]:n.ui=[{type:"tgroup",label:"Polyphonic",items:[{type:"vgroup",label:"Voices",items:t.ui}]}],n}getJSON(){return JSON.stringify(this.getMeta())}getUI(){return this.getMeta().ui}getDescriptors(){return this.fDescriptor}midiMessage(t){if(!this.acceptMidiStatus(t[0]))return;let s=t[0]>>4,n=t[0]&15,r=t[1],a=t[2];if(s===8||s===9&&a===0)return this.keyOff(n,r,a);if(s===9)return this.keyOn(n,r,a);super.midiMessage(t)}ctrlChange(t,s,n){s===123?this.channelNotesOff(t,!1):s===120?this.channelNotesOff(t,!0):super.ctrlChange(t,s,n)}channelNotesOff(t,s){this.fPlotHandler&&this.fCachedEvents.push({type:"ctrlChange",data:[t,s?120:123,0]});for(let n=0;n<this.fVoiceTable.length;n++){let r=this.fVoiceTable[n];r.fChannel===t&&r.fCurNote!==I.kFreeVoice&&r.keyOff(s)}}keyOn(t,s,n){this.fPlotHandler&&this.fCachedEvents.push({type:"keyOn",data:[t,s,n]});let r=this.getFreeVoice();this.fVoiceTable[r].fChannel=t,this.fVoiceTable[r].keyOn(s,n,this.fVoiceTable[r].fCurNote==I.kLegatoVoice)}keyOff(t,s,n){this.fPlotHandler&&this.fCachedEvents.push({type:"keyOff",data:[t,s,n]});let r=this.getPlayingVoice(t,s);r!==I.kNoVoice?this.fVoiceTable[r].keyOff():console.log(`Playing pitch = %d not found\n`,s)}allNotesOff(t=!0){this.fCachedEvents.push({type:"ctrlChange",data:[0,123,0]}),this.fVoiceTable.forEach(s=>s.keyOff(t))}getNumActiveVoices(){let t=0;for(let s=0;s<this.fVoiceTable.length;s++)this.fVoiceTable[s].fCurNote!==I.kFreeVoice&&t++;return t}setActiveVoicesHandler(t){this.fActiveVoicesHandler=t,this.fActiveVoices=this.getNumActiveVoices()}getActiveVoicesHandler(){return this.fActiveVoicesHandler}};p(U,"FaustPolyWebAudioDsp");var K=U;fe({FaustBaseWebAudioDsp:V,FaustMonoWebAudioDsp:void 0,FaustPolyWebAudioDsp:K,FaustWebAudioDspVoice:I,FaustWasmInstantiator:le,FaustAudioWorkletProcessorCommunicator:q},faustData);})();\n';
var fftProcessorSource = '(()=>{var be=Object.defineProperty;var b=(j,e)=>be(j,"name",{value:e,configurable:!0});var ge=b((j,e,t=!0)=>{let{registerProcessor:s,AudioWorkletProcessor:n,sampleRate:r}=globalThis,i=globalThis,a=128,{FaustBaseWebAudioDsp:d,FaustWasmInstantiator:c,FaustMonoWebAudioDsp:l,FaustAudioWorkletProcessorCommunicator:g,FFTUtils:P}=j,{processorName:v,dspName:H,dspMeta:$,fftOptions:O}=e,{windowFunctions:x,getFFT:L,fftToSignal:T,signalToFFT:B,signalToNoFFT:he}=P,ce=b((y,F)=>Math.abs(F)<1?Math.ceil(y*(1/F))/(1/F):Math.ceil(y/F)*F,"ceil"),R=b((y,F)=>(y%F+F)%F,"mod"),pe=b((y,F)=>{for(let h=0;h<y.length;h++)y[h]*=F(h,y.length)},"apply"),K=["/fftSize","/fftHopSize","/fftOverlap","/windowFunction","/noIFFT"],q=b((y,F,h=0,f=0)=>{let u=y.length,o=F.length,p=Math.min(u,o),m=0,A=R(h,u)||0,D=R(f,o)||0;for(;m<p;){let I=Math.min(p-m,u-A,o-D),M=D+I;D===0&&M===o?y.set(F,A):y.set(F.subarray(D,M),A),A=(A+I)%u,D=M%o,m+=I}return A},"setTypedArray"),me=b(y=>"address"in y&&!!K.find(h=>y.address.endsWith(h))?null:y.type==="vslider"||y.type==="hslider"||y.type==="nentry"?{name:y.address,defaultValue:y.init||0,minValue:y.min||0,maxValue:y.max||0}:y.type==="button"||y.type==="checkbox"?{name:y.address,defaultValue:y.init||0,minValue:0,maxValue:1}:null,"analyseParameters"),X=class X extends n{constructor(h){super(h);this.paramValuesCache={};this.fEventQueue=[];this.destroyed=!1;this.$inputWrite=0;this.$inputRead=0;this.$outputWrite=0;this.$outputRead=0;this.noIFFT=!1;this.fftInput=[];this.fftOutput=[];this.fftOverlap=0;this.fftHopSize=0;this.fftSize=0;this.fftBufferSize=0;this.fPlotHandler=null;this.fNonFiniteHandler=null;this.fCachedEvents=[];this.fBufferNum=0;this.soundfiles={};this.windowFunction=null;this.handleMessageAux=b(h=>{var u,o,p,m;let f=h.data;switch(f.type){case"midi":this.atTime(f,()=>this.midiMessage(f.data));break;case"ctrlChange":this.atTime(f,()=>this.ctrlChange(f.data[0],f.data[1],f.data[2]));break;case"pitchWheel":this.atTime(f,()=>this.pitchWheel(f.data[0],f.data[1]));break;case"param":this.atTime(f,()=>this.setParamValue(f.data.path,f.data.value));break;case"setPlotHandler":{f.data?this.fPlotHandler=(A,D,I)=>{I&&this.fCachedEvents.push(...I)}:this.fPlotHandler=null,(u=this.fDSPCode)==null||u.setPlotHandler(this.fPlotHandler);break}case"setNonFiniteHandler":{this.fNonFiniteHandler=f.data?()=>this.port.postMessage({type:"nonfinite"}):null,(o=this.fDSPCode)==null||o.setNonFiniteHandler(this.fNonFiniteHandler);break}case"setupWamEventHandler":{this.setupWamEventHandler();break}case"start":{(p=this.fDSPCode)==null||p.start();break}case"stop":{this.fEventQueue.length=0,(m=this.fDSPCode)==null||m.stop();break}case"destroy":{this.fEventQueue.length=0,this.port.close(),this.destroy();break}default:break}},"handleMessageAux");this.port.addEventListener("message",this.handleMessageAux),this.port.start(),this.communicator=new g(this.port);let{parameterDescriptors:f}=this.constructor;f.forEach(A=>{this.paramValuesCache[A.name]=A.defaultValue||0});let{factory:u,sampleSize:o}=h.processorOptions;this.dspInstance=c.createSyncMonoDSPInstance(u),this.sampleSize=o,this.soundfiles=u.soundfiles,this.initFFT();let{moduleId:p,instanceId:m}=h.processorOptions;!p||!m||(this.wamInfo={moduleId:p,instanceId:m})}get fftProcessorBufferSize(){return this.fftSize/2+1}async initFFT(){return this.FFT=await L(),await this.createFFTProcessor(),!0}static get parameterDescriptors(){let h=[],f=b(u=>{let o=me(u);o&&h.push(o)},"callback");return d.parseUI($.ui,f),[...h,{defaultValue:(O==null?void 0:O.fftSize)||1024,maxValue:4294967296,minValue:2,name:"fftSize"},{defaultValue:(O==null?void 0:O.fftOverlap)||2,maxValue:32,minValue:1,name:"fftOverlap"},{defaultValue:typeof(O==null?void 0:O.defaultWindowFunction)=="number"?O.defaultWindowFunction+1:0,maxValue:(x==null?void 0:x.length)||0,minValue:0,name:"windowFunction"},{defaultValue:+!!(O!=null&&O.noIFFT)||0,maxValue:1,minValue:0,name:"noIFFT"}]}setupWamEventHandler(){var m;if(!this.wamInfo)return;let{moduleId:h,instanceId:f}=this.wamInfo,{webAudioModules:u}=globalThis,o=u.getModuleScope(h),p=(m=o==null?void 0:o.paramMgrProcessors)==null?void 0:m[f];p&&(p.handleEvent||(p.handleEvent=A=>{A.type==="wam-midi"&&this.atTime(A,()=>this.midiMessage(A.data.bytes))}))}processFFT(){let h=R(this.$inputWrite-this.$inputRead,this.fftBufferSize)||this.fftBufferSize;for(;h>=this.fftSize;){let f=[];this.fDSPCode.compute(u=>{for(let o=0;o<Math.min(this.fftInput.length,Math.ceil(u.length/3));o++){let p=this.rfft.forward(m=>{q(m,this.fftInput[o],0,this.$inputRead);for(let A=0;A<m.length;A++)m[A]*=this.window[A]});T(p,u[o*3],u[o*3+1],u[o*3+2])}for(let o=this.fftInput.length*3;o<u.length;o++)o%3===2?u[o].forEach((p,m)=>u[o][m]=m):u[o].fill(0)},u=>{f=u}),this.$inputRead+=this.fftHopSize,this.$inputRead%=this.fftBufferSize,h-=this.fftHopSize;for(let u=0;u<this.fftOutput.length;u++){let o;this.noIFFT?(o=this.noIFFTBuffer,he(f[u*2]||this.fftProcessorZeros,f[u*2+1]||this.fftProcessorZeros,o)):o=this.rfft.inverse(m=>{B(f[u*2]||this.fftProcessorZeros,f[u*2+1]||this.fftProcessorZeros,m)});for(let m=0;m<o.length;m++)o[m]*=this.window[m];let p;for(let m=0;m<o.length-this.fftHopSize;m++)p=R(this.$outputWrite+m,this.fftBufferSize),this.fftOutput[u][p]+=o[m],u===0&&(this.windowSumSquare[p]+=this.noIFFT?this.window[m]:this.window[m]**2);for(let m=o.length-this.fftHopSize;m<o.length;m++)p=R(this.$outputWrite+m,this.fftBufferSize),this.fftOutput[u][p]=o[m],u===0&&(this.windowSumSquare[p]=this.noIFFT?this.window[m]:this.window[m]**2)}this.$outputWrite+=this.fftHopSize,this.$outputWrite%=this.fftBufferSize}}process(h,f,u){if(this.destroyed)return!1;if(!this.FFT)return!0;let o=h[0],p=f[0],m=(o==null?void 0:o.length)||0,A=(p==null?void 0:p.length)||0,D=o!=null&&o.length&&Math.max(...o.map(I=>I.length))||128;if(this.noIFFT=!!u.noIFFT[0],this.resetFFT(~~u.fftSize[0],~~u.fftOverlap[0],~~u.windowFunction[0],m,A,D),!this.fDSPCode)return!0;this.applyDueEvents(i.currentFrame);for(let I in u){if(K.find(E=>`/${I}`.endsWith(E)))continue;let[M]=u[I];M!==this.paramValuesCache[I]&&this.setParamValue(I,M)}if(this.communicator.getNewAccDataAvailable()){let I=this.communicator.getAcc();if(I){this.communicator.setNewAccDataAvailable(!1);let{invert:M,...E}=I;this.propagateAcc(E,M)}}if(this.communicator.getNewGyrDataAvailable()){let I=this.communicator.getGyr();I&&(this.communicator.setNewGyrDataAvailable(!1),this.propagateGyr(I))}if(o!=null&&o.length){let I=0;for(let M=0;M<o.length;M++){let E=this.fftInput[M],U=o[M].length?o[M]:new Float32Array(D);I=q(E,U,this.$inputWrite)}this.$inputWrite=I}else this.$inputWrite+=D,this.$inputWrite%=this.fftBufferSize;this.processFFT();for(let I=0;I<p.length;I++){q(p[I],this.fftOutput[I],0,this.$outputRead);let M=0;for(let E=0;E<D;E++)M=this.windowSumSquare[R(this.$outputRead+E,this.fftBufferSize)],p[I][E]/=M<1e-8?1:M}return this.$outputRead+=D,this.$outputRead%=this.fftBufferSize,this.fPlotHandler&&(this.port.postMessage({type:"plot",value:p,index:this.fBufferNum++,events:this.fCachedEvents}),this.fCachedEvents=[]),!0}messageFrame(h){let f=Number.isFinite(h.frame)?h.frame:Number.isFinite(h.time)?h.time*r:null;return f===null?null:Math.round(f)}atTime(h,f){let u=this.messageFrame(h);if(u===null){f();return}let o=b(()=>{try{f()}catch(m){console.error(`Faust: a message timed for frame ${u} threw and was dropped`,m)}},"guarded"),p=this.fEventQueue.length;for(;p>0&&this.fEventQueue[p-1].frame>u;)p--;this.fEventQueue.splice(p,0,{frame:u,apply:o})}applyDueEvents(h){let f=h+a;for(;this.fEventQueue.length&&this.fEventQueue[0].frame<f;)this.fEventQueue.shift().apply()}setParamValue(h,f){var u;(u=this.fDSPCode)==null||u.setParamValue(h,f),this.paramValuesCache[h]=f}midiMessage(h){var f;(f=this.fDSPCode)==null||f.midiMessage(h)}ctrlChange(h,f,u){var o;(o=this.fDSPCode)==null||o.ctrlChange(h,f,u)}pitchWheel(h,f){var u;(u=this.fDSPCode)==null||u.pitchWheel(h,f)}propagateAcc(h,f=!1){this.fDSPCode.propagateAcc(h,f)}propagateGyr(h){this.fDSPCode.propagateGyr(h)}resetFFT(h,f,u,o,p,m){var oe,ue;let A=~~ce(Math.max(2,h||1024),2),D=~~Math.min(A,Math.max(1,f)),I=~~Math.max(1,A/D),M=A-Math.min(I,m),E=null;u!==0&&(E=typeof x=="object"&&x[~~u-1]||null);let U=A!==this.fftSize,Z=D!==this.fftOverlap;if((U||Z)&&(this.fftSize=A,this.fftOverlap=D,this.fftHopSize=I,this.$inputWrite=0,this.$inputRead=0,this.$outputWrite=0,this.$outputRead=-M,this.fftBufferSize=Math.max(A*2-this.fftHopSize,m*2),!U&&this.fftHopSizeParam&&((oe=this.fDSPCode)==null||oe.setParamValue(this.fftHopSizeParam,this.fftHopSize))),U&&((ue=this.rfft)==null||ue.dispose(),this.rfft=new this.FFT(A),this.noIFFTBuffer=new Float32Array(this.fftSize),this.createFFTProcessor()),(U||Z||E!==this.windowFunction)&&(this.windowFunction=E,this.window=new Float32Array(A),this.window.fill(1),E&&pe(this.window,E),this.windowSumSquare=new Float32Array(this.fftBufferSize)),this.fftInput.length>o&&this.fftInput.splice(o),this.fftOutput.length>p&&this.fftOutput.splice(p),U||Z){for(let N=0;N<o;N++)this.fftInput[N]=new Float32Array(this.fftBufferSize);for(let N=0;N<p;N++)this.fftOutput[N]=new Float32Array(this.fftBufferSize)}else{if(this.fftInput.length<o)for(let N=this.fftInput.length;N<o;N++)this.fftInput[N]=new Float32Array(this.fftBufferSize);if(this.fftOutput.length<p)for(let N=this.fftOutput.length;N<p;N++)this.fftOutput[N]=new Float32Array(this.fftBufferSize)}}async createFFTProcessor(){var u,o;(u=this.fDSPCode)==null||u.stop(),(o=this.fDSPCode)==null||o.destroy(),this.fDSPCode=new l(this.dspInstance,r,this.sampleSize,this.fftProcessorBufferSize,this.soundfiles),this.fDSPCode.setOutputParamHandler((p,m)=>this.port.postMessage({path:p,value:m,type:"out-param"})),this.fDSPCode.setInputParamHandler((p,m)=>this.port.postMessage({path:p,value:m,type:"in-param"})),this.fDSPCode.setNonFiniteHandler(this.fNonFiniteHandler),this.fDSPCode.setPlotHandler(this.fPlotHandler);let h=this.fDSPCode.getParams();this.fDSPCode.start();for(let p in this.paramValuesCache)K.find(m=>`/${p}`.endsWith(m))||this.fDSPCode.setParamValue(p,this.paramValuesCache[p]);let f=h.find(p=>p.endsWith("/fftSize"));f&&this.fDSPCode.setParamValue(f,this.fftSize),this.fftHopSizeParam=h.find(p=>p.endsWith("/fftHopSize")),this.fftHopSizeParam&&this.fDSPCode.setParamValue(this.fftHopSizeParam,this.fftHopSize),this.fftProcessorZeros=new Float32Array(this.fftProcessorBufferSize)}destroy(){var h,f,u;(h=this.fDSPCode)==null||h.stop(),(f=this.fDSPCode)==null||f.destroy(),(u=this.rfft)==null||u.dispose(),this.destroyed=!0}};b(X,"FaustFFTAudioWorkletProcessor");let _=X,de=_;if(t){let y=v||H||"myfftdsp",F=globalThis;F.__faustRegisteredProcessors||(F.__faustRegisteredProcessors=new Set),F.__faustRegisteredProcessors.has(y)||(s(y,de),F.__faustRegisteredProcessors.add(y))}return _},"getFaustFFTAudioWorkletProcessor"),fe=ge;var Y=class Y{constructor(e){this.port=e,this.supportSharedArrayBuffer=!!globalThis.SharedArrayBuffer,this.byteLength=4*Uint8Array.BYTES_PER_ELEMENT+3*Float32Array.BYTES_PER_ELEMENT+3*Float32Array.BYTES_PER_ELEMENT}initializeBuffer(e){let t=0;this.uin8Invert=new Uint8ClampedArray(e,t,1),t+=Uint8ClampedArray.BYTES_PER_ELEMENT,this.uin8NewAccData=new Uint8ClampedArray(e,t,1),t+=Uint8ClampedArray.BYTES_PER_ELEMENT,this.uin8NewGyrData=new Uint8ClampedArray(e,t,1),t+=Uint8ClampedArray.BYTES_PER_ELEMENT,t+=Uint8ClampedArray.BYTES_PER_ELEMENT,this.f32Acc=new Float32Array(e,t,3),t+=3*Float32Array.BYTES_PER_ELEMENT,this.f32Gyr=new Float32Array(e,t,3),t+=3*Float32Array.BYTES_PER_ELEMENT}setNewAccDataAvailable(e){this.uin8NewAccData&&(this.uin8NewAccData[0]=+e)}getNewAccDataAvailable(){var e;return!!((e=this.uin8NewAccData)!=null&&e[0])}setNewGyrDataAvailable(e){this.uin8NewGyrData&&(this.uin8NewGyrData[0]=+e)}getNewGyrDataAvailable(){var e;return!!((e=this.uin8NewGyrData)!=null&&e[0])}setAcc({x:e,y:t,z:s},n=!1){if(!this.supportSharedArrayBuffer){let r={type:"acc",data:{x:e,y:t,z:s},invert:n};this.port.postMessage(r)}this.uin8NewAccData&&(this.uin8Invert[0]=+n,this.f32Acc[0]=e,this.f32Acc[1]=t,this.f32Acc[2]=s,this.uin8NewAccData[0]=1)}getAcc(){if(!this.uin8NewAccData)return;let e=!!this.uin8Invert[0],[t,s,n]=this.f32Acc;return{x:t,y:s,z:n,invert:e}}setGyr({alpha:e,beta:t,gamma:s}){if(!this.supportSharedArrayBuffer){let n={type:"gyr",data:{alpha:e,beta:t,gamma:s}};this.port.postMessage(n)}this.uin8NewGyrData&&(this.f32Gyr[0]=e,this.f32Gyr[1]=t,this.f32Gyr[2]=s,this.uin8NewGyrData[0]=1)}getGyr(){if(!this.uin8NewGyrData)return;let[e,t,s]=this.f32Gyr;return{alpha:e,beta:t,gamma:s}}};b(Y,"FaustAudioWorkletCommunicator");var Q=Y;var ee=class ee extends Q{constructor(e){if(super(e),this.supportSharedArrayBuffer)this.port.addEventListener("message",t=>{let{data:s}=t;s.type==="initSab"&&this.initializeBuffer(s.sab)});else{let t=new ArrayBuffer(this.byteLength);this.initializeBuffer(t),this.port.addEventListener("message",s=>{let n=s.data;switch(n.type){case"acc":{this.setAcc(n.data,n.invert);break}case"gyr":{this.setGyr(n.data);break}default:break}})}}};b(ee,"FaustAudioWorkletProcessorCommunicator");var G=ee;var te=class te{constructor(e){this.fExports=e}compute(e,t,s,n){this.fExports.compute(e,t,s,n)}getNumInputs(e){return this.fExports.getNumInputs(e)}getNumOutputs(e){return this.fExports.getNumOutputs(e)}getParamValue(e,t){return this.fExports.getParamValue(e,t)}getSampleRate(e){return this.fExports.getSampleRate(e)}init(e,t){this.fExports.init(e,t)}instanceClear(e){this.fExports.instanceClear(e)}instanceConstants(e,t){this.fExports.instanceConstants(e,t)}instanceInit(e,t){this.fExports.instanceInit(e,t)}instanceResetUserInterface(e){this.fExports.instanceResetUserInterface(e)}setParamValue(e,t,s){this.fExports.setParamValue(e,t,s)}};b(te,"FaustDspInstance");var z=te;var ne=class ne{static createWasmImport(e){return{env:{memory:e||new WebAssembly.Memory({initial:100}),memoryBase:0,tableBase:0,_abs:Math.abs,_acosf:Math.acos,_asinf:Math.asin,_atanf:Math.atan,_atan2f:Math.atan2,_ceilf:Math.ceil,_cosf:Math.cos,_expf:Math.exp,_floorf:Math.floor,_fmodf:b((t,s)=>t%s,"_fmodf"),_logf:Math.log,_log10f:Math.log10,_max_f:Math.max,_min_f:Math.min,_remainderf:b((t,s)=>t-Math.round(t/s)*s,"_remainderf"),_powf:Math.pow,_roundf:Math.round,_sinf:Math.sin,_sqrtf:Math.sqrt,_tanf:Math.tan,_acoshf:Math.acosh,_asinhf:Math.asinh,_atanhf:Math.atanh,_coshf:Math.cosh,_sinhf:Math.sinh,_tanhf:Math.tanh,_isnanf:Number.isNaN,_isinff:b(t=>!isFinite(t),"_isinff"),_copysignf:b((t,s)=>Math.sign(t)===Math.sign(s)?t:-t,"_copysignf"),_acos:Math.acos,_asin:Math.asin,_atan:Math.atan,_atan2:Math.atan2,_ceil:Math.ceil,_cos:Math.cos,_exp:Math.exp,_floor:Math.floor,_fmod:b((t,s)=>t%s,"_fmod"),_log:Math.log,_log10:Math.log10,_max_:Math.max,_min_:Math.min,_remainder:b((t,s)=>t-Math.round(t/s)*s,"_remainder"),_pow:Math.pow,_round:Math.round,_sin:Math.sin,_sqrt:Math.sqrt,_tan:Math.tan,_acosh:Math.acosh,_asinh:Math.asinh,_atanh:Math.atanh,_cosh:Math.cosh,_sinh:Math.sinh,_tanh:Math.tanh,_isnan:Number.isNaN,_isinf:b(t=>!isFinite(t),"_isinf"),_copysign:b((t,s)=>Math.sign(t)===Math.sign(s)?t:-t,"_copysign"),table:new WebAssembly.Table({initial:0,element:"anyfunc"})}}}static createWasmMemoryPoly(e,t,s,n,r){let i=Math.max(4,e),a=t,d=b(g=>{let P=65536;for(;P<g;)P*=2;return P},"pow2limit"),c=n?n.size:0,l=d(c+s.size*i+(s.inputs+s.outputs*2)*(a+r*t))/65536;return l=Math.max(2,l),new WebAssembly.Memory({initial:l})}static createWasmMemoryMono(e,t,s){let n=e,r=(t.size+(t.inputs+t.outputs)*(n+s*e))/65536;return new WebAssembly.Memory({initial:r*2})}static createMonoDSPInstanceAux(e,t,s=null){let n=e.exports,r=new z(n);return{memory:s||e.exports.memory,api:r,json:t}}static createMemoryMono(e){let t=JSON.parse(e.json),s=t.compile_options.match("-double")?8:4;return this.createWasmMemoryMono(s,t,8192)}static createMemoryPoly(e,t,s){let n=JSON.parse(t.json),r=s&&s.json?JSON.parse(s.json):null,i=n.compile_options.match("-double")?8:4;return this.createWasmMemoryPoly(e,i,n,r,8192)}static createMixerAux(e,t){let s={imports:{print:console.log},memory:{memory:t}};return new WebAssembly.Instance(e,s).exports}static async loadDSPFactory(e,t){let s=await fetch(e);if(!s.ok)throw new Error(`=> exception raised while running loadDSPFactory, file not found: ${e}`);let n=await s.arrayBuffer(),r=await WebAssembly.compile(n),a=await(await fetch(t)).text(),l=JSON.parse(a).compile_options.indexOf("wasm-e")!==-1;return{cfactory:0,code:new Uint8Array(n),module:r,json:a,poly:l}}static async loadDSPMixer(e,t){let s=null;return t?s=new Uint8Array(t.readFile(e,{encoding:"binary"})):s=await(await fetch(e)).arrayBuffer(),WebAssembly.compile(s)}static async createAsyncMonoDSPInstance(e){if(/"type":\\s*"soundfile"/.test(e.json)){let n=this.createMemoryMono(e),r=await WebAssembly.instantiate(e.module,this.createWasmImport(n));return this.createMonoDSPInstanceAux(r,e.json,n)}else{let n=await WebAssembly.instantiate(e.module,this.createWasmImport());return this.createMonoDSPInstanceAux(n,e.json)}}static createSyncMonoDSPInstance(e){if(/"type":\\s*"soundfile"/.test(e.json)){let n=this.createMemoryMono(e),r=new WebAssembly.Instance(e.module,this.createWasmImport(n));return this.createMonoDSPInstanceAux(r,e.json,n)}else{let n=new WebAssembly.Instance(e.module,this.createWasmImport());return this.createMonoDSPInstanceAux(n,e.json)}}static async createAsyncPolyDSPInstance(e,t,s,n){let r=this.createMemoryPoly(s,e,n),a=(await WebAssembly.instantiate(e.module,this.createWasmImport(r))).exports,d=new z(a),c=this.createMixerAux(t,r);if(n){let g=(await WebAssembly.instantiate(n.module,this.createWasmImport(r))).exports,P=new z(g);return{memory:r,voices:s,voiceAPI:d,effectAPI:P,mixerAPI:c,voiceJSON:e.json,effectJSON:n.json}}else return{memory:r,voices:s,voiceAPI:d,mixerAPI:c,voiceJSON:e.json}}static createSyncPolyDSPInstance(e,t,s,n){let r=this.createMemoryPoly(s,e,n),a=new WebAssembly.Instance(e.module,this.createWasmImport(r)).exports,d=new z(a),c=this.createMixerAux(t,r);if(n){let g=new WebAssembly.Instance(n.module,this.createWasmImport(r)).exports,P=new z(g);return{memory:r,voices:s,voiceAPI:d,effectAPI:P,mixerAPI:c,voiceJSON:e.json,effectJSON:n.json}}else return{memory:r,voices:s,voiceAPI:d,mixerAPI:c,voiceJSON:e.json}}};b(ne,"FaustWasmInstantiator");var se=ne,le=se;var S=class S{static convertToAxis(e){switch(e){case 0:return 0;case 1:return 1;case 2:return 2;default:return console.error("Error: Axis not found value: "+e),0}}static convertToCurve(e){switch(e){case 0:return 0;case 1:return 1;case 2:return 2;case 3:return 3;default:return console.error("Error: Curve not found value: "+e),0}}static get Range(){return this._Range||(this._Range=class{constructor(e,t){this.fLo=Math.min(e,t),this.fHi=Math.max(e,t)}clip(e){return e<this.fLo?this.fLo:e>this.fHi?this.fHi:e}}),this._Range}static get Interpolator(){return this._Interpolator||(this._Interpolator=class{constructor(e,t,s,n){this.fRange=new S.Range(e,t),t!==e?(this.fCoef=(n-s)/(t-e),this.fOffset=s-e*this.fCoef):(this.fCoef=0,this.fOffset=(s+n)/2)}returnMappedValue(e){let t=this.fRange.clip(e);return this.fOffset+t*this.fCoef}getLowHigh(e,t){return{amin:this.fRange.fLo,amax:this.fRange.fHi}}}),this._Interpolator}static get Interpolator3pt(){return this._Interpolator3pt||(this._Interpolator3pt=class{constructor(e,t,s,n,r,i){this.fSegment1=new S.Interpolator(e,t,n,r),this.fSegment2=new S.Interpolator(t,s,r,i),this.fMid=t}returnMappedValue(e){return e<this.fMid?this.fSegment1.returnMappedValue(e):this.fSegment2.returnMappedValue(e)}getMappingValues(e,t,s){let n=this.fSegment1.getLowHigh(e,t),r=this.fSegment2.getLowHigh(t,s);return{amin:n.amin,amid:r.amin,amax:r.amax}}}),this._Interpolator3pt}static get UpConverter(){return this._UpConverter||(this._UpConverter=class{constructor(e,t,s,n,r,i){this.fActive=!0;this.fA2F=new S.Interpolator3pt(e,t,s,n,r,i),this.fF2A=new S.Interpolator3pt(n,r,i,e,t,s)}uiToFaust(e){return this.fA2F.returnMappedValue(e)}faustToUi(e){return this.fF2A.returnMappedValue(e)}setMappingValues(e,t,s,n,r,i){this.fA2F=new S.Interpolator3pt(e,t,s,n,r,i),this.fF2A=new S.Interpolator3pt(n,r,i,e,t,s)}getMappingValues(e,t,s){return this.fA2F.getMappingValues(e,t,s)}setActive(e){this.fActive=e}getActive(){return this.fActive}}),this._UpConverter}static get DownConverter(){return this._DownConverter||(this._DownConverter=class{constructor(e,t,s,n,r,i){this.fActive=!0;this.fA2F=new S.Interpolator3pt(e,t,s,i,r,n),this.fF2A=new S.Interpolator3pt(n,r,i,s,t,e)}uiToFaust(e){return this.fA2F.returnMappedValue(e)}faustToUi(e){return this.fF2A.returnMappedValue(e)}setMappingValues(e,t,s,n,r,i){this.fA2F=new S.Interpolator3pt(e,t,s,i,r,n),this.fF2A=new S.Interpolator3pt(n,r,i,s,t,e)}getMappingValues(e,t,s){return this.fA2F.getMappingValues(e,t,s)}setActive(e){this.fActive=e}getActive(){return this.fActive}}),this._DownConverter}static get UpDownConverter(){return this._UpDownConverter||(this._UpDownConverter=class{constructor(e,t,s,n,r,i){this.fActive=!0;this.fA2F=new S.Interpolator3pt(e,t,s,n,i,n),this.fF2A=new S.Interpolator(n,i,e,s)}uiToFaust(e){return this.fA2F.returnMappedValue(e)}faustToUi(e){return this.fF2A.returnMappedValue(e)}setMappingValues(e,t,s,n,r,i){this.fA2F=new S.Interpolator3pt(e,t,s,n,i,n),this.fF2A=new S.Interpolator(n,i,e,s)}getMappingValues(e,t,s){return this.fA2F.getMappingValues(e,t,s)}setActive(e){this.fActive=e}getActive(){return this.fActive}}),this._UpDownConverter}static get DownUpConverter(){return this._DownUpConverter||(this._DownUpConverter=class{constructor(e,t,s,n,r,i){this.fActive=!0;this.fA2F=new S.Interpolator3pt(e,t,s,i,n,i),this.fF2A=new S.Interpolator(n,i,e,s)}uiToFaust(e){return this.fA2F.returnMappedValue(e)}faustToUi(e){return this.fF2A.returnMappedValue(e)}setMappingValues(e,t,s,n,r,i){this.fA2F=new S.Interpolator3pt(e,t,s,i,n,i),this.fF2A=new S.Interpolator(n,i,e,s)}getMappingValues(e,t,s){return this.fA2F.getMappingValues(e,t,s)}setActive(e){this.fActive=e}getActive(){return this.fActive}}),this._DownUpConverter}static buildHandler(e,t,s,n,r,i,a){switch(e){case 0:return new S.UpConverter(t,s,n,r,i,a);case 1:return new S.DownConverter(t,s,n,r,i,a);case 2:return new S.UpDownConverter(t,s,n,r,i,a);case 3:return new S.DownUpConverter(t,s,n,r,i,a);default:return new S.UpConverter(t,s,n,r,i,a)}}};b(S,"FaustSensors");var C=S;var ie=class ie{constructor(e,t){this.memory=e,this.allocatedBytes=t}alloc(e){let t=this.allocatedBytes+7&-8,s=t+e,n=this.memory.buffer.byteLength;if(s>n){let r=Math.ceil((s-n)/65536);console.log(`GROW: ${r} pages`),this.memory.grow(r)}return this.allocatedBytes=s,t}getBuffer(){return this.memory.buffer}getInt32Array(){return new Int32Array(this.memory.buffer)}getInt64Array(){return new BigInt64Array(this.memory.buffer)}getFloat32Array(){return new Float32Array(this.memory.buffer)}getFloat64Array(){return new Float64Array(this.memory.buffer)}};b(ie,"WasmAllocator");var re=ie,w=class w{static get MAX_SOUNDFILE_PARTS(){return 256}static get MAX_CHAN(){return 64}static get BUFFER_SIZE(){return 1024}static get SAMPLE_RATE(){return 44100}constructor(e,t,s,n,r,i){this.fSampleSize=t,this.fIntSize=this.fSampleSize,this.fPtrSize=4,this.fAllocator=e,console.log(`Soundfile constructor: curChan: ${s}, length: ${n}, totalParts: ${i}`),this.fPtr=e.alloc(4*this.fPtrSize+12),this.fLength=e.alloc(w.MAX_SOUNDFILE_PARTS*this.fIntSize),this.fSR=e.alloc(w.MAX_SOUNDFILE_PARTS*this.fIntSize),this.fOffset=e.alloc(w.MAX_SOUNDFILE_PARTS*this.fIntSize),this.fBuffers=this.allocBuffers(s,n);let a=this.fAllocator.getInt32Array();a[this.fPtr>>2]=this.fBuffers,a[this.fPtr+this.fPtrSize>>2]=this.fLength,a[this.fPtr+2*this.fPtrSize>>2]=this.fSR,a[this.fPtr+3*this.fPtrSize>>2]=this.fOffset,a[this.fPtr+4*this.fPtrSize>>2]=s,a[this.fPtr+4*this.fPtrSize+4>>2]=i,a[this.fPtr+4*this.fPtrSize+8>>2]=this.fSampleSize===8?1:0;for(let d=0;d<s;d++){let c=a[(this.fBuffers>>2)+d];console.log(`allocBuffers AFTER: ${d} - ${c}`)}}allocBuffers(e,t){let s=this.fAllocator.alloc(e*this.fPtrSize);console.log(`allocBuffers buffers: ${s}`);for(let n=0;n<e;n++){let r=this.fAllocator.alloc(t*this.fSampleSize),i=this.fAllocator.getInt32Array();i[(s>>2)+n]=r}return s}copyToOut(e,t,s,n){if(this.fIntSize===4){let r=this.fAllocator.getInt32Array();r[(this.fLength>>Math.log2(this.fIntSize))+e]=n.audioBuffer[0].length,r[(this.fSR>>Math.log2(this.fIntSize))+e]=n.sampleRate,r[(this.fOffset>>Math.log2(this.fIntSize))+e]=s}else{let r=this.fAllocator.getInt64Array();r[(this.fLength>>Math.log2(this.fIntSize))+e]=BigInt(n.audioBuffer[0].length),r[(this.fSR>>Math.log2(this.fIntSize))+e]=BigInt(n.sampleRate),r[(this.fOffset>>Math.log2(this.fIntSize))+e]=BigInt(s)}console.log(`copyToOut: part: ${e}, maxChannels: ${t}, offset: ${s}, buffer: ${n}`),this.fSampleSize===8?this.copyToOutReal64(t,s,n):this.copyToOutReal32(t,s,n)}copyToOutReal32(e,t,s){let n=this.fAllocator.getInt32Array(),r=this.fAllocator.getFloat32Array();for(let i=0;i<s.audioBuffer.length;i++){let a=s.audioBuffer[i],d=n[(this.fBuffers>>2)+i],c=d+t*this.fSampleSize>>Math.log2(this.fSampleSize),l=d+(t+a.length)*this.fSampleSize>>Math.log2(this.fSampleSize);console.log(`copyToOutReal32 begin: ${c}, end: ${l}, delta: ${l-c}`);let g=r.subarray(d+t*this.fSampleSize>>Math.log2(this.fSampleSize),d+(t+a.length)*this.fSampleSize>>Math.log2(this.fSampleSize));for(let P=0;P<a.length;P++)g[P]=a[P]}}copyToOutReal64(e,t,s){let n=this.fAllocator.getInt32Array(),r=this.fAllocator.getFloat64Array();for(let i=0;i<s.audioBuffer.length;i++){let a=s.audioBuffer[i],d=n[(this.fBuffers>>2)+i],c=d+t*this.fSampleSize>>Math.log2(this.fSampleSize),l=d+(t+a.length)*this.fSampleSize>>Math.log2(this.fSampleSize);console.log(`copyToOutReal64 begin: ${c}, end: ${l}, delta: ${l-c}`);let g=r.subarray(d+t*this.fSampleSize>>Math.log2(this.fSampleSize),d+(t+a.length)*this.fSampleSize>>Math.log2(this.fSampleSize));for(let P=0;P<a.length;P++)g[P]=a[P]}}emptyFile(e,t){if(this.fIntSize===4){let s=this.fAllocator.getInt32Array();s[(this.fLength>>Math.log2(this.fIntSize))+e]=w.BUFFER_SIZE,s[(this.fSR>>Math.log2(this.fIntSize))+e]=w.SAMPLE_RATE,s[(this.fOffset>>Math.log2(this.fIntSize))+e]=t}else{let s=this.fAllocator.getInt64Array();s[(this.fLength>>Math.log2(this.fIntSize))+e]=BigInt(w.BUFFER_SIZE),s[(this.fSR>>Math.log2(this.fIntSize))+e]=BigInt(w.SAMPLE_RATE),s[(this.fOffset>>Math.log2(this.fIntSize))+e]=BigInt(t)}return t+w.BUFFER_SIZE}displayMemory(e="",t=!1){console.log("Soundfile memory: "+e),console.log(`fPtr: ${this.fPtr}`),console.log(`fBuffers: ${this.fBuffers}`),console.log(`fLength: ${this.fLength}`),console.log(`fSR: ${this.fSR}`),console.log(`fOffset: ${this.fOffset}`);let s=this.fAllocator.getInt32Array();t&&console.log(`HEAP32: ${s}`),console.log(`HEAP32[this.fPtr >> 2]: ${s[this.fPtr>>2]}`),console.log(`HEAP32[(this.fPtr + ptrSize) >> 2]: ${s[this.fPtr+this.fPtrSize>>2]}`),console.log(`HEAP32[(this.fPtr + 2 * ptrSize) >> 2]: ${s[this.fPtr+2*this.fPtrSize>>2]}`),console.log(`HEAP32[(this.fPtr + 3 * ptrSize) >> 2]: ${s[this.fPtr+3*this.fPtrSize>>2]}`)}getPtr(){return this.fPtr}getHEAP32(){return this.fAllocator.getInt32Array()}getHEAPFloat32(){return this.fAllocator.getFloat32Array()}getHEAPFloat64(){return this.fAllocator.getFloat64Array()}};b(w,"Soundfile");var W=w,V=class V{constructor(e,t,s){this.fOutputHandler=null;this.fInputHandler=null;this.fComputeHandler=null;this.fNonFiniteHandler=null;this.fNonFiniteReported=!1;this.fPlotHandler=null;this.fCachedEvents=[];this.fBufferNum=0;this.fInChannels=[];this.fOutChannels=[];this.fOutputsTimer=5;this.fInputsItems=[];this.fOutputsItems=[];this.fDescriptor=[];this.fSoundfiles=[];this.fSoundfileBuffers={};this.fInBase=[];this.fOutBase=[];this.fPitchwheelLabel=[];this.fCtrlLabel=new Array(128).fill(null).map(()=>[]);this.fMidiKeyLabel=new Array(128).fill(null).map(()=>[]);this.fMidiKeyOnLabel=new Array(128).fill(null).map(()=>[]);this.fMidiKeyOffLabel=new Array(128).fill(null).map(()=>[]);this.fMidiChannel=0;this.fPathTable={};this.fUnknownPaths=new Set;this.fUICallback=b(e=>{if(e.type==="hbargraph"||e.type==="vbargraph"){let t=b(s=>{this.fPathTable[s]===void 0&&(this.fPathTable[s]=e.index)},"registerPath");this.fOutputsItems.push(e.address),t(e.address),t(e.shortname),t(e.label)}else if(e.type==="vslider"||e.type==="hslider"||e.type==="button"||e.type==="checkbox"||e.type==="nentry"){let t=b(s=>{this.fPathTable[s]===void 0&&(this.fPathTable[s]=e.index)},"registerPath");if(this.fInputsItems.push(e.address),t(e.address),t(e.shortname),t(e.label),this.fDescriptor.push(e),!e.meta)return;e.meta.forEach(s=>{var a,d,c,l,g,P;let{midi:n,acc:r,gyr:i}=s;if(n){let v=n.trim();if(v==="pitchwheel"){let H=v.match(/^pitchwheel\\s(\\d+)/);H?this.fPitchwheelLabel.push({path:e.address,chan:parseInt(H[1]),min:e.min,max:e.max}):this.fPitchwheelLabel.push({path:e.address,chan:0,min:e.min,max:e.max})}else{let H=v.match(/^ctrl\\s(\\d+)\\s(\\d+)/),$=v.match(/^ctrl\\s(\\d+)/),O=v.match(/^key\\s+(\\d+)(?:\\s+(\\d+))?$/),x=v.match(/^keyon\\s+(\\d+)(?:\\s+(\\d+))?$/),L=v.match(/^keyoff\\s+(\\d+)(?:\\s+(\\d+))?$/);if(H)this.fCtrlLabel[parseInt(H[1])].push({path:e.address,chan:parseInt(H[2]),min:e.min,max:e.max});else if($)this.fCtrlLabel[parseInt($[1])].push({path:e.address,chan:0,min:e.min,max:e.max});else if(O){let T=parseInt(O[1]),B=O[2]?parseInt(O[2]):0;this.fMidiKeyLabel[T].push({path:e.address,chan:B,min:(a=e.min)!=null?a:0,max:(d=e.max)!=null?d:1})}else if(x){let T=parseInt(x[1]),B=x[2]?parseInt(x[2]):0;this.fMidiKeyOnLabel[T].push({path:e.address,chan:B,min:(c=e.min)!=null?c:0,max:(l=e.max)!=null?l:1})}else if(L){let T=parseInt(L[1]),B=L[2]?parseInt(L[2]):0;this.fMidiKeyOffLabel[T].push({path:e.address,chan:B,min:(g=e.min)!=null?g:0,max:(P=e.max)!=null?P:1})}}}if(r){let v=r.trim().split(" ").map(Number);this.setupAccHandler(e.address,C.convertToAxis(v[0]),C.convertToCurve(v[1]),v[2],v[3],v[4],e.min,e.init,e.max)}if(i){let v=i.trim().split(" ").map(Number);this.setupGyrHandler(e.address,C.convertToAxis(v[0]),C.convertToCurve(v[1]),v[2],v[3],v[4],e.min,e.init,e.max)}})}else e.type==="soundfile"&&this.fSoundfiles.push({name:e.label,url:e.url,index:e.index,basePtr:-1})},"fUICallback");this.fProcessing=!1;this.fDestroyed=!1;this.fFirstCall=!0;this.fBufferSize=t,this.fPtrSize=e,this.fSampleSize=e,this.fSoundfileBuffers=s,this.fAcc={x:[],y:[],z:[]},this.fGyr={x:[],y:[],z:[]}}warnUnknownPath(e,t){this.fUnknownPaths.has(e)||(this.fUnknownPaths.add(e),console.warn(`Faust: unknown parameter path "${e}", ${t}. Use getParams() for the list of valid paths.`))}renderBlock(e,t){if(!e||e.length===0){t(0,this.fBufferSize);return}let s=0;for(let n=0;n<e.length;n++){let r=e[n],i=Math.min(Math.max(r.frame,0),this.fBufferSize);i>s&&(t(s,i-s),s=i),r.apply()}s<this.fBufferSize&&t(s,this.fBufferSize-s)}applyEvents(e){if(e)for(let t=0;t<e.length;t++)e[t].apply()}setBufferOffset(e){let t=e*this.fSampleSize;for(let s=0;s<this.fInBase.length;s++)this.fHEAP32[(this.fAudioInputs>>2)+s]=this.fInBase[s]+t;for(let s=0;s<this.fOutBase.length;s++)this.fHEAP32[(this.fAudioOutputs>>2)+s]=this.fOutBase[s]+t}static remap(e,t,s,n,r){return(e-t)/(s-t)*(r-n)+n}static parseUI(e,t){e.forEach(s=>this.parseGroup(s,t))}static parseGroup(e,t){e.items&&this.parseItems(e.items,t)}static parseItems(e,t){e.forEach(s=>this.parseItem(s,t))}static parseItem(e,t){e.type==="vgroup"||e.type==="hgroup"||e.type==="tgroup"?this.parseItems(e.items,t):t(e)}static splitSoundfileNames(e){return e.replace(/^\\{|\\}$/g,"").split(";").map(s=>s.length<=2?"":s.substring(1,s.length-1)).map(s=>s.trim()).filter(s=>s.length>0)}get hasAccInput(){return this.fAcc.x.length+this.fAcc.y.length+this.fAcc.z.length>0}propagateAcc(e,t=!1){let{x:s,y:n,z:r}=e;t?(s!==null&&this.fAcc.x.forEach(i=>i(-s)),n!==null&&this.fAcc.y.forEach(i=>i(-n)),r!==null&&this.fAcc.z.forEach(i=>i(-r))):(s!==null&&this.fAcc.x.forEach(i=>i(s)),n!==null&&this.fAcc.y.forEach(i=>i(n)),r!==null&&this.fAcc.z.forEach(i=>i(r)))}get hasGyrInput(){return this.fGyr.x.length+this.fGyr.y.length+this.fGyr.z.length>0}propagateGyr(e){let{alpha:t,beta:s,gamma:n}=e;t!==null&&this.fGyr.x.forEach(r=>r(t)),s!==null&&this.fGyr.y.forEach(r=>r(s)),n!==null&&this.fGyr.z.forEach(r=>r(n))}setupAccHandler(e,t,s,n,r,i,a,d,c){let l=C.buildHandler(s,n,r,i,a,d,c);switch(t){case 0:this.fAcc.x.push(g=>this.setParamValue(e,l.uiToFaust(g)));break;case 1:this.fAcc.y.push(g=>this.setParamValue(e,l.uiToFaust(g)));break;case 2:this.fAcc.z.push(g=>this.setParamValue(e,l.uiToFaust(g)));break}}setupGyrHandler(e,t,s,n,r,i,a,d,c){let l=C.buildHandler(s,n,r,i,a,d,c);switch(t){case 0:this.fGyr.x.push(g=>this.setParamValue(e,l.uiToFaust(g)));break;case 1:this.fGyr.y.push(g=>this.setParamValue(e,l.uiToFaust(g)));break;case 2:this.fGyr.z.push(g=>this.setParamValue(e,l.uiToFaust(g)));break}}static extractUrlsFromMeta(e){let t=e.meta.find(s=>s.soundfiles!==void 0);return t?t.soundfiles.split(";").filter(s=>s!==""):[]}loadSoundfile(e,t,s,n){console.log(`Soundfile ${s} paths: ${n}`);let r=V.splitSoundfileNames(n),i=this.fSoundfiles.find(a=>a.url===n);if(!i)throw new Error(`Soundfile with ${n} cannot be found !}`);if(i.basePtr!==-1){let a=e.getInt32Array();console.log(`Soundfile CACHE ${n}} : ${s} loaded at ${i.basePtr} in wasm memory with index ${i.index}`),a[t+i.index>>2]=i.basePtr}else{let a=this.createSoundfile(e,r,this.fSoundfileBuffers);if(a){let d=a.getHEAP32();i.basePtr=a.getPtr(),console.log(`Soundfile ${s} loaded at ${i.basePtr} in wasm memory with index ${i.index}`),d[t+i.index>>2]=i.basePtr}else console.log(`Soundfile ${s} for ${n} cannot be created !}`)}}createSoundfile(e,t,s,n){let r=1,i=0;for(let c of t){let l=0,g=0,P=s==null?void 0:s[c];P?(l=P.audioBuffer.length,g=P.audioBuffer[0].length):(g=W.BUFFER_SIZE,l=1),r=Math.max(r,l),i+=g}i+=(W.MAX_SOUNDFILE_PARTS-t.length)*W.BUFFER_SIZE;let a=new W(e,this.fSampleSize,r,i,r,t.length),d=0;for(let c=0;c<t.length;c++){let l=t[c],g=s==null?void 0:s[l];g?(a.copyToOut(c,r,d,g),d+=g.audioBuffer[0].length):d=a.emptyFile(c,d)}for(let c=t.length;c<W.MAX_SOUNDFILE_PARTS;c++)d=a.emptyFile(c,d);return a}initSoundfileMemory(e,t){for(let{name:s,url:n}of this.fSoundfiles)this.loadSoundfile(e,t,s,n)}updateOutputs(){this.fOutputsItems.length>0&&this.fOutputHandler&&this.fOutputsTimer--===0&&(this.fOutputsTimer=5,this.fOutputsItems.forEach(e=>{var t;return(t=this.fOutputHandler)==null?void 0:t.call(this,e,this.getParamValue(e))}))}metadata(e){this.fJSONDsp.meta&&this.fJSONDsp.meta.forEach(t=>e(Object.keys(t)[0],t[Object.keys(t)[0]]))}compute(e,t){return!1}setOutputParamHandler(e){this.fOutputHandler=e}getOutputParamHandler(){return this.fOutputHandler}callOutputParamHandler(e,t){this.fOutputHandler&&this.fOutputHandler(e,t)}setInputParamHandler(e){this.fInputHandler=e}getInputParamHandler(){return this.fInputHandler}callInputParamHandler(e,t){this.fInputHandler&&this.fInputHandler(e,t)}setComputeHandler(e){this.fComputeHandler=e}getComputeHandler(){return this.fComputeHandler}setPlotHandler(e){this.fPlotHandler=e}getPlotHandler(){return this.fPlotHandler}setNonFiniteHandler(e){this.fNonFiniteHandler=e}getNonFiniteHandler(){return this.fNonFiniteHandler}clearNonFinite(){if(!this.fNonFiniteHandler)return;let e=!1,t=this.getNumOutputs();for(let s=0;s<t;s++){let n=this.fOutChannels[s],r=0;for(let i=0;i<n.length;i++)r+=n[i];if(r-r!==0)for(let i=0;i<n.length;i++){let a=n[i];a-a!==0&&(n[i]=0,e=!0)}}e&&!this.fNonFiniteReported&&(this.fNonFiniteReported=!0,this.fNonFiniteHandler())}getNumInputs(){return-1}getNumOutputs(){return-1}static parseMidiChannel(e){if(!e)return 0;let t,s="";for(let r of e)if(typeof r.options=="string"){let i=r.options.match(/\\[midichannel:([^\\]]*)\\]/);i&&(t=i[1],s="[midichannel] option")}if(t===void 0)for(let r of e)typeof r.midichannel=="string"&&(t=r.midichannel,s="midichannel metadata");if(t===void 0||t.trim()==="")return 0;let n=/^\\s*\\d+\\s*$/.test(t)?Number(t):NaN;return n>=0&&n<=16?n:(console.warn(`Faust: invalid MIDI channel \'${t}\' in ${s}: should be in 1..16, or 0 for all channels`),0)}setMidiChannel(e){this.fMidiChannel=Number.isInteger(e)&&e>=0&&e<=16?e:0}getMidiChannel(){return this.fMidiChannel}acceptMidiStatus(e){return this.fMidiChannel===0||e>=240||(e&15)===this.fMidiChannel-1}midiMessage(e){if(!this.acceptMidiStatus(e[0]))return;this.fPlotHandler&&this.fCachedEvents.push({data:e,type:"midi"});let t=e[0]>>4,s=e[0]&15,n=e[1],r=e[2];if(t===11)return this.ctrlChange(s,n,r);if(t===14)return this.pitchWheel(s,r*128+n);if(t===9)return r>0?this.keyOn(s,n,r):this.keyOff(s,n,r);if(t===8)return this.keyOff(s,n,r)}ctrlChange(e,t,s){this.fPlotHandler&&this.fCachedEvents.push({type:"ctrlChange",data:[e,t,s]}),this.fCtrlLabel[t].length&&this.fCtrlLabel[t].forEach(n=>{let{path:r,chan:i}=n;(i===0||e===i-1)&&(this.setParamValue(r,V.remap(s,0,127,n.min,n.max)),this.fOutputHandler&&this.fOutputHandler(r,this.getParamValue(r)))})}keyOn(e,t,s){this.fPlotHandler&&this.fCachedEvents.push({type:"keyOn",data:[e,t,s]}),this.fMidiKeyOnLabel[t].forEach(n=>{let{path:r,chan:i}=n;(i===0||e===i-1)&&(this.setParamValue(r,V.remap(s,0,127,n.min,n.max)),this.fOutputHandler&&this.fOutputHandler(r,this.getParamValue(r)))}),this.fMidiKeyLabel[t].forEach(n=>{let{path:r,chan:i}=n;(i===0||e===i-1)&&(this.setParamValue(r,V.remap(s,0,127,n.min,n.max)),this.fOutputHandler&&this.fOutputHandler(r,this.getParamValue(r)))})}keyOff(e,t,s){this.fPlotHandler&&this.fCachedEvents.push({type:"keyOff",data:[e,t,s]}),this.fMidiKeyOffLabel[t].forEach(n=>{let{path:r,chan:i}=n;(i===0||e===i-1)&&(this.setParamValue(r,V.remap(s,0,127,n.min,n.max)),this.fOutputHandler&&this.fOutputHandler(r,this.getParamValue(r)))}),this.fMidiKeyLabel[t].forEach(n=>{let{path:r,chan:i}=n;(i===0||e===i-1)&&(this.setParamValue(r,0),this.fOutputHandler&&this.fOutputHandler(r,this.getParamValue(r)))})}pitchWheel(e,t){this.fPlotHandler&&this.fCachedEvents.push({type:"pitchWheel",data:[e,t]}),this.fPitchwheelLabel.forEach(s=>{let{path:n,chan:r}=s;(r===0||e===r-1)&&(this.setParamValue(n,V.remap(t,0,16383,s.min,s.max)),this.fOutputHandler&&this.fOutputHandler(n,this.getParamValue(n)))})}setParamValue(e,t){}getParamValue(e){return 0}getParams(){return this.fInputsItems}getMeta(){return this.fJSONDsp}getJSON(){return JSON.stringify(this.getMeta())}getUI(){return this.fJSONDsp.ui}getDescriptors(){return this.fDescriptor}hasSoundfiles(){return this.fSoundfiles.length>0}startSensors(){this.startSensors()}stopSensors(){this.stopSensors()}init(){}instanceInit(){}instanceClear(){}instanceConstants(){}instanceResetUserInterface(){}start(){this.fProcessing=!0}stop(){this.fProcessing=!1}destroy(){this.fDestroyed=!0,this.fOutputHandler=null,this.fInputHandler=null,this.fComputeHandler=null,this.fPlotHandler=null}};b(V,"FaustBaseWebAudioDsp");var k=V,ae=class ae extends k{constructor(t,s,n,r,i){super(n,r,i);this.fRenderSlice=b((t,s)=>{this.setBufferOffset(t),this.fInstance.api.compute(this.fDSP,s,this.fAudioInputs,this.fAudioOutputs)},"fRenderSlice");if(this.fInstance=t,this.fSampleRate=s,this.fJSONDsp=JSON.parse(this.fInstance.json),this.fMidiChannel=k.parseMidiChannel(this.fJSONDsp.meta),k.parseUI(this.fJSONDsp.ui,this.fUICallback),this.fEndMemory=this.initMemory(),this.fInstance.api.init(this.fDSP,s),this.fSoundfiles.length>0){let a=new re(this.fInstance.memory,this.fEndMemory);this.initSoundfileMemory(a,this.fDSP)}}init(){this.fInstance.api.init(this.fDSP,this.fSampleRate)}instanceInit(){this.fInstance.api.instanceInit(this.fDSP,this.fSampleRate)}instanceClear(){this.fInstance.api.instanceClear(this.fDSP)}instanceConstants(){this.fInstance.api.instanceConstants(this.fDSP,this.fSampleRate)}instanceResetUserInterface(){this.fInstance.api.instanceResetUserInterface(this.fDSP)}initMemory(){this.fDSP=0;let t=this.fJSONDsp.size;this.fAudioInputs=t,this.fAudioOutputs=this.fAudioInputs+this.getNumInputs()*this.fPtrSize;let s=this.fAudioOutputs+this.getNumOutputs()*this.fPtrSize,n=s+this.getNumInputs()*this.fBufferSize*this.fSampleSize,r=n+this.getNumOutputs()*this.fBufferSize*this.fSampleSize,i=this.fInstance.memory.buffer,a=new Int32Array(i),d=this.fSampleSize===4?new Float32Array(i):new Float64Array(i);if(this.getNumInputs()>0){for(let l=0;l<this.getNumInputs();l++)a[(this.fAudioInputs>>2)+l]=s+this.fBufferSize*this.fSampleSize*l;let c=a.subarray(this.fAudioInputs>>2,this.fAudioInputs+this.getNumInputs()*this.fPtrSize>>2);for(let l=0;l<this.getNumInputs();l++)this.fInChannels[l]=d.subarray(c[l]>>Math.log2(this.fSampleSize),c[l]+this.fBufferSize*this.fSampleSize>>Math.log2(this.fSampleSize))}if(this.getNumOutputs()>0){for(let l=0;l<this.getNumOutputs();l++)a[(this.fAudioOutputs>>2)+l]=n+this.fBufferSize*this.fSampleSize*l;let c=a.subarray(this.fAudioOutputs>>2,this.fAudioOutputs+this.getNumOutputs()*this.fPtrSize>>2);for(let l=0;l<this.getNumOutputs();l++)this.fOutChannels[l]=d.subarray(c[l]>>Math.log2(this.fSampleSize),c[l]+this.fBufferSize*this.fSampleSize>>Math.log2(this.fSampleSize))}this.fHEAP32=a,this.fInBase=[];for(let c=0;c<this.getNumInputs();c++)this.fInBase[c]=a[(this.fAudioInputs>>2)+c];this.fOutBase=[];for(let c=0;c<this.getNumOutputs();c++)this.fOutBase[c]=a[(this.fAudioOutputs>>2)+c];return r}toString(){return`============== Mono Memory layout ==============\n        this.fBufferSize: ${this.fBufferSize}\n        this.fJSONDsp.size: ${this.fJSONDsp.size}\n        this.fAudioInputs: ${this.fAudioInputs}\n        this.fAudioOutputs: ${this.fAudioOutputs}\n        this.fDSP: ${this.fDSP}`}compute(t,s,n){if(this.fDestroyed)return!1;if(!this.fProcessing)return this.applyEvents(n),!0;if(this.fFirstCall&&(this.initMemory(),this.fFirstCall=!1),typeof t=="function")t(this.fInChannels);else{if(this.getNumInputs()>0&&(!t||!t[0]||t[0].length===0))return this.applyEvents(n),!0;if(this.getNumOutputs()>0&&typeof s!="function"&&(!s||!s[0]||s[0].length===0))return this.applyEvents(n),!0;if(t!==void 0)for(let i=0;i<Math.min(this.getNumInputs(),t.length);i++)this.fInChannels[i].set(t[i])}this.fComputeHandler&&this.fComputeHandler(this.fBufferSize),this.renderBlock(n,this.fRenderSlice),this.updateOutputs(),this.clearNonFinite();let r=this.fOutChannels;if(typeof s=="function")s(this.fOutChannels);else{for(let i=0;i<Math.min(this.getNumOutputs(),s.length);i++){let a=this.fOutChannels[i];s[i].set(a)}r=s}return this.fPlotHandler&&(this.fPlotHandler(r,this.fBufferNum++,this.fCachedEvents.length?this.fCachedEvents:void 0),this.fCachedEvents=[]),!0}metadata(t){super.metadata(t)}getNumInputs(){return this.fInstance.api.getNumInputs(this.fDSP)}getNumOutputs(){return this.fInstance.api.getNumOutputs(this.fDSP)}setParamValue(t,s){let n=this.fPathTable[t];if(n===void 0)return this.warnUnknownPath(t,"ignored");this.fPlotHandler&&this.fCachedEvents.push({type:"param",data:{path:t,value:s}}),this.fInstance.api.setParamValue(this.fDSP,n,s),this.callInputParamHandler(t,this.getParamValue(t))}getParamValue(t){let s=this.fPathTable[t];return s===void 0?(this.warnUnknownPath(t,"returning 0"),0):this.fInstance.api.getParamValue(this.fDSP,s)}getMeta(){return this.fJSONDsp}getJSON(){return this.fInstance.json}getDescriptors(){return this.fDescriptor}getUI(){return this.fJSONDsp.ui}};b(ae,"FaustMonoWebAudioDsp");var J=ae;fe({FaustBaseWebAudioDsp:k,FaustMonoWebAudioDsp:J,FaustWasmInstantiator:le,FaustAudioWorkletProcessorCommunicator:G,FFTUtils},faustData);})();\n';

// src/FaustDspGenerator.ts
var createWorkletNode = (processorName, create, usualCause = "") => {
  try {
    return create();
  } catch (error) {
    throw new Error(
      `Faust: the AudioWorkletProcessor "${processorName}" did not register. The module loaded, so the failure happened while it ran \u2014 its error is reported in the AudioWorklet scope and appears in the browser console above this one.${usualCause ? ` ${usualCause}` : ""} Original error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};
var _FaustMonoDspGenerator = class _FaustMonoDspGenerator {
  constructor() {
    this.factory = null;
  }
  async compile(compiler, name, code, args) {
    this.factory = await compiler.createMonoDSPFactory(name, code, args);
    if (this.factory) {
      this.name = name;
      return this;
    } else {
      return null;
    }
  }
  addSoundfiles(soundfileMap) {
    if (!this.factory)
      throw new Error(
        "Code is not compiled, please define the factory or call `await this.compile()` first."
      );
    for (const id in soundfileMap) {
      this.factory.soundfiles[id] = soundfileMap[id];
    }
  }
  getSoundfileList() {
    if (!this.factory)
      throw new Error(
        "Code is not compiled, please define the factory or call `await this.compile()` first."
      );
    const meta = JSON.parse(this.factory.json);
    const map = SoundfileReader_default.findSoundfilesFromMeta(meta);
    if (!map) return [];
    return Object.keys(map);
  }
  async createNode(context, name = this.name, factory = this.factory, sp = false, bufferSize = 1024, processorName = (factory == null ? void 0 : factory.shaKey) || name, processorOptions = {}) {
    var _a, _b;
    if (!factory)
      throw new Error(
        "Code is not compiled, please define the factory or call `await this.compile()` first."
      );
    const meta = JSON.parse(factory.json);
    const sampleSize = meta.compile_options.match("-double") ? 8 : 4;
    factory.soundfiles = await SoundfileReader_default.loadSoundfiles(
      meta,
      factory.soundfiles || {},
      context
    );
    if (sp) {
      const instance = await FaustWasmInstantiator_default.createAsyncMonoDSPInstance(factory);
      const monoDsp = new FaustMonoWebAudioDsp(
        instance,
        context.sampleRate,
        sampleSize,
        bufferSize,
        factory.soundfiles
      );
      const sp2 = context.createScriptProcessor(
        bufferSize,
        monoDsp.getNumInputs(),
        monoDsp.getNumOutputs()
      );
      Object.setPrototypeOf(sp2, FaustMonoScriptProcessorNode.prototype);
      sp2.setupNode(monoDsp);
      return sp2;
    } else {
      if (!_FaustMonoDspGenerator.gWorkletProcessors.has(context))
        _FaustMonoDspGenerator.gWorkletProcessors.set(
          context,
          /* @__PURE__ */ new Set()
        );
      if (!((_a = _FaustMonoDspGenerator.gWorkletProcessors.get(context)) == null ? void 0 : _a.has(processorName))) {
        const processorCode = `
// DSP name and JSON string for DSP are generated
const faustData = ${JSON.stringify({
          processorName,
          dspName: name,
          dspMeta: meta,
          poly: false
        })};
// The processor itself, bundled at this package's build time into one
// self-contained string (see build-worklets.js), so that no bundler minifying
// the application can break its internal references.
${monoProcessorSource}
`;
        const url = URL.createObjectURL(
          new Blob([processorCode], { type: "text/javascript" })
        );
        await context.audioWorklet.addModule(url);
        (_b = _FaustMonoDspGenerator.gWorkletProcessors.get(context)) == null ? void 0 : _b.add(processorName);
      }
      const node = createWorkletNode(
        processorName,
        () => new FaustMonoAudioWorkletNode(context, {
          processorOptions: {
            name: processorName,
            factory,
            sampleSize,
            ...processorOptions
          }
        })
      );
      return node;
    }
  }
  async createFFTNode(context, fftUtils, name = this.name, factory = this.factory, fftOptions = {}, processorName = (factory == null ? void 0 : factory.shaKey) ? `${factory.shaKey}_fft` : name, processorOptions = {}) {
    var _a, _b;
    if (!factory)
      throw new Error(
        "Code is not compiled, please define the factory or call `await this.compile()` first."
      );
    const meta = JSON.parse(factory.json);
    const sampleSize = meta.compile_options.match("-double") ? 8 : 4;
    factory.soundfiles = await SoundfileReader_default.loadSoundfiles(
      meta,
      factory.soundfiles || {},
      context
    );
    if (!_FaustMonoDspGenerator.gWorkletProcessors.has(context))
      _FaustMonoDspGenerator.gWorkletProcessors.set(context, /* @__PURE__ */ new Set());
    if (!((_a = _FaustMonoDspGenerator.gWorkletProcessors.get(context)) == null ? void 0 : _a.has(processorName))) {
      const processorCode = `
// DSP name and JSON string for DSP are generated
const faustData = ${JSON.stringify({
        processorName,
        dspName: name,
        dspMeta: meta,
        fftOptions
      })};
// The caller's FFT implementation
var FFTUtils = ${fftUtils.toString()};
// The processor itself, bundled at this package's build time into one
// self-contained string (see build-worklets.js), so that no bundler minifying
// the application can break its internal references.
${fftProcessorSource}
`;
      const url = URL.createObjectURL(
        new Blob([processorCode], { type: "text/javascript" })
      );
      await context.audioWorklet.addModule(url);
      (_b = _FaustMonoDspGenerator.gWorkletProcessors.get(context)) == null ? void 0 : _b.add(processorName);
    }
    const node = createWorkletNode(
      processorName,
      () => new FaustMonoAudioWorkletNode(context, {
        channelCount: Math.max(1, Math.ceil(meta.inputs / 3)),
        outputChannelCount: [Math.ceil(meta.outputs / 2)],
        processorOptions: {
          name: processorName,
          factory,
          sampleSize,
          ...processorOptions
        }
      }),
      "The `FFTUtils` class passed to `createFFTNode` runs there too, from its source text alone: it may not refer to anything outside its own body."
    );
    if (fftOptions.fftSize) {
      const param = node.parameters.get("fftSize");
      if (param) param.value = fftOptions.fftSize;
    }
    if (fftOptions.fftOverlap) {
      const param = node.parameters.get("fftOverlap");
      if (param) param.value = fftOptions.fftOverlap;
    }
    if (typeof fftOptions.defaultWindowFunction === "number") {
      const param = node.parameters.get("windowFunction");
      if (param) param.value = fftOptions.defaultWindowFunction + 1;
    }
    if (typeof fftOptions.noIFFT === "boolean") {
      const param = node.parameters.get("noIFFT");
      if (param) param.value = +fftOptions.noIFFT;
    }
    return node;
  }
  async createAudioWorkletProcessor(name = this.name, factory = this.factory, processorName = (factory == null ? void 0 : factory.shaKey) || name) {
    if (!factory)
      throw new Error(
        "Code is not compiled, please define the factory or call `await this.compile()` first."
      );
    const meta = JSON.parse(factory.json);
    const dependencies = {
      FaustBaseWebAudioDsp,
      FaustMonoWebAudioDsp,
      FaustWasmInstantiator: FaustWasmInstantiator_default,
      FaustAudioWorkletProcessorCommunicator,
      FaustPolyWebAudioDsp: void 0,
      FaustWebAudioDspVoice: void 0
    };
    const faustData = {
      processorName,
      dspName: name,
      dspMeta: meta,
      poly: false
    };
    const Processor = FaustAudioWorkletProcessor_default(
      dependencies,
      faustData
    );
    return Processor;
  }
  async createOfflineProcessor(sampleRate, bufferSize, factory = this.factory, context) {
    if (!factory)
      throw new Error(
        "Code is not compiled, please define the factory or call `await this.compile()` first."
      );
    const meta = JSON.parse(factory.json);
    const instance = await FaustWasmInstantiator_default.createAsyncMonoDSPInstance(factory);
    const sampleSize = meta.compile_options.match("-double") ? 8 : 4;
    if (context)
      factory.soundfiles = await SoundfileReader_default.loadSoundfiles(
        meta,
        factory.soundfiles || {},
        context
      );
    const monoDsp = new FaustMonoWebAudioDsp(
      instance,
      sampleRate,
      sampleSize,
      bufferSize,
      factory.soundfiles
    );
    return new FaustMonoOfflineProcessor(monoDsp, bufferSize);
  }
  getMeta() {
    return JSON.parse(this.factory.json);
  }
  getJSON() {
    return JSON.stringify(this.getMeta());
  }
  getUI() {
    return this.getMeta().ui;
  }
};
// Set of all created WorkletProcessors, each of them has to be unique
_FaustMonoDspGenerator.gWorkletProcessors = /* @__PURE__ */ new Map();
var FaustMonoDspGenerator = _FaustMonoDspGenerator;
var _FaustPolyDspGenerator = class _FaustPolyDspGenerator {
  constructor() {
    this.voiceFactory = null;
    this.effectFactory = null;
  }
  async compile(compiler, name, dspCodeAux, args, effectCodeAux = `dsp_code = environment{
                ${dspCodeAux}
            };
            process = dsp_code.effect;`) {
    try {
      this.effectFactory = await compiler.createPolyDSPFactory(
        name,
        effectCodeAux,
        args
      );
      if (this.effectFactory) {
        const effectJSON = JSON.parse(this.effectFactory.json);
        const ins = effectJSON.inputs;
        const outs = effectJSON.outputs;
        const adaptors = `bus(n) = par(i,n,_);
pad(n,w) = bus(n), par(i,w-n,0);
width(F) = max(outputs(F), max(${ins},${outs}));
adapt(1,n,m) = bus(n) <: bus(m);
adapt(0,n,m) = bus(n) :> bus(m);
// n channels to w: split when the effect takes w inputs, padded with silent channels otherwise
widen(1,d,n,w) = bus(n);
widen(0,1,n,w) = adapt(1,n,w);
widen(0,0,n,w) = pad(n,w);
// the voice's n channels out of the w of the buffers, the silent ones dropped
real(1,n,w) = bus(n);
real(0,n,w) = bus(n), par(i,w-n,!);
// the w channels to the effect's e inputs: the voice's own channels adapted to them
narrow(1,n,w,e) = bus(w);
narrow(0,n,w,e) = real(n == w, n, w) : adapt(n <= e, n, e);
`;
        const dspCode = `${adaptors}
adaptor(F) = widen(outputs(F) == width(F), ${ins} == width(F), outputs(F), width(F));
dsp_code = environment{
    ${dspCodeAux}
};
process = dsp_code.process : adaptor(dsp_code.process);
`;
        const effectCode = `${adaptors}
adaptorIns(F) = narrow(width(F) == ${ins}, outputs(F), width(F), ${ins});
adaptorOuts(F) = widen(${outs} == width(F), 0, ${outs}, width(F));
dsp_code = environment{
    ${dspCodeAux}
};
process = adaptorIns(dsp_code.process) : dsp_code.effect : adaptorOuts(dsp_code.process);
`;
        this.voiceFactory = await compiler.createPolyDSPFactory(
          name,
          dspCode,
          args
        );
        try {
          this.effectFactory = await compiler.createPolyDSPFactory(
            name,
            effectCode,
            args + " -inpl"
          );
        } catch (e) {
          console.warn(e);
          this.effectFactory = null;
          this.voiceFactory = await compiler.createPolyDSPFactory(
            name,
            dspCodeAux,
            args
          );
        }
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e != null ? e : "unknown error");
      if (!errorMessage.includes("undefined symbol : effect")) {
        console.warn(e);
      }
      this.effectFactory = null;
      this.voiceFactory = await compiler.createPolyDSPFactory(
        name,
        dspCodeAux,
        args
      );
    }
    if (this.voiceFactory) {
      this.name = name;
      const voiceMeta = JSON.parse(this.voiceFactory.json);
      const isDouble = voiceMeta.compile_options.match("-double");
      const { mixerBuffer, mixerModule } = await compiler.getAsyncInternalMixerModule(!!isDouble);
      this.mixerBuffer = mixerBuffer;
      this.mixerModule = mixerModule;
      return this;
    } else {
      return null;
    }
  }
  addSoundfiles(soundfileMap) {
    if (!this.voiceFactory)
      throw new Error(
        "Code is not compiled, please define the factory or call `await this.compile()` first."
      );
    for (const id in soundfileMap) {
      this.voiceFactory.soundfiles[id] = soundfileMap[id];
    }
  }
  getSoundfileList() {
    if (!this.voiceFactory)
      throw new Error(
        "Code is not compiled, please define the factory or call `await this.compile()` first."
      );
    const meta = JSON.parse(this.voiceFactory.json);
    const map = SoundfileReader_default.findSoundfilesFromMeta(meta);
    if (!map) return [];
    if (!this.effectFactory) return Object.keys(map);
    const effectMeta = JSON.parse(this.effectFactory.json);
    const effectMap = SoundfileReader_default.findSoundfilesFromMeta(effectMeta);
    return Object.keys({ ...effectMap, ...map });
  }
  async createNode(context, voices, name = this.name, voiceFactory = this.voiceFactory, mixerModule = this.mixerModule, effectFactory = this.effectFactory, sp = false, bufferSize = 1024, processorName = ((voiceFactory == null ? void 0 : voiceFactory.shaKey) || "") + ((effectFactory == null ? void 0 : effectFactory.shaKey) || "") || `${name}_poly`, processorOptions = {}) {
    var _a, _b;
    if (!voiceFactory)
      throw new Error(
        "Code is not compiled, please define the factory or call `await this.compile()` first."
      );
    const voiceMeta = JSON.parse(voiceFactory.json);
    const effectMeta = effectFactory ? JSON.parse(effectFactory.json) : void 0;
    const sampleSize = voiceMeta.compile_options.match("-double") ? 8 : 4;
    voiceFactory.soundfiles = await SoundfileReader_default.loadSoundfiles(
      voiceMeta,
      voiceFactory.soundfiles || {},
      context
    );
    if (effectFactory)
      effectFactory.soundfiles = await SoundfileReader_default.loadSoundfiles(
        effectMeta,
        effectFactory.soundfiles || {},
        context
      );
    if (sp) {
      const instance = await FaustWasmInstantiator_default.createAsyncPolyDSPInstance(
        voiceFactory,
        mixerModule,
        voices,
        effectFactory || void 0
      );
      const soundfiles = {
        ...effectFactory == null ? void 0 : effectFactory.soundfiles,
        ...voiceFactory.soundfiles
      };
      const polyDsp = new FaustPolyWebAudioDsp(
        instance,
        context.sampleRate,
        sampleSize,
        bufferSize,
        soundfiles,
        processorOptions.stopLevel
      );
      const sp2 = context.createScriptProcessor(
        bufferSize,
        polyDsp.getNumInputs(),
        polyDsp.getNumOutputs()
      );
      Object.setPrototypeOf(sp2, FaustPolyScriptProcessorNode.prototype);
      sp2.setupNode(polyDsp);
      return sp2;
    } else {
      if (!_FaustPolyDspGenerator.gWorkletProcessors.has(context))
        _FaustPolyDspGenerator.gWorkletProcessors.set(
          context,
          /* @__PURE__ */ new Set()
        );
      if (!((_a = _FaustPolyDspGenerator.gWorkletProcessors.get(context)) == null ? void 0 : _a.has(processorName))) {
        const processorCode = `
// DSP name and JSON string for DSP are generated
const faustData = ${JSON.stringify({
          processorName,
          dspName: name,
          dspMeta: voiceMeta,
          poly: true,
          effectMeta
        })};
// The processor itself, bundled at this package's build time into one
// self-contained string (see build-worklets.js), so that no bundler minifying
// the application can break its internal references.
${polyProcessorSource}
`;
        const url = URL.createObjectURL(
          new Blob([processorCode], { type: "text/javascript" })
        );
        await context.audioWorklet.addModule(url);
        (_b = _FaustPolyDspGenerator.gWorkletProcessors.get(context)) == null ? void 0 : _b.add(processorName);
      }
      const node = createWorkletNode(
        processorName,
        () => new FaustPolyAudioWorkletNode(context, {
          processorOptions: {
            name: processorName,
            voiceFactory,
            mixerModule,
            voices,
            sampleSize,
            effectFactory: effectFactory || void 0,
            ...processorOptions
          }
        }),
        "A duplicate control path shared between `process` and `effect` is the usual cause."
      );
      return node;
    }
  }
  async createAudioWorkletProcessor(name = this.name, voiceFactory = this.voiceFactory, effectFactory = this.effectFactory, processorName = ((voiceFactory == null ? void 0 : voiceFactory.shaKey) || "") + ((effectFactory == null ? void 0 : effectFactory.shaKey) || "") || `${name}_poly`) {
    if (!voiceFactory)
      throw new Error(
        "Code is not compiled, please define the factory or call `await this.compile()` first."
      );
    const voiceMeta = JSON.parse(voiceFactory.json);
    const effectMeta = effectFactory ? JSON.parse(effectFactory.json) : void 0;
    const dependencies = {
      FaustBaseWebAudioDsp,
      FaustMonoWebAudioDsp: void 0,
      FaustWasmInstantiator: FaustWasmInstantiator_default,
      FaustPolyWebAudioDsp,
      FaustWebAudioDspVoice,
      FaustAudioWorkletProcessorCommunicator
    };
    const faustData = {
      processorName,
      dspName: name,
      dspMeta: voiceMeta,
      poly: true,
      effectMeta
    };
    const Processor = FaustAudioWorkletProcessor_default(
      dependencies,
      faustData
    );
    return Processor;
  }
  async createOfflineProcessor(sampleRate, bufferSize, voices, voiceFactory = this.voiceFactory, mixerModule = this.mixerModule, effectFactory = this.effectFactory, context, stopLevel) {
    if (!voiceFactory)
      throw new Error(
        "Code is not compiled, please define the factory or call `await this.compile()` first."
      );
    const voiceMeta = JSON.parse(voiceFactory.json);
    const effectMeta = effectFactory ? JSON.parse(effectFactory.json) : void 0;
    const instance = await FaustWasmInstantiator_default.createAsyncPolyDSPInstance(
      voiceFactory,
      mixerModule,
      voices,
      effectFactory || void 0
    );
    const sampleSize = voiceMeta.compile_options.match("-double") ? 8 : 4;
    if (context) {
      voiceFactory.soundfiles = await SoundfileReader_default.loadSoundfiles(
        voiceMeta,
        voiceFactory.soundfiles || {},
        context
      );
      if (effectFactory)
        effectFactory.soundfiles = await SoundfileReader_default.loadSoundfiles(
          effectMeta,
          effectFactory.soundfiles || {},
          context
        );
    }
    const soundfiles = {
      ...effectFactory == null ? void 0 : effectFactory.soundfiles,
      ...voiceFactory.soundfiles
    };
    const polyDsp = new FaustPolyWebAudioDsp(
      instance,
      sampleRate,
      sampleSize,
      bufferSize,
      soundfiles,
      stopLevel
    );
    return new FaustPolyOfflineProcessor(polyDsp, bufferSize);
  }
  getMeta() {
    const o = this.voiceFactory ? JSON.parse(this.voiceFactory.json) : null;
    const e = this.effectFactory ? JSON.parse(this.effectFactory.json) : null;
    const r = { ...o };
    if (e) {
      r.ui = [
        {
          type: "tgroup",
          label: "Sequencer",
          items: [
            { type: "vgroup", label: "Instrument", items: o.ui },
            { type: "vgroup", label: "Effect", items: e.ui }
          ]
        }
      ];
    } else {
      r.ui = [
        {
          type: "tgroup",
          label: "Polyphonic",
          items: [{ type: "vgroup", label: "Voices", items: o.ui }]
        }
      ];
    }
    return r;
  }
  getJSON() {
    return JSON.stringify(this.getMeta());
  }
  getUI() {
    return this.getMeta().ui;
  }
};
// Set of all created WorkletProcessors, each of them has to be unique
_FaustPolyDspGenerator.gWorkletProcessors = /* @__PURE__ */ new Map();
var FaustPolyDspGenerator = _FaustPolyDspGenerator;
var _FaustDspGenerator = class _FaustDspGenerator {
  // Analyze the metadata of a Faust JSON file and extract the [midi:on] and [nvoices:n] options
  extractMidiAndNvoices(jsonData) {
    const optionsMetadata = jsonData.meta.find((meta) => meta.options);
    if (optionsMetadata && optionsMetadata.options) {
      const options = optionsMetadata.options;
      const midiRegex = /\[midi:(on|off)\]/;
      const nvoicesRegex = /\[nvoices:(\d+)\]/;
      const midiMatch = options.match(midiRegex);
      const nvoicesMatch = options.match(nvoicesRegex);
      const midi = midiMatch ? midiMatch[1] === "on" : false;
      const nvoices = nvoicesMatch ? parseInt(nvoicesMatch[1], 10) : -1;
      return { midi, nvoices };
    } else {
      return { midi: false, nvoices: -1 };
    }
  }
  /**
   * Compile DSP code, inspect metadata for [nvoices:] (and optionally [midi:on]), and build either a mono
   * or poly WebAudio node (ScriptProcessor or AudioWorklet depending on `sp`). Compilation uses a shared,
   * lazily-created libfaust instance to avoid repeatedly instantiating the WASM compiler.
   */
  async createFaustNode(context, name, code, sp, bufferSize) {
    const getCompiler = async () => {
      if (!_FaustDspGenerator.compilerPromise) {
        const baseURL = (typeof document !== "undefined" ? "src" in (document.currentScript || {}) ? document.currentScript.src : document.baseURI : void 0) || (typeof window !== "undefined" ? window.location.href : void 0);
        if (!baseURL)
          throw new Error("Cannot resolve libfaust-wasm location.");
        const jsURL = new URL(
          "../libfaust-wasm/libfaust-wasm.js",
          baseURL
        ).href;
        const dataURL = jsURL.replace(/c?js$/, "data");
        const wasmURL = jsURL.replace(/c?js$/, "wasm");
        _FaustDspGenerator.compilerPromise = instantiateFaustModuleFromFile_default(
          jsURL,
          dataURL,
          wasmURL
        ).then((module) => new FaustCompiler_default(new LibFaust_default(module)));
      }
      return _FaustDspGenerator.compilerPromise;
    };
    const args = "-ftz 2";
    try {
      const compiler = await getCompiler();
      const monoGenerator = new FaustMonoDspGenerator();
      const compiledMono = await monoGenerator.compile(
        compiler,
        name,
        code,
        args
      );
      if (!compiledMono) return null;
      const { nvoices } = this.extractMidiAndNvoices(
        monoGenerator.getMeta()
      );
      if (nvoices > 0) {
        const polyGenerator = new FaustPolyDspGenerator();
        const compiledPoly = await polyGenerator.compile(
          compiler,
          name,
          code,
          args
        );
        if (!compiledPoly) return null;
        return await polyGenerator.createNode(
          context,
          nvoices,
          name,
          void 0,
          void 0,
          void 0,
          sp,
          bufferSize
        );
      }
      return await monoGenerator.createNode(
        context,
        name,
        void 0,
        sp,
        bufferSize
      );
    } catch (e) {
      console.error(e);
      return null;
    }
  }
};
_FaustDspGenerator.compilerPromise = null;
var FaustDspGenerator = _FaustDspGenerator;
export {
  FaustAudioWorkletNode,
  FaustBaseWebAudioDsp,
  FaustCmajor_default as FaustCmajor,
  FaustCompiler_default as FaustCompiler,
  FaustDspGenerator,
  FaustDspInstance,
  FaustMonoAudioWorkletNode,
  FaustMonoDspGenerator,
  FaustMonoOfflineProcessor,
  FaustMonoScriptProcessorNode,
  FaustMonoWebAudioDsp,
  FaustOfflineProcessor_default as FaustOfflineProcessor,
  FaustPolyAudioWorkletNode,
  FaustPolyDspGenerator,
  FaustPolyOfflineProcessor,
  FaustPolyScriptProcessorNode,
  FaustPolyWebAudioDsp,
  FaustScriptProcessorNode,
  FaustSvgDiagrams_default as FaustSvgDiagrams,
  FaustWasmInstantiator_default as FaustWasmInstantiator,
  FaustWebAudioDspVoice,
  LibFaust_default as LibFaust,
  Soundfile,
  SoundfileReader_default as SoundfileReader,
  WasmAllocator,
  WavDecoder_default as WavDecoder,
  WavEncoder_default as WavEncoder,
  ab2str,
  FaustAudioWorkletProcessor_default as getFaustAudioWorkletProcessor,
  FaustFFTAudioWorkletProcessor_default as getFaustFFTAudioWorkletProcessor,
  instantiateFaustModuleFromFile_default as instantiateFaustModuleFromFile,
  str2ab
};
//# sourceMappingURL=index.js.map
