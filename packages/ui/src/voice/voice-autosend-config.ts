/**
 * Auto-send + VAD tunables — ONE clearly-named home (voice V2a extension).
 *
 * Owner direction (2026-07-07): auto-send on end-of-speech ships IN this PR but
 * OFF by default (composer-review is the launch default; auto-send flips to
 * default "only once it works reliably"). VAD end-of-speech detection is now
 * first-class: its parameters must be TUNABLE constants in one place, not magic
 * numbers scattered across the capture loop, because we iterate on-device.
 *
 * This module centralizes:
 *   1. The auto-send end-of-turn VAD window + the reliability guards that gate
 *      whether an auto-detected turn is safe to SEND (vs a stray noise blip).
 *   2. The minimum-transcript guard (don't auto-send empty / one-token accidental
 *      noise — the reliability gate for flipping the default later).
 *
 * The base energy VAD thresholds (`speechRmsThreshold` / `speechPeakThreshold` /
 * `silenceMs` for hands-free turn-end) live in `local-asr-capture.ts`
 * `DEFAULT_LOCAL_ASR_AUTO_STOP` (#15267) and are user-tunable via
 * `loadVadAutoStop()`. Auto-send REUSES those — it does not fork a second VAD.
 * What lives here is the auto-send-specific policy layered on top.
 */

import { DEFAULT_LOCAL_ASR_AUTO_STOP } from "./local-asr-capture";

/**
 * Tunables for auto-send on end-of-speech. Kept as one exported const so
 * on-device iteration edits a single, named place. Every value is overridable
 * per-call (the composer threads the persisted VAD `silenceMs` in, so a user's
 * tuned turn-end window still wins for auto-send too).
 */
export interface VoiceAutoSendConfig {
  /**
   * Trailing-silence window (ms) that ends an auto-send turn. Defaults to the
   * shared hands-free turn-end window so auto-send and hands-free feel the same;
   * a slightly LONGER window is defensible for auto-send (a premature cutoff
   * there SENDS a truncated message, which is worse than a premature cutoff in
   * review mode where the user still edits). Start matched; iterate on-device.
   */
  silenceMs: number;
  /**
   * Minimum number of transcript CHARACTERS required to auto-send. Below this,
   * the detected turn is treated as accidental noise and NOT sent (the capture
   * still finalizes into the composer draft so nothing is lost — the user can
   * review/edit/send manually). Reliability gate #1.
   */
  minTranscriptChars: number;
  /**
   * Minimum number of transcript WORDS required to auto-send. A single-token
   * "uh" / "hm" / a mis-fired word from a cough clears the char floor but is
   * still likely noise; require at least this many words. Reliability gate #2.
   */
  minTranscriptWords: number;
  /**
   * Minimum captured SPEECH duration (ms) before an auto-send turn is eligible.
   * A sub-threshold blip (door slam, keyboard clack read as speech) that somehow
   * produced a transcript is rejected. Reuses the base VAD `minSpeechMs` idea
   * but at a higher bar for the send decision. Reliability gate #3.
   */
  minSpeechMs: number;
}

/**
 * Default auto-send policy. Conservative by design — the whole point of shipping
 * auto-send OFF-by-default is that these must be provably safe before the
 * default flips. Bump the guards UP if false-sends appear in device testing;
 * loosen only with evidence.
 */
export const DEFAULT_VOICE_AUTOSEND: VoiceAutoSendConfig = {
  // Match the shared hands-free turn-end window (650ms, #voice-V6) so the felt
  // turn-end timing is consistent across modes. On-device we may lengthen this
  // for auto-send specifically (see the silenceMs docblock).
  silenceMs: DEFAULT_LOCAL_ASR_AUTO_STOP.silenceMs,
  // ~2 short words. Below this, almost certainly not an intended message.
  minTranscriptChars: 3,
  // "turn on" is 2 words; "hey" alone (1 word) should NOT auto-send.
  minTranscriptWords: 2,
  // 300ms of speech: longer than the base 180ms min-speech so a brief blip that
  // squeaked past the base VAD still can't trigger a SEND.
  minSpeechMs: 300,
};

/** Result of the auto-send reliability check, with a reason for QA/debug logs. */
export interface AutoSendDecision {
  send: boolean;
  /** Machine-readable reason (drives the VAD debug log — owner ask 3b). */
  reason:
    | "ok"
    | "empty"
    | "too-few-chars"
    | "too-few-words"
    | "too-short-speech"
    | "disabled";
}

/** Count whitespace-delimited words in a transcript. */
function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Decide whether an auto-detected end-of-speech turn is safe to SEND.
 *
 * This is the reliability gate the owner flagged for flipping the default
 * later: it must reject empty / one-token accidental noise. When it returns
 * `send:false`, the caller finalizes the transcript into the composer draft
 * (review mode) instead of sending — nothing is lost, the user just confirms.
 *
 * `speechDurationMs` is optional: transcript-only backends may not surface it,
 * in which case the duration gate is skipped (the char/word gates still apply).
 */
export function evaluateAutoSend(
  transcript: string,
  config: VoiceAutoSendConfig,
  speechDurationMs?: number,
): AutoSendDecision {
  const trimmed = transcript.trim();
  if (!trimmed) return { send: false, reason: "empty" };
  if (trimmed.length < config.minTranscriptChars) {
    return { send: false, reason: "too-few-chars" };
  }
  if (wordCount(trimmed) < config.minTranscriptWords) {
    return { send: false, reason: "too-few-words" };
  }
  if (
    typeof speechDurationMs === "number" &&
    speechDurationMs < config.minSpeechMs
  ) {
    return { send: false, reason: "too-short-speech" };
  }
  return { send: true, reason: "ok" };
}
