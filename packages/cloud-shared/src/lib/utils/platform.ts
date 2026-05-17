/**
 * Platform Detection Utilities
 *
 * Provides utilities for detecting the current platform and adjusting
 * behavior accordingly for web, iOS, and Android.
 */

/**
 * Platform types
 */
export type Platform = "web" | "ios" | "android" | "unknown";

/**
 * Check if running in a browser environment
 */
export function isBrowser(): boolean {
  return typeof window !== "undefined";
}

/**
 * Check if running as a mobile app
 */
export function isMobileApp(): boolean {
  if (!isBrowser()) return false;

  return process.env.NEXT_PUBLIC_IS_MOBILE_APP === "true" || isIOS() || isAndroid();
}

/**
 * Check if running on iOS
 */
export function isIOS(): boolean {
  if (!isBrowser()) return false;

  const userAgent = navigator.userAgent || navigator.vendor;
  return /iPad|iPhone|iPod/.test(userAgent);
}

/**
 * Check if running on Android
 */
export function isAndroid(): boolean {
  if (!isBrowser()) return false;

  const userAgent = navigator.userAgent || navigator.vendor;
  return /Android/.test(userAgent);
}

/**
 * Check if running in a WebView (not standalone browser)
 */
export function isWebView(): boolean {
  if (!isBrowser()) return false;

  const userAgent = navigator.userAgent.toLowerCase();

  // Common WebView indicators
  return (
    userAgent.includes("wv") || // Android WebView
    userAgent.includes("webview") ||
    (isIOS() && !userAgent.includes("safari")) // iOS WebView (not Safari)
  );
}

/**
 * Get the current platform
 */
export function getPlatform(): Platform {
  if (!isBrowser()) return "unknown";

  if (isIOS()) return "ios";
  if (isAndroid()) return "android";

  return "web";
}

/**
 * Check if the device has touch capability
 */
export function isTouchDevice(): boolean {
  if (!isBrowser()) return false;

  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

/**
 * Get the safe area insets (for notched devices)
 */
export function getSafeAreaInsets(): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  if (!isBrowser()) {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }

  const computedStyle = getComputedStyle(document.documentElement);

  return {
    top: parseInt(computedStyle.getPropertyValue("--sat") || "0", 10),
    right: parseInt(computedStyle.getPropertyValue("--sar") || "0", 10),
    bottom: parseInt(computedStyle.getPropertyValue("--sab") || "0", 10),
    left: parseInt(computedStyle.getPropertyValue("--sal") || "0", 10),
  };
}

/**
 * Get platform-specific configuration
 */
export function getPlatformConfig(): {
  platform: Platform;
  isMobile: boolean;
  isTouch: boolean;
  supportsNotifications: boolean;
  supportsHaptics: boolean;
} {
  const platform = getPlatform();
  const isMobile = platform === "ios" || platform === "android";

  return {
    platform,
    isMobile,
    isTouch: isTouchDevice(),
    supportsNotifications: isBrowser() && "Notification" in window,
    supportsHaptics: isBrowser() && "vibrate" in navigator,
  };
}

/**
 * Get user agent info for debugging
 */
export function getUserAgentInfo(): Record<string, unknown> {
  if (!isBrowser()) {
    return { environment: "server" };
  }

  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    vendor: navigator.vendor,
    language: navigator.language,
    cookieEnabled: navigator.cookieEnabled,
    onLine: navigator.onLine,
    maxTouchPoints: navigator.maxTouchPoints,
    detected: {
      platform: getPlatform(),
      isMobileApp: isMobileApp(),
      isWebView: isWebView(),
      isTouch: isTouchDevice(),
    },
  };
}
