export type FacewearDeviceType =
  | "meta-quest"
  | "xreal"
  | "even-realities"
  | "apple-vision-pro"
  | "simulator";

export interface FacewearDeviceProfile {
  id: FacewearDeviceType;
  displayName: string;
  manufacturer: string;
  connectionType: "webxr" | "ble" | "webxr+ble";
  features: string[];
  sdkName?: string;
  sdkVersion?: string;
  sdkUrl?: string;
  emulatorSupported: boolean;
  nativeAppPlatform?: "android" | "visionos" | "both";
  nativeAppPath?: string;
}

export const DEVICE_REGISTRY: Record<FacewearDeviceType, FacewearDeviceProfile> = {
  "meta-quest": {
    id: "meta-quest",
    displayName: "Meta Quest 3 / 3S / Pro",
    manufacturer: "Meta",
    connectionType: "webxr",
    features: ["webxr", "hand-tracking", "passthrough", "room-scale", "eye-tracking"],
    sdkName: "Meta XR SDK",
    sdkVersion: "68.0",
    sdkUrl: "https://developer.oculus.com/downloads/",
    emulatorSupported: true,
    nativeAppPlatform: "android",
    nativeAppPath: "native/android/quest",
  },
  xreal: {
    id: "xreal",
    displayName: "XReal Air 3 / One Pro / Air 2 Ultra",
    manufacturer: "XREAL",
    connectionType: "webxr",
    features: ["webxr", "3dof", "spatial-display", "ar-passthrough"],
    sdkName: "XREAL SDK",
    sdkVersion: "3.0.0",
    sdkUrl: "https://developer.xreal.com/",
    emulatorSupported: true,
    nativeAppPlatform: "android",
    nativeAppPath: "native/android/xreal",
  },
  "even-realities": {
    id: "even-realities",
    displayName: "Even Realities G1 / G2",
    manufacturer: "Even Realities",
    connectionType: "ble",
    features: ["ble", "oled-display", "microphone", "side-tap", "wifi-provisioning"],
    sdkName: "G1 BLE Protocol (built-in)",
    emulatorSupported: true,
    nativeAppPlatform: "android",
    nativeAppPath: "native/android/even-realities",
  },
  "apple-vision-pro": {
    id: "apple-vision-pro",
    displayName: "Apple Vision Pro",
    manufacturer: "Apple",
    connectionType: "webxr",
    features: ["visionos", "webxr", "eye-tracking", "hand-tracking", "spatial-audio", "passthrough", "realitykit"],
    sdkName: "visionOS SDK",
    sdkVersion: "2.4",
    sdkUrl: "https://developer.apple.com/visionos/",
    emulatorSupported: true,
    nativeAppPlatform: "visionos",
    nativeAppPath: "native/visionos",
  },
  simulator: {
    id: "simulator",
    displayName: "WebXR Simulator (Browser)",
    manufacturer: "elizaOS",
    connectionType: "webxr",
    features: ["webxr", "simulated"],
    emulatorSupported: true,
  },
};

export function getDeviceProfile(deviceType: FacewearDeviceType): FacewearDeviceProfile {
  return DEVICE_REGISTRY[deviceType];
}

export function getAllDeviceProfiles(): FacewearDeviceProfile[] {
  return Object.values(DEVICE_REGISTRY);
}
