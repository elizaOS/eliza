/**
 * Barrel for the ambient-audio subsystem: re-exports the consent state, replay
 * buffer, response gate, in-memory service, and the shared ambient-audio types.
 */
export { AmbientAudioConsentState } from "./consent.ts";
export { ReplayBuffer } from "./replay-buffer.ts";
export { decideResponse } from "./response-gate.ts";
export type { InMemoryAmbientAudioServiceOptions } from "./service.ts";
export { InMemoryAmbientAudioService } from "./service.ts";
export type {
  AmbientAudioMode,
  AmbientAudioService,
  AudioFrame,
  ConsentRecord,
  ResponseDecision,
  ResponseGateSignals,
  TranscribedSegment,
} from "./types.ts";
