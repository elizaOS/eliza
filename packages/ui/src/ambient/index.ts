/**
 * Ambient mode public surface.
 *
 * The LP3-first always-listening capture UI, backed by the pendant session
 * stack behind a transport adapter (batch today, WebSocket TODO seam). See
 * AMBIENT-MODE-DESIGN-2026-07-10.md. Everything here is flag-gated
 * ({@link AMBIENT_ENABLED}); nothing mounts unless ambient is enabled.
 */

export { AMBIENT_ENABLED, readAmbientFlag } from "./ambient-flag";
export {
  AMBIENT_CONSENT_AFFIRMATION,
  AMBIENT_TWO_PARTY_REMINDER,
  type AmbientConsentState,
  ambientCaptureAllowed,
  ambientConsentAffirmation,
  ambientConsentReducer,
} from "./ambient-consent";
export {
  type AmbientCaptureStatus,
  type AmbientProcessingLocation,
  type AmbientSegmentListener,
  type AmbientSessionAdapter,
  type AmbientSessionSnapshot,
  type AmbientSnapshotListener,
  type AmbientTransportKind,
  ambientStatusFromPendant,
  createAmbientWebSocketAdapter,
  selectAmbientTransport,
} from "./ambient-session-adapter";
export {
  type UseAmbientSessionOptions,
  type UseAmbientSessionResult,
  useAmbientSession,
} from "./useAmbientSession";
export {
  AmbientCaptureControl,
  type AmbientCaptureControlProps,
  formatAmbientDuration,
} from "./AmbientCaptureControl";
export {
  AmbientConsentGate,
  type AmbientConsentGateProps,
} from "./AmbientConsentGate";
export {
  AmbientRecordingIndicator,
  type AmbientRecordingIndicatorProps,
} from "./AmbientRecordingIndicator";
export {
  AmbientTranscriptFeed,
  type AmbientTranscriptFeedProps,
} from "./AmbientTranscriptFeed";
