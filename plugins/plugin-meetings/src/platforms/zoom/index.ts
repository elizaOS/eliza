/** Zoom Web Client adapter public surface. */

export { ZoomAdapter } from "./adapter.js";
export {
  buildZoomCanonicalArtifact,
  classifyZoomImportError,
  type ZoomCanonicalArtifact,
  type ZoomCanonicalArtifactInput,
  type ZoomCanonicalGeneratedNote,
  type ZoomCanonicalParticipant,
  type ZoomCanonicalStream,
  type ZoomCanonicalStreamKind,
  type ZoomCanonicalTranscriptSpan,
  type ZoomCanonicalWarning,
  type ZoomCapturePath,
  type ZoomCloudMeeting,
  type ZoomCloudParticipant,
  type ZoomCloudRecordingFile,
  type ZoomCloudTranscriptEntry,
  type ZoomGeneratedNoteInput,
  type ZoomLiveCaptureArtifact,
  type ZoomLiveCaptureOutcome,
  type ZoomLiveCaptureStreamInput,
  type ZoomMissingArtifact,
  type ZoomMissingArtifactReason,
  type ZoomQualityMetricsInput,
  type ZoomSourceLoss,
  type ZoomTranscriptSource,
} from "./artifacts.js";
export * from "./cloud-import.js";
export {
  classifyZoomPage,
  isZoomAudioInitUrl,
  isZoomDomainUrl,
  type ZoomPageSnapshot,
  type ZoomPageState,
} from "./page-state.js";
export {
  createNullSink,
  PulsePcmCapture,
  pulseAudioAvailable,
  s16leToFloat32,
  unloadNullSink,
} from "./pulse-capture.js";
export * from "./shared-artifact.js";
export { ZoomSpeakerAttributor } from "./speaker-attribution.js";
export {
  createZoomStrategies,
  type ZoomStrategyOptions,
} from "./strategies.js";
