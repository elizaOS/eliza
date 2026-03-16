/**
 * Milaidy Capacitor App Entry Point
 *
 * This file initializes the Capacitor runtime and loads the Milaidy UI.
 * It handles platform-specific initialization and provides bridges between
 * the web UI and native capabilities.
 */

import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { Keyboard } from "@capacitor/keyboard";
import { StatusBar, Style } from "@capacitor/status-bar";

// Import styles from the shared UI
import "../../ui/src/styles.css";

// Import the main app component which registers <milaidy-app>
import "../../ui/src/ui/app.js";

// Import Capacitor bridge utilities
import { initializeCapacitorBridge } from "./bridge/capacitor-bridge.js";
import { initializeStorageBridge } from "./bridge/storage-bridge.js";

/**
 * Platform detection utilities
 */
const platform = Capacitor.getPlatform();
const isNative = Capacitor.isNativePlatform();
const isIOS = platform === "ios";
const isAndroid = platform === "android";
const isElectron = platform === "electron";
const isWeb = platform === "web";

/**
 * Initialize platform-specific features
 */
async function initializePlatform(): Promise<void> {
  // Initialize storage bridge (replaces localStorage with Preferences on native)
  await initializeStorageBridge();

  // Initialize the Capacitor bridge for native plugin access
  initializeCapacitorBridge();

  if (isNative) {
    // Configure status bar for native platforms
    await initializeStatusBar();

    // Configure keyboard behavior
    await initializeKeyboard();

    // Handle app lifecycle events
    initializeAppLifecycle();
  }

  if (isElectron) {
    // Electron-specific initialization
    await initializeElectron();
  }

  // Log platform info
  console.log(`[Milaidy] Platform: ${platform}, Native: ${isNative}`);
}

/**
 * Configure the native status bar
 */
async function initializeStatusBar(): Promise<void> {
  // Set dark style for dark theme
  await StatusBar.setStyle({ style: Style.Dark });

  if (isAndroid) {
    // Make status bar overlay content on Android
    await StatusBar.setOverlaysWebView({ overlay: true });
    await StatusBar.setBackgroundColor({ color: "#0a0a0a" });
  }
}

/**
 * Configure keyboard behavior on native platforms
 */
async function initializeKeyboard(): Promise<void> {
  if (isIOS) {
    // Disable auto-scroll on iOS when keyboard appears
    await Keyboard.setScroll({ isDisabled: true });

    // Set keyboard accessory bar visibility
    await Keyboard.setAccessoryBarVisible({ isVisible: true });
  }

  // Listen for keyboard events
  Keyboard.addListener("keyboardWillShow", (info) => {
    document.body.style.setProperty("--keyboard-height", `${info.keyboardHeight}px`);
    document.body.classList.add("keyboard-open");
  });

  Keyboard.addListener("keyboardWillHide", () => {
    document.body.style.setProperty("--keyboard-height", "0px");
    document.body.classList.remove("keyboard-open");
  });
}

/**
 * Handle app lifecycle events (pause, resume, back button)
 */
function initializeAppLifecycle(): void {
  // Handle app state changes
  CapacitorApp.addListener("appStateChange", ({ isActive }) => {
    if (isActive) {
      // App came to foreground - refresh data if needed
      document.dispatchEvent(new CustomEvent("milaidy:app-resume"));
    } else {
      // App went to background
      document.dispatchEvent(new CustomEvent("milaidy:app-pause"));
    }
  });

  // Handle Android back button
  CapacitorApp.addListener("backButton", ({ canGoBack }) => {
    if (canGoBack) {
      window.history.back();
    } else {
      // Optionally minimize app or show exit confirmation
      // For now, we'll just let the default behavior happen
    }
  });

  // Handle deep links
  CapacitorApp.addListener("appUrlOpen", ({ url }) => {
    handleDeepLink(url);
  });

  // Check if app was opened via deep link
  CapacitorApp.getLaunchUrl().then((result) => {
    if (result?.url) {
      handleDeepLink(result.url);
    }
  });
}

/**
 * Handle deep links (milaidy:// URLs)
 */
function handleDeepLink(url: string): void {
  const parsed = new URL(url);

  // Handle different deep link paths
  if (parsed.protocol === "milaidy:") {
    const path = parsed.pathname || parsed.host;

    switch (path) {
      case "chat":
        // Navigate to chat view
        window.location.hash = "#chat";
        break;
      case "settings":
        // Navigate to settings
        window.location.hash = "#settings";
        break;
      case "connect":
        // Handle gateway connection URL
        const gatewayUrl = parsed.searchParams.get("url");
        if (gatewayUrl) {
          document.dispatchEvent(
            new CustomEvent("milaidy:connect", {
              detail: { gatewayUrl },
            })
          );
        }
        break;
      default:
        console.log(`[Milaidy] Unknown deep link path: ${path}`);
    }
  }
}

/**
 * Initialize Electron-specific features
 */
async function initializeElectron(): Promise<void> {
  // Electron-specific initialization will be added when we set up the electron platform
  // This includes:
  // - System tray integration
  // - Global shortcuts
  // - Native menus
  // - Window management

  // For now, just mark that we're in Electron mode
  document.body.classList.add("electron");
}

/**
 * Set up CSS custom properties for platform-specific styling
 */
function setupPlatformStyles(): void {
  const root = document.documentElement;

  // Set platform class on body for CSS targeting
  document.body.classList.add(`platform-${platform}`);

  if (isNative) {
    document.body.classList.add("native");
  }

  // Set safe area insets as CSS variables (fallback values)
  root.style.setProperty("--safe-area-top", "env(safe-area-inset-top, 0px)");
  root.style.setProperty("--safe-area-bmilaidym", "env(safe-area-inset-bmilaidym, 0px)");
  root.style.setProperty("--safe-area-left", "env(safe-area-inset-left, 0px)");
  root.style.setProperty("--safe-area-right", "env(safe-area-inset-right, 0px)");

  // Initialize keyboard height variable
  root.style.setProperty("--keyboard-height", "0px");
}

/**
 * Main initialization
 */
async function main(): Promise<void> {
  // Set up platform-specific styles first
  setupPlatformStyles();

  // Initialize platform features
  await initializePlatform();

  // The <milaidy-app> custom element is automatically registered
  // when we import the app.js module above
}

// Run initialization when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}

// Export platform utilities for use by other modules
export { platform, isNative, isIOS, isAndroid, isElectron, isWeb };
