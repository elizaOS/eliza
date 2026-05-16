import type { ResponseDecision, ResponseGateSignals } from "./types.ts";

export const DEFAULT_OWNER_CONFIDENCE_THRESHOLD = 0.6;
export const WAKE_INTENT_THRESHOLD = 0.85;
export const CONTEXT_OWNER_CONFIDENCE_FLOOR = 0.5;

export function decideResponse(
  signals: ResponseGateSignals,
  threshold: number = DEFAULT_OWNER_CONFIDENCE_THRESHOLD,
): ResponseDecision {
  if (!signals.vadActive) {
    return "silent";
  }
  if (signals.directAddress && signals.ownerConfidence >= threshold) {
    return "respond";
  }
  if (signals.wakeIntent >= WAKE_INTENT_THRESHOLD) {
    return "respond";
  }
  if (
    signals.contextExpectsReply &&
    signals.ownerConfidence >= CONTEXT_OWNER_CONFIDENCE_FLOOR
  ) {
    return "respond";
  }
  return "observe";
}
