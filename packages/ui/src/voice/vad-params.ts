/**
 * SINGLE SOURCE of the end-of-speech VAD tunables + the auto-send min-transcript
 * guard params (voice auto-send + VAD tunability lane, on top of V2a #15417).
 *
 * WHY this module exists: the owner (wakesync) iterates on VAD behaviour on-
 * device, so every knob that decides "when does a turn end" and "is this
 * transcript real enough to auto-send" must live in ONE named place — never a
 * magic number scattered across the capture loop. `voice/vad-params.test.ts`
 * asserts this module is the single source (the auto-stop config values equal
 * these, not a divergent copy).
 *
 * This is intentionally a thin re-export + extension of
 * `DEFAULT_LOCAL_ASR_AUTO_STOP` (local-asr-capture.ts) rather than a second copy:
 * the capture detector already reads that config, so re-exporting it here keeps
 * ONE runtime source while giving callers (auto-send guard, dev logging, future
 * settings UI) a single clearly-named import surface. When you tune a param on-
 * device, change it in `DEFAULT_LOCAL_ASR_AUTO_STOP` (the runtime default) and it
 * flows here; the guard params below are owned HERE.
 */

import { DEFAULT_LOCAL_ASR_AUTO_STOP } from "./local-asr-capture";

/**
 * End-of-speech VAD params — the "when does a hands-free turn end" knobs. These
 * are the RUNTIME defaults the capture auto-stop detector uses
 * (`DEFAULT_LOCAL_ASR_AUTO_STOP`), surfaced here as the single named tuning
 * surface. A persisted user override (`loadVadAutoStop()`) still wins at runtime;
 * these are the floor the override falls back to.
 *
 * - `startGraceMs`  — ignore the first N ms after mic-open before arming end-of-
 *   speech detection (avoids a click/first-frame artifact ending the turn).
 * - `minSpeechMs`   — a turn must contain at least this much detected speech
 *   before a trailing-silence cutoff can fire (kills sub-word noise turns).
 * - `silenceMs`     — trailing silence that ends a turn. THE primary latency
 *   knob (shorter = snappier, but risks clipping deliberate speakers).
 * - `maxSpeechMs`   — hard cap: force-stop a runaway capture.
 * - `speechRmsThreshold` / `speechPeakThreshold` — energy gates classifying a
 *   frame as speech vs silence.
 */
export const END_OF_SPEECH_VAD = {
  startGraceMs: DEFAULT_LOCAL_ASR_AUTO_STOP.startGraceMs,
  minSpeechMs: DEFAULT_LOCAL_ASR_AUTO_STOP.minSpeechMs,
  silenceMs: DEFAULT_LOCAL_ASR_AUTO_STOP.silenceMs,
  maxSpeechMs: DEFAULT_LOCAL_ASR_AUTO_STOP.maxSpeechMs,
  speechRmsThreshold: DEFAULT_LOCAL_ASR_AUTO_STOP.speechRmsThreshold,
  speechPeakThreshold: DEFAULT_LOCAL_ASR_AUTO_STOP.speechPeakThreshold,
} as const;

/**
 * Auto-send reliability guard params (owned HERE — the bar that must pass before
 * an end-of-speech transcript is auto-sent hands-free). This guard is the gate
 * for flipping the auto-send default from `review` → `on` later, so it lives in
 * one named place we can tighten on-device.
 *
 * - `minChars`        — reject a transcript shorter than this (whitespace-
 *   trimmed). A stray "a"/"the" from a cough is below the bar.
 * - `minWords`        — reject a single-token transcript (needs ≥ this many
 *   whitespace words). A lone word is almost always a misfire, not a command.
 * - `minSpeechMs`     — reject a turn whose detected-speech duration was under
 *   this (a too-short blip). Optional at the call site (only enforced when the
 *   caller can supply a measured speech duration).
 */
export const AUTO_SEND_GUARD = {
  minChars: 2,
  minWords: 2,
  minSpeechMs: 350,
} as const;

/**
 * View types for the two param blocks. Widened from the `as const` literal so
 * callers/tests can pass tuned param objects (e.g. a looser guard) — the runtime
 * constants above remain the single source of the DEFAULTS.
 */
export type EndOfSpeechVadParams = {
  [K in keyof typeof END_OF_SPEECH_VAD]: number;
};
export type AutoSendGuardParams = {
  [K in keyof typeof AUTO_SEND_GUARD]: number;
};
