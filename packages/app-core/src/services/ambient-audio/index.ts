export type { SerializedConsentStore } from "./consent-store.ts";
export { ConsentStore } from "./consent-store.ts";
export { ReplayBuffer } from "./replay-buffer.ts";
export {
  CONTEXT_OWNER_CONFIDENCE_FLOOR,
  DEFAULT_OWNER_CONFIDENCE_THRESHOLD,
  decideResponse,
  WAKE_INTENT_THRESHOLD,
} from "./response-gate.ts";
export type {
  AmbientAudioService,
  MockAmbientAudioServiceOptions,
} from "./service.ts";
export { MockAmbientAudioService } from "./service.ts";
export type {
  AmbientMode,
  AudioFrame,
  ConsentRecord,
  ReplayBufferConfig,
  ResponseDecision,
  ResponseGateSignals,
  TranscribedSegment,
} from "./types.ts";
