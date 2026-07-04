/**
 * Pure decision function that decides whether the agent should speak in
 * response to ambient audio. Weighs the gate signals — direct address, wake
 * intent, owner confidence, whether the context expects a reply, and VAD
 * activity — and returns a `ResponseDecision` carrying the winning reason and a
 * confidence score. Signal values are clamped to [0,1]; no side effects.
 */
import type { ResponseDecision, ResponseGateSignals } from "./types.ts";

const clamp01 = (value: number): number =>
  Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

export function decideResponse(signals: ResponseGateSignals): ResponseDecision {
  const ownerConfidence = clamp01(signals.ownerConfidence);
  const wakeIntent = clamp01(signals.wakeIntent);

  if (signals.directAddress && ownerConfidence >= 0.25) {
    return {
      shouldRespond: true,
      reason: "direct-address",
      score: Math.max(ownerConfidence, 0.75),
    };
  }

  if (wakeIntent >= 0.65 && ownerConfidence >= 0.35) {
    return {
      shouldRespond: true,
      reason: "wake-intent",
      score: (wakeIntent + ownerConfidence) / 2,
    };
  }

  if (
    signals.contextExpectsReply &&
    !signals.vadActive &&
    ownerConfidence >= 0.5
  ) {
    return {
      shouldRespond: true,
      reason: "expected-reply",
      score: ownerConfidence,
    };
  }

  return {
    shouldRespond: false,
    reason: "insufficient-signal",
    score: Math.max(ownerConfidence * 0.5, wakeIntent * 0.5),
  };
}
