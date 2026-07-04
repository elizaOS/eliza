/** Zoom Web Client adapter public surface. */
export { ZoomAdapter } from "./adapter.js";
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
export { ZoomSpeakerAttributor } from "./speaker-attribution.js";
export {
  createZoomStrategies,
  type ZoomStrategyOptions,
} from "./strategies.js";
