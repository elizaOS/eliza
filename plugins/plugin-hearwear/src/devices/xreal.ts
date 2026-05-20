export { DEVICE_REGISTRY } from "./registry.ts";
export const XREAL_SDK_VERSION = "3.0.0";
export const XREAL_WEBXR_FEATURES = ["local-floor", "hit-test", "dom-overlay"];
export const XREAL_DEVICE_TYPES = [
  "xreal-air-3",
  "xreal-air-2-ultra",
  "xreal-air-2-pro",
  "xreal-one-pro",
  "xreal-one",
] as const;
export type XrealDeviceType = (typeof XREAL_DEVICE_TYPES)[number];
// XREAL SDK 3.0.0: NRCameraRig replaces Camera2 for camera access
export const XREAL_CAMERA_RIG_CLASS = "com.xreal.nrsdk.NRCameraRig";
