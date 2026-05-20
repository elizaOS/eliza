/**
 * Status bar and safe area utilities for Capacitor mobile app.
 *
 * Configures the native status bar appearance to match the app theme
 * and provides safe area awareness for notch/dynamic island/nav bar.
 */

import { isAndroid, isNativePlatform } from "./platform";

export type StatusBarStyle = "dark" | "light";

/**
 * Set the status bar style to match the current theme.
 * Call this when the theme changes.
 *
 * - dark theme → light status bar text (white icons on dark bg)
 * - light theme → dark status bar text (black icons on light bg)
 */
export async function setStatusBarStyle(theme: StatusBarStyle): Promise<void> {
  if (!isNativePlatform()) return;

  const { StatusBar, Style } = await import("@capacitor/status-bar");
  await StatusBar.setStyle({
    style: theme === "dark" ? Style.Dark : Style.Light,
  });

  // On Android, also set the background color
  if (isAndroid()) {
    await StatusBar.setBackgroundColor({
      color: theme === "dark" ? "#0a0a0a" : "#ffffff",
    });
  }
}

/**
 * Make the status bar overlay the WebView content.
 * This is needed for edge-to-edge display on Android.
 * iOS does this by default with WKWebView.
 */
export async function enableEdgeToEdge(): Promise<void> {
  if (!isNativePlatform()) return;

  const { StatusBar } = await import("@capacitor/status-bar");
  await StatusBar.setOverlaysWebView({ overlay: true });
}
