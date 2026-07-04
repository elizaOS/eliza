/**
 * Apple Vision Pro device constants describe visionOS WebXR capabilities and
 * native app compatibility.
 */
export { DEVICE_REGISTRY } from "./registry.ts";
export const AVP_WEBXR_FEATURES = [
  "local-floor",
  "hit-test",
  "dom-overlay",
  "eye-tracking",
  "hand-tracking",
];
export const VISIONOS_MIN_VERSION = "1.0";
export const VISIONOS_RECOMMENDED_VERSION = "2.4";
export const AVP_SAFARI_WEBXR_SUPPORT = "visionOS 1.1+";
// The ElizaFacewear native app hosts the PWA in WKWebView.
export const AVP_WKWEBVIEW_WEBXR = true;
