/**
 * Auto-send reliability guard (voice auto-send lane, on top of V2a #15417).
 *
 * When hands-free auto-send is enabled, an end-of-speech transcript is sent to
 * the agent WITHOUT the user reviewing it in the composer. That is only safe if
 * the transcript is unambiguously real speech — never an empty capture, a single
 * stray token from a cough/click, or a sub-threshold-duration blip. This guard
 * is the bar; it is also the bar the owner uses to decide when auto-send can flip
 * from `review` (launch default) to `on` by default.
 *
 * Pure + dependency-free so it's trivially unit-testable and reusable from both
 * the composer/PTT auto-send path (useVoiceChat) and any future ambient path.
 * Params come from the single VAD-params source (`AUTO_SEND_GUARD`).
 */

import { AUTO_SEND_GUARD, type AutoSendGuardParams } from "./vad-params";

/** Why an auto-send was suppressed (for dev logging / QA). */
export type AutoSendRejectReason =
  | "empty"
  | "too-short-chars"
  | "single-token"
  | "too-short-speech";

export interface AutoSendGuardInput {
  /** The finalized transcript text. */
  transcript: string;
  /**
   * Measured detected-speech duration for the turn, if the caller has it. When
   * omitted the speech-duration check is skipped (transcript-only backends can
   * still pass on the char/word checks).
   */
  speechMs?: number;
}

export interface AutoSendGuardResult {
  /** True when the transcript clears every guard and may be auto-sent. */
  ok: boolean;
  /** Populated when `ok` is false — the first failing check. */
  reason?: AutoSendRejectReason;
  /** Word count used for the decision (for dev logging). */
  wordCount: number;
  /** Trimmed char length used for the decision (for dev logging). */
  charCount: number;
}

/** Whitespace-split word count (empty in → 0). */
function countWords(trimmed: string): number {
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Decide whether a finalized transcript passes the auto-send reliability bar.
 * Checks run cheapest→most-specific and report the FIRST failing reason:
 *   1. non-empty (trimmed)
 *   2. ≥ `minChars`
 *   3. ≥ `minWords` (not a single stray token)
 *   4. detected-speech duration ≥ `minSpeechMs` (only when `speechMs` supplied)
 *
 * NEVER throws — a malformed input resolves to `{ ok: false, reason: "empty" }`.
 */
export function passesAutoSendGuard(
  input: AutoSendGuardInput,
  params: AutoSendGuardParams = AUTO_SEND_GUARD,
): AutoSendGuardResult {
  const trimmed = (input.transcript ?? "").trim();
  const charCount = trimmed.length;
  const wordCount = countWords(trimmed);

  if (charCount === 0) {
    return { ok: false, reason: "empty", wordCount, charCount };
  }
  if (charCount < params.minChars) {
    return { ok: false, reason: "too-short-chars", wordCount, charCount };
  }
  if (wordCount < params.minWords) {
    return { ok: false, reason: "single-token", wordCount, charCount };
  }
  if (
    typeof input.speechMs === "number" &&
    Number.isFinite(input.speechMs) &&
    input.speechMs < params.minSpeechMs
  ) {
    return { ok: false, reason: "too-short-speech", wordCount, charCount };
  }
  return { ok: true, wordCount, charCount };
}
