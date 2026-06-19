import type { OwnerConfidence } from "./types.ts";

export interface OwnerConfidenceInput {
  voiceSimilarityToOwnerProfile: number;
  deviceTrustLevel: "low" | "medium" | "high";
  recentlyAuthenticated: boolean;
  contextExpectsOwner: boolean;
  challengeRecentlyPassed: boolean;
}

const DEVICE_TRUST_WEIGHT: Record<"low" | "medium" | "high", number> = {
  low: 0.0,
  medium: 0.1,
  high: 0.2,
};

const CHALLENGE_WEIGHT = 0.45;
const RECENT_AUTH_WEIGHT = 0.35;
const VOICE_WEIGHT_CAP = 0.25;
const CONTEXT_WEIGHT = 0.1;

export function scoreOwnerConfidence(
  input: OwnerConfidenceInput,
): OwnerConfidence {
  const reasons: string[] = [];
  let score = 0;

  if (input.challengeRecentlyPassed) {
    score += CHALLENGE_WEIGHT;
    reasons.push("challenge-recently-passed");
  }
  if (input.recentlyAuthenticated) {
    score += RECENT_AUTH_WEIGHT;
    reasons.push("recently-authenticated");
  }

  const clampedVoice = Math.max(
    0,
    Math.min(1, input.voiceSimilarityToOwnerProfile),
  );
  if (clampedVoice > 0) {
    const voiceContribution = clampedVoice * VOICE_WEIGHT_CAP;
    score += voiceContribution;
    reasons.push(`voice-similarity:${clampedVoice.toFixed(2)}`);
  }

  const trust = DEVICE_TRUST_WEIGHT[input.deviceTrustLevel];
  if (trust > 0) {
    score += trust;
    reasons.push(`device-trust:${input.deviceTrustLevel}`);
  }

  if (input.contextExpectsOwner) {
    score += CONTEXT_WEIGHT;
    reasons.push("context-expects-owner");
  }

  const clamped = Math.max(0, Math.min(1, score));
  return { score: clamped, reasons };
}
