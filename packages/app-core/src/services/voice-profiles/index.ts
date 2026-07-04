/**
 * Barrel for the voice-profiles service surface: re-exports the subsystem's
 * public types and default implementations — the diarization pipeline, the
 * naive (regex-only) nickname evaluator, the owner-confidence scorer, the
 * in-memory owner challenge service, and the in-memory voice-profile store.
 */
export type { DiarizationPipeline } from "./diarization-pipeline.ts";
export { MOCK_DIARIZATION_PIPELINE } from "./diarization-pipeline.ts";
export type {
  NicknameEvaluator,
  NicknameProposal,
} from "./nickname-evaluator.ts";
export { NAIVE_NICKNAME_EVALUATOR } from "./nickname-evaluator.ts";
export type { OwnerConfidenceInput } from "./owner-confidence.ts";
export { scoreOwnerConfidence } from "./owner-confidence.ts";
export type {
  ChallengeService,
  InMemoryChallengeServiceOptions,
} from "./private-challenge.ts";
export { InMemoryChallengeService } from "./private-challenge.ts";
export type { VoiceProfileSearchHit, VoiceProfileStore } from "./store.ts";
export { InMemoryVoiceProfileStore } from "./store.ts";
export type {
  DiarizationSegment,
  OwnerChallenge,
  OwnerConfidence,
  VoiceEmbeddingSummary,
  VoiceProfile,
  VoiceProfileQuality,
} from "./types.ts";
