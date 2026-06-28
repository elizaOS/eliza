/**
 * Platform detection for the Capacitor mobile app.
 * Lazy-initialized on first access, cached for subsequent calls.
 */

interface PlatformInfo {
  isNative: boolean;
  platform: "ios" | "android" | "web" | "ssr";
}

interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

interface CapacitorWindow extends Window {
  Capacitor?: CapacitorBridge;
}

let cached: PlatformInfo | undefined;

function normalizeCapacitorPlatform(
  platform: string | undefined,
): PlatformInfo["platform"] {
  switch (platform) {
    case "ios":
    case "android":
    case "web":
      return platform;
    default:
      return "android";
  }
}

function detect(): PlatformInfo {
  if (typeof window === "undefined") {
    return { isNative: false, platform: "ssr" };
  }

  const cap = (window as CapacitorWindow).Capacitor;
  if (cap?.isNativePlatform?.()) {
    return {
      isNative: true,
      platform: normalizeCapacitorPlatform(cap.getPlatform?.()),
    };
  }

  const origin = window.location.origin;
  if (origin.startsWith("capacitor://")) {
    return { isNative: true, platform: "ios" };
  }
  if (
    origin === "https://localhost" &&
    /Android/i.test(window.navigator?.userAgent ?? "")
  ) {
    return { isNative: true, platform: "android" };
  }

  return { isNative: false, platform: "web" };
}

function get(): PlatformInfo {
  cached ??= detect();
  return cached;
}

export const isNativePlatform = () => get().isNative;
export const getPlatform = () => get().platform;
export const isIOS = () => get().platform === "ios";
export const isAndroid = () => get().platform === "android";
