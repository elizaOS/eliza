/**
 * Implements browser speech recognition for the
 * Swabble Capacitor surface, with session-owned callback and resource cleanup.
 */
import { WebPlugin } from "@capacitor/core";
import type {
  SpeechRecognitionCtor,
  SpeechRecognitionInstance,
  SpeechRecognitionResultEvent,
  SpeechRecognitionWindow,
} from "@elizaos/native-plugin-shared-types";

import type {
  SwabbleConfig,
  SwabblePermissionStatus,
  SwabbleSpeechSegment,
  SwabbleStartOptions,
  SwabbleStartResult,
} from "./definitions";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Scripts that do not delimit words with whitespace. A word boundary is not
// textually observable inside them, so requiring a non-letter neighbor there
// would make the wake word unfireable (the command follows the trigger with no
// space). For these scripts the boundary is satisfied by an adjacent letter,
// which restores the substring behavior a continuous-script user depends on.
const CONTINUOUS_SCRIPTS =
  "\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Thai}\\p{sc=Lao}\\p{sc=Khmer}\\p{sc=Myanmar}";

/**
 * Case-fold a string with `toLowerCase()` while recording, for every code unit
 * of the folded result, the index in the original string it came from. The
 * returned `map` has one entry per folded code unit plus a trailing sentinel
 * (`map[folded.length] === value.length`), so a match offset measured in the
 * folded string can be translated back to a slice offset in the original
 * string even when folding changes length. This is what keeps the command
 * slice correct for an expanding case fold such as Turkish "\u0130" (U+0130),
 * whose lowercase form is the two code points "i" + U+0307.
 *
 * `toLowerCase()` folds each code point independently EXCEPT for Greek capital
 * sigma, whose whole-string lowercase is context-sensitive: word-final it is
 * "\u03c2" (U+03C2, final sigma) and medial it is "\u03c3" (U+03C3). A
 * per-code-point fold cannot observe word position and always yields "\u03c3",
 * so per-code-point and whole-string folds would disagree whenever a trigger
 * and transcript spell the same word in different case (e.g. "\u039f\u0394\u039f\u03a3"
 * vs "\u03bf\u03b4\u03bf\u03c2"), silently shutting the gate. To keep the two folds
 * equal on both sides, final sigma is canonicalized to "\u03c3"; that swap is
 * length-preserving (one code point for one), so the offset `map` stays exact.
 */
function foldForMatch(value: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let originalIndex = 0;
  for (const codePoint of value) {
    // Canonicalize Greek final sigma to medial sigma so this per-code-point
    // fold equals a whole-string toLowerCase() (length-preserving, so `map`
    // is unaffected).
    const lowered = codePoint.toLowerCase().replace(/\u03c2/g, "\u03c3");
    for (let i = 0; i < lowered.length; i++) {
      map.push(originalIndex);
    }
    folded += lowered;
    originalIndex += codePoint.length;
  }
  map.push(value.length);
  return { folded, map };
}

/**
 * Build a word-boundary matcher for the case-folded trigger, to run against a
 * case-folded transcript (see `foldForMatch`). Folding both sides with the same
 * `toLowerCase()` — rather than an `/i/` regex against an un-folded transcript —
 * is what makes an expanding case fold matchable no matter how the caller
 * spelled the trigger: the settings UI lowercases a manual entry before it
 * reaches this plugin, so Turkish "\u0130pek" arrives as "i" + U+0307 + "pek",
 * which `/iu/` does not equate back to the single-code-point "\u0130" in the
 * transcript. Folding the transcript the same way reduces both to "i" + U+0307,
 * so the gate opens regardless of whether the trigger kept its original
 * spelling.
 *
 * In space-delimited scripts the trigger must be a standalone token: a letter,
 * number, or combining mark on either side rejects the match, so "elizabeth"
 * does not fire "eliza", "they" does not fire "hey", and a decomposed accent
 * keeps the trigger inside its host word (trigger "e" does not match the NFD
 * "e\u0301clair"). Whitespace, punctuation, and string edges are boundaries, so
 * "eliza, open calendar" and "eliza open calendar" both fire.
 *
 * A neighbor in a continuous script (`CONTINUOUS_SCRIPTS`) also satisfies the
 * boundary, because such scripts write the command directly after the trigger
 * with no delimiter; without this relaxation the wake word could never fire in
 * Japanese, Chinese, Thai, and similar scripts. The residual cost is that a
 * trigger which is a prefix of a longer continuous-script word (e.g. "エリザ"
 * inside "エリザベス") still fires, matching the prior substring behavior; text
 * alone cannot segment those words, so this is not a regression.
 */
function buildTriggerMatcher(trigger: string): RegExp {
  const before = `(?:(?<![\\p{L}\\p{N}\\p{M}])|(?<=[${CONTINUOUS_SCRIPTS}]))`;
  const after = `(?:(?![\\p{L}\\p{N}\\p{M}])|(?=[${CONTINUOUS_SCRIPTS}]))`;
  const { folded } = foldForMatch(trigger);
  return new RegExp(`${before}${escapeRegExp(folded)}${after}`, "u");
}

const getSpeechRecognition = (): SpeechRecognitionCtor | null =>
  (window as SpeechRecognitionWindow).SpeechRecognition ||
  (window as SpeechRecognitionWindow).webkitSpeechRecognition ||
  null;

/**
 * Accept a positive finite minCommandLength (floored to an integer); anything
 * else is rejected as `undefined` so callers choose the fallback.
 */
function parseMinCommandLength(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

type NormalizedSwabbleConfig = SwabbleConfig & {
  minCommandLength: number;
  sampleRate: number;
};

function normalizeConfig(config: SwabbleConfig): NormalizedSwabbleConfig {
  if (!config || !Array.isArray(config.triggers)) {
    throw new Error("Swabble config requires a triggers array");
  }
  const triggers = config.triggers
    .filter((trigger): trigger is string => typeof trigger === "string")
    .map((trigger) => trigger.trim())
    .filter(Boolean);
  if (triggers.length === 0) {
    throw new Error("Swabble config requires at least one non-empty trigger");
  }
  const minCommandLength = parseMinCommandLength(config.minCommandLength) ?? 1;
  const sampleRate =
    typeof config.sampleRate === "number" &&
    Number.isFinite(config.sampleRate) &&
    config.sampleRate > 0
      ? Math.floor(config.sampleRate)
      : 16000;
  return {
    ...config,
    triggers,
    minCommandLength,
    sampleRate,
  };
}

/**
 * WakeWordGate detects trigger phrases in transcripts.
 *
 * In space-delimited scripts a trigger only fires as a standalone token,
 * delimited by Unicode word boundaries (whitespace, punctuation, or string
 * edges). A bare substring never fires: "elizabeth" does not trigger "eliza"
 * and "they" does not trigger "hey". Combining marks are treated as part of the
 * surrounding token, so a decomposed accent adjacent to the trigger (e.g.
 * "e\u0301clair") does not open the gate on the trigger "e". In continuous
 * scripts (Japanese, Chinese, Thai, and similar) the command follows the
 * trigger with no whitespace, so an adjacent letter also satisfies the
 * boundary; without this the wake word could never fire there. See
 * `buildTriggerMatcher` for the exact rule and its residual prefix-word cost.
 *
 * LIMITATION: Web Speech API does not provide word-level timing data.
 * Unlike native implementations, we cannot measure post-trigger gaps.
 * The `postGap` returned is always -1 (unavailable), and minPostTriggerGap is ignored.
 * Detection is purely text-based: trigger phrase + subsequent command text.
 */
class WakeWordGate {
  // Each matcher pairs a trigger label with its word-boundary regex so a
  // trigger only fires as a standalone token, never as a bare substring of a
  // larger word ("elizabeth" must not fire the trigger "eliza"). The regex is
  // built from the case-folded trigger and is matched against a case-folded
  // transcript (see `foldForMatch`), so a caller-lowercased or original-spelling
  // trigger both match, including an expanding case-fold like U+0130; `trigger`
  // is the lowercased label reported as the fired wake word.
  private matchers: Array<{ trigger: string; regex: RegExp }>;
  private minCommandLength: number;

  constructor(config: SwabbleConfig) {
    const normalized = normalizeConfig(config);
    this.matchers = normalized.triggers.map((t) => ({
      trigger: t.toLowerCase(),
      regex: buildTriggerMatcher(t),
    }));
    this.minCommandLength = normalized.minCommandLength;
    // Note: minPostTriggerGap cannot be enforced - Web Speech API lacks timing data
  }

  updateConfig(config: Partial<SwabbleConfig>): void {
    if (config.triggers) {
      this.matchers = normalizeConfig({
        triggers: config.triggers,
      }).triggers.map((t) => ({
        trigger: t.toLowerCase(),
        regex: buildTriggerMatcher(t),
      }));
    }
    const minCommandLength = parseMinCommandLength(config.minCommandLength);
    if (minCommandLength !== undefined) {
      this.minCommandLength = minCommandLength;
    }
  }

  /**
   * Report whether any configured trigger phrase is present in the transcript,
   * regardless of whether a long-enough command follows. Callers use this to
   * decide whether finalized text is worth retaining for a later dispatch
   * (a trigger awaiting its command) versus safe to discard.
   */
  hasTrigger(transcript: string): boolean {
    // Matchers are built from the case-folded trigger, so they run against the
    // case-folded transcript; presence detection needs no offset mapping.
    const { folded } = foldForMatch(transcript);
    return this.matchers.some(({ regex }) => regex.test(folded));
  }

  /**
   * Match wake word in transcript using text-only detection.
   * Returns postGap=-1 to indicate timing data is unavailable on web.
   */
  match(
    transcript: string,
  ): { wakeWord: string; command: string; postGap: number } | null {
    // Fold the transcript once and match against the folded form, then map the
    // folded match-end offset back into the original transcript so the command
    // is sliced from the untouched text (case folding may change length, e.g.
    // U+0130, so a folded offset must not index the original directly).
    const { folded, map } = foldForMatch(transcript);
    for (const { trigger, regex } of this.matchers) {
      const found = regex.exec(folded);
      if (!found) continue;

      // Extract command after the standalone trigger token. Using the
      // boundary-delimited match end (mapped back to the original transcript),
      // not a raw indexOf, keeps the boundary contract: only a boundary-
      // delimited trigger reaches this point, so "elizabeth" never yields a
      // command.
      const commandStart = map[found.index + found[0].length];
      const command = transcript.slice(commandStart).trim();

      if (command.length < this.minCommandLength) continue;

      // postGap=-1 indicates timing unavailable on web platform
      return { wakeWord: trigger, command, postGap: -1 };
    }
    return null;
  }
}

function stoppedBeforeStart(): SwabbleStartResult {
  return {
    started: false,
    error: "Speech recognition was stopped before it started",
  };
}

export class SwabbleWeb extends WebPlugin {
  private recognition: SpeechRecognitionInstance | null = null;
  private config: SwabbleConfig | null = null;
  private wakeGate: WakeWordGate | null = null;
  private isActive = false;
  private segments: SwabbleSpeechSegment[] = [];
  // Finalized transcript carried across onresult events so a trigger and its
  // command can arrive in separate final results (the user pauses after the
  // wake word). Bounded: a successful match consumes it, and finalized text
  // with no trigger is dropped since a command can only follow a trigger.
  private wakeBuffer = "";
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private mediaStream: MediaStream | null = null;
  private levelInterval: ReturnType<typeof setInterval> | null = null;

  async start(options: SwabbleStartOptions): Promise<SwabbleStartResult> {
    if (this.isActive) return { started: true };
    const config = normalizeConfig(options.config);
    const SpeechRecognitionAPI = getSpeechRecognition();
    if (!SpeechRecognitionAPI) {
      return {
        started: false,
        error: "Speech recognition not supported in this browser",
      };
    }

    this.config = config;
    this.wakeGate = new WakeWordGate(config);
    this.segments = [];
    this.wakeBuffer = "";

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = config.locale || "en-US";

    recognition.onstart = () => {
      if (this.recognition !== recognition) return;
      this.isActive = true;
      this.notifyListeners("stateChange", { state: "listening" });
    };

    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      if (this.isActive) {
        recognition.start();
      } else {
        // Terminal end (stop() or a fatal error already cleared isActive):
        // release the level-meter mic so no capture outlives the idle state.
        this.recognition = null;
        this.stopAudioLevelMonitoring();
        this.notifyListeners("stateChange", { state: "idle" });
      }
    };

    recognition.onerror = (event: { error: string }) => {
      // Browser callbacks can arrive after stop() and a subsequent start().
      // A retired recognizer must never tear down or restart its replacement.
      if (this.recognition !== recognition) return;
      const recoverable =
        event.error === "no-speech" || event.error === "aborted";
      this.notifyListeners("error", {
        code: event.error,
        message: `Speech recognition error: ${event.error}`,
        recoverable,
      });
      if (!recoverable) {
        // A non-recoverable error ends capture without a consumer stop():
        // tear the level meter down here so its microphone track and 100 ms
        // interval do not outlive the error state. Keep this recognizer owned
        // until its required end event arrives, unless start() replaces it.
        this.isActive = false;
        this.stopAudioLevelMonitoring();
        this.notifyListeners("stateChange", {
          state: "error",
          reason: event.error,
        });
      }
    };

    recognition.onresult = (event: SpeechRecognitionResultEvent) => {
      if (this.recognition !== recognition) return;
      this.handleSpeechResult(event);
    };

    this.recognition = recognition;
    const owned = await this.startAudioLevelMonitoring(recognition);
    if (!owned) {
      // stop() or a replacement start() ran while the microphone was being
      // acquired. The recognizer was never started and the level meter this
      // call opened has been released, so the plugin stays idle.
      return stoppedBeforeStart();
    }
    recognition.start();
    return { started: true };
  }

  private handleSpeechResult(event: SpeechRecognitionResultEvent): void {
    // event.results accumulates every result of the continuous session; per the
    // Web Speech API, event.resultIndex marks the first result that CHANGED
    // since the previous dispatch. Iterating from 0 would re-process (and
    // re-fire the wake word for) already-finalized utterances, concatenating
    // them with no separator and handing the agent a garbled command such as
    // "open calendareliza close calendar". Process only the changed window and
    // keep final vs interim text separate. Newly finalized text is appended to
    // wakeBuffer (see below) so a trigger and its command can span separate
    // final results, while a match still runs against finalized text only.
    let finalTranscript = "";
    let interimTranscript = "";
    let hasFinal = false;

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const first = result?.[0];
      if (!first || typeof first.transcript !== "string") continue;
      if (result.isFinal) {
        finalTranscript += first.transcript;
        hasFinal = true;
      } else {
        interimTranscript += first.transcript;
      }
    }

    const transcript = finalTranscript + interimTranscript;
    const isFinal = hasFinal;
    if (!transcript.trim()) return;

    // Web Speech API does not provide word-level timing.
    // Segments are provided for API compatibility but timing values are approximations.
    const words = transcript.split(/\s+/).filter(Boolean);
    this.segments = words.map((text) => ({
      text,
      start: -1, // Unavailable on web
      duration: -1, // Unavailable on web
      isFinal,
    }));

    const lastResult = event.results[event.results.length - 1];
    const confidence = lastResult?.[0]?.confidence;

    this.notifyListeners("transcript", {
      transcript,
      segments: this.segments,
      isFinal,
      confidence,
    });

    if (isFinal && this.wakeGate) {
      // Carry finalized text forward so a trigger in one final result and its
      // command in a later final result (the user pauses after the wake word)
      // still wake. A successful match consumes the buffer so an already-fired
      // utterance is never re-detected when the accumulating results list
      // carries it again; when no trigger is present the buffer is dropped so
      // pre-trigger chatter cannot grow it unbounded or later garble a command.
      this.wakeBuffer = this.wakeBuffer
        ? `${this.wakeBuffer} ${finalTranscript}`
        : finalTranscript;
      const match = this.wakeGate.match(this.wakeBuffer);
      if (match) {
        this.wakeBuffer = "";
        this.notifyListeners("wakeWord", { ...match, transcript, confidence });
      } else if (!this.wakeGate.hasTrigger(this.wakeBuffer)) {
        this.wakeBuffer = "";
      }
    }
  }

  /**
   * Opens the level-meter microphone for `owner` and installs it only while
   * `owner` is still the live recognizer. getUserMedia is always asynchronous,
   * so stop() or a replacement start() can run before it resolves; a stream
   * acquired for a retired recognizer is released here instead of outliving
   * the idle state. Returns whether `owner` still owns capture.
   */
  private async startAudioLevelMonitoring(
    owner: SpeechRecognitionInstance,
  ): Promise<boolean> {
    // error-policy:J5 the level meter is a non-essential visual augmentation to
    // the Web Speech path; a denied mic is already surfaced through
    // recognition.onerror ("not-allowed"), so a failure here degrades the meter
    // without needing a second error event.
    const stream = await navigator.mediaDevices
      .getUserMedia({ audio: true })
      .catch(() => null);
    if (this.recognition !== owner) {
      stream?.getTracks().forEach((t) => {
        t.stop();
      });
      return false;
    }
    if (!stream) return true;

    this.mediaStream = stream;
    this.audioContext = new AudioContext();
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;

    this.audioContext.createMediaStreamSource(stream).connect(this.analyser);
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    this.levelInterval = setInterval(() => {
      if (!this.analyser) return;
      this.analyser.getByteFrequencyData(dataArray);
      const sum = dataArray.reduce((a, b) => a + b, 0);
      this.notifyListeners("audioLevel", {
        level: sum / dataArray.length / 255,
        peak: Math.max(...dataArray) / 255,
      });
    }, 100);
    return true;
  }

  private stopAudioLevelMonitoring(): void {
    if (this.levelInterval) clearInterval(this.levelInterval);
    this.levelInterval = null;
    this.audioContext?.close();
    this.audioContext = null;
    this.mediaStream?.getTracks().forEach((t) => {
      t.stop();
    });
    this.mediaStream = null;
    this.analyser = null;
  }

  async stop(): Promise<void> {
    this.isActive = false;
    this.wakeBuffer = "";

    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      recognition.stop();
    }
    this.stopAudioLevelMonitoring();
    this.notifyListeners("stateChange", { state: "idle" });
  }

  async isListening(): Promise<{ listening: boolean }> {
    return { listening: this.isActive };
  }

  async getConfig(): Promise<{ config: SwabbleConfig | null }> {
    return { config: this.config };
  }

  async updateConfig(options: {
    config: Partial<SwabbleConfig>;
  }): Promise<void> {
    if (this.config) {
      this.config = { ...this.config, ...options.config };
      this.wakeGate?.updateConfig(options.config);

      if (options.config.locale && this.recognition) {
        this.recognition.lang = options.config.locale;
      }
    }
  }

  async checkPermissions(): Promise<SwabblePermissionStatus> {
    let microphone: SwabblePermissionStatus["microphone"] = "prompt";
    try {
      const result = await navigator.permissions?.query?.({
        name: "microphone" as PermissionName,
      });
      if (
        result?.state === "granted" ||
        result?.state === "denied" ||
        result?.state === "prompt"
      ) {
        microphone = result.state;
      }
    } catch {
      // error-policy:J4 Permissions API cannot query microphone here; keep the "prompt" default
      /* permissions.query not supported for microphone in some browsers */
    }
    const speechRecognition: SwabblePermissionStatus["speechRecognition"] =
      getSpeechRecognition() ? "granted" : "not_supported";

    return {
      microphone,
      speechRecognition,
    };
  }

  async requestPermissions(): Promise<SwabblePermissionStatus> {
    try {
      const stream = await navigator.mediaDevices?.getUserMedia?.({
        audio: true,
      });
      if (!stream) throw new Error("mediaDevices.getUserMedia unavailable");
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      return this.checkPermissions();
    } catch {
      // error-policy:J4 mic prompt denied/unavailable; report the denied permission status
      return {
        microphone: "denied",
        speechRecognition: "denied",
      };
    }
  }

  async getAudioDevices(): Promise<{
    devices: Array<{ id: string; name: string; isDefault: boolean }>;
  }> {
    try {
      const devices = await navigator.mediaDevices?.enumerateDevices?.();
      if (!devices) return { devices: [] };
      const audioInputs = devices
        .filter((d) => d.kind === "audioinput")
        .map((d, i) => ({
          id: d.deviceId,
          name: d.label || `Microphone ${i + 1}`,
          isDefault: d.deviceId === "default",
        }));
      return { devices: audioInputs };
    } catch {
      // error-policy:J4 enumerateDevices unavailable; same designed empty-list state as the no-API path
      return { devices: [] };
    }
  }

  async setAudioDevice(_options: { deviceId: string }): Promise<void> {
    // Web Speech API doesn't support device selection directly.
    // The browser uses its default audio input device.
    throw new Error(
      "setAudioDevice is not supported on web platform - browser uses system default audio input",
    );
  }
}
