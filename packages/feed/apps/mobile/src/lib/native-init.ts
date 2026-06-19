/**
 * Native feature initialization for the Capacitor mobile app.
 *
 * Call `initNativeFeatures()` once in the root layout after the user
 * is authenticated. This sets up:
 * - Status bar theming
 * - Android back button handling
 * - Push notifications (when infrastructure is ready)
 * - App lifecycle listeners
 */

import { initAppLifecycle } from "./deep-links";
import { isNativePlatform } from "./platform";
import { setStatusBarStyle } from "./status-bar";

interface NativeInitOptions {
  theme: "dark" | "light";
  navigate: (path: string) => void;
}

let initialized = false;

/**
 * Initialize all native Capacitor features.
 * Safe to call multiple times — only runs once.
 */
export async function initNativeFeatures({
  theme,
  navigate,
}: NativeInitOptions): Promise<void> {
  if (!isNativePlatform() || initialized) return;
  initialized = true;

  await setStatusBarStyle(theme);
  await initAppLifecycle({ navigate });

  // Keyboard plugin — resize body when keyboard opens
  const { Keyboard } = await import("@capacitor/keyboard");
  Keyboard.addListener("keyboardWillShow", (info) => {
    document.body.style.setProperty(
      "--keyboard-height",
      `${info.keyboardHeight}px`,
    );
  });
  Keyboard.addListener("keyboardWillHide", () => {
    document.body.style.setProperty("--keyboard-height", "0px");
  });
}

/**
 * Update status bar when theme changes.
 */
export async function updateTheme(theme: "dark" | "light"): Promise<void> {
  if (!isNativePlatform()) return;
  await setStatusBarStyle(theme);
}
