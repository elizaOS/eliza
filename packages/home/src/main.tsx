/**
 * Eliza Home App Entry Point
 *
 * This file initializes the Capacitor runtime, sets up platform-specific
 * features, and mounts the React application.
 *
 * Unlike the full Eliza app, Eliza Home is chat-only — no companion mode,
 * no VRM avatars, no 3D rendering.
 */

import "@elizaos/app-core/styles/styles.css";

import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { StatusBar, Style } from "@capacitor/status-bar";
import { App } from "@elizaos/app-core";
import {
  initializeCapacitorBridge,
  initializeStorageBridge,
  isElectrobunRuntime,
} from "@elizaos/app-core/bridge";
import {
  AGENT_READY_EVENT,
  APP_PAUSE_EVENT,
  APP_RESUME_EVENT,
  COMMAND_PALETTE_EVENT,
  CONNECT_EVENT,
  dispatchElizaEvent,
  SHARE_TARGET_EVENT,
  TRAY_ACTION_EVENT,
} from "@elizaos/app-core/events";
import { applyLaunchConnectionFromUrl } from "@elizaos/app-core/platform";
import { AppProvider } from "@elizaos/app-core/state";
import { Agent } from "@elizaos/capacitor-agent";
import { Desktop } from "@elizaos/capacitor-desktop";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

/**
 * Platform detection utilities
 */
const platform = Capacitor.getPlatform();
const isNative = Capacitor.isNativePlatform();
const isIOS = platform === "ios";
const isAndroid = platform === "android";

function isElectronPlatform(): boolean {
  return platform === "electron" || isElectrobunRuntime();
}

function isWebPlatform(): boolean {
  return platform === "web" && !isElectrobunRuntime();
}

const isVitest =
  Boolean((import.meta as ImportMeta & { vitest?: unknown }).vitest) ||
  (typeof process !== "undefined" && process.env?.VITEST === "true");

interface ShareTargetFile {
  name: string;
  path?: string;
}

interface ShareTargetPayload {
  source?: string;
  title?: string;
  text?: string;
  url?: string;
  files?: ShareTargetFile[];
}

declare global {
  interface Window {
    __ELIZA_SHARE_QUEUE__?: ShareTargetPayload[];
  }
}

function dispatchShareTarget(payload: ShareTargetPayload): void {
  if (!window.__ELIZA_SHARE_QUEUE__) {
    window.__ELIZA_SHARE_QUEUE__ = [];
  }
  window.__ELIZA_SHARE_QUEUE__.push(payload);
  dispatchElizaEvent(SHARE_TARGET_EVENT, payload);
}

/**
 * Initialize the agent plugin.
 */
async function initializeAgent(): Promise<void> {
  try {
    const status = await Agent.getStatus();
    console.log(
      `[Eliza] Agent status: ${status.state}`,
      status.agentName ?? "",
    );
    dispatchElizaEvent(AGENT_READY_EVENT, status);
  } catch (err) {
    console.warn(
      "[Eliza] Agent not available:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Initialize platform-specific features
 */
async function initializePlatform(): Promise<void> {
  await initializeStorageBridge();
  initializeCapacitorBridge();

  if (isIOS || isAndroid) {
    await initializeStatusBar();
    await initializeKeyboard();
    initializeAppLifecycle();
  }

  if (isElectronPlatform()) {
    await initializeElectron();
  } else {
    await initializeAgent();
  }
}

/**
 * Configure the native status bar
 */
async function initializeStatusBar(): Promise<void> {
  await StatusBar.setStyle({ style: Style.Dark });

  if (isAndroid) {
    await StatusBar.setOverlaysWebView({ overlay: true });
    await StatusBar.setBackgroundColor({ color: "#0a0a0a" });
  }
}

/**
 * Configure keyboard behavior on native platforms
 */
async function initializeKeyboard(): Promise<void> {
  if (isIOS) {
    await Keyboard.setAccessoryBarVisible({ isVisible: true });
  }

  Keyboard.addListener("keyboardWillShow", (info) => {
    document.body.style.setProperty(
      "--keyboard-height",
      `${info.keyboardHeight}px`,
    );
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
  CapacitorApp.addListener("appStateChange", ({ isActive }) => {
    if (isActive) {
      dispatchElizaEvent(APP_RESUME_EVENT);
    } else {
      dispatchElizaEvent(APP_PAUSE_EVENT);
    }
  });

  CapacitorApp.addListener("backButton", ({ canGoBack }) => {
    if (canGoBack) {
      window.history.back();
    }
  });

  CapacitorApp.addListener("appUrlOpen", ({ url }) => {
    handleDeepLink(url);
  });

  CapacitorApp.getLaunchUrl().then((result) => {
    if (result?.url) {
      handleDeepLink(result.url);
    }
  });
}

/**
 * Handle deep links (eliza:// URLs)
 */
function handleDeepLink(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }

  if (parsed.protocol === "eliza:") {
    const path = (parsed.pathname || parsed.host || "").replace(/^\/+/, "");

    switch (path) {
      case "chat":
        window.location.hash = "#chat";
        break;
      case "settings":
        window.location.hash = "#settings";
        break;
      case "connect": {
        const gatewayUrl = parsed.searchParams.get("url");
        if (gatewayUrl) {
          try {
            const validatedUrl = new URL(gatewayUrl);
            if (
              validatedUrl.protocol !== "https:" &&
              validatedUrl.protocol !== "http:"
            ) {
              console.error(
                "[Eliza] Invalid gateway URL protocol:",
                validatedUrl.protocol,
              );
              break;
            }
            dispatchElizaEvent(CONNECT_EVENT, {
              gatewayUrl: validatedUrl.href,
            });
          } catch {
            console.error("[Eliza] Invalid gateway URL format");
          }
        }
        break;
      }
      case "share": {
        const title = parsed.searchParams.get("title")?.trim() || undefined;
        const text = parsed.searchParams.get("text")?.trim() || undefined;
        const sharedUrl = parsed.searchParams.get("url")?.trim() || undefined;
        const files = parsed.searchParams
          .getAll("file")
          .map((filePath) => filePath.trim())
          .filter((filePath) => filePath.length > 0)
          .map((filePath) => {
            const slash = Math.max(
              filePath.lastIndexOf("/"),
              filePath.lastIndexOf("\\"),
            );
            const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
            return { name, path: filePath };
          });

        dispatchShareTarget({
          source: "deep-link",
          title,
          text,
          url: sharedUrl,
          files,
        });
        break;
      }
      default:
        console.log(`[Eliza] Unknown deep link path: ${path}`);
    }
  }
}

/**
 * Initialize Electron-specific features
 */
async function initializeElectron(): Promise<void> {
  document.body.classList.add("electron");

  try {
    const version = await Desktop.getVersion();
    const desktopNativeReady =
      typeof version.electron === "string" &&
      version.electron !== "N/A" &&
      version.electron !== "unknown";
    if (!desktopNativeReady) {
      return;
    }

    await Desktop.registerShortcut({
      id: "command-palette",
      accelerator: "CommandOrControl+K",
    });

    await Desktop.addListener("shortcutPressed", (event: { id: string }) => {
      if (event.id === "command-palette") {
        dispatchElizaEvent(COMMAND_PALETTE_EVENT);
      }
    });

    await Desktop.setTrayMenu({
      menu: [
        { id: "tray-open-chat", label: "Open Chat" },
        { id: "tray-toggle-pause", label: "Pause/Resume Agent" },
        { id: "tray-restart", label: "Restart Agent" },
        { id: "tray-sep-1", type: "separator" },
        { id: "tray-show-window", label: "Show Window" },
        { id: "tray-hide-window", label: "Hide Window" },
      ],
    });

    await Desktop.addListener(
      "trayMenuClick",
      (event: { itemId: string; checked?: boolean }) => {
        dispatchElizaEvent(TRAY_ACTION_EVENT, event);
      },
    );
  } catch {}
}

/**
 * Set up CSS custom properties for platform-specific styling
 */
function setupPlatformStyles(): void {
  const root = document.documentElement;

  document.body.classList.add(`platform-${platform}`);

  if (isNative) {
    document.body.classList.add("native");
  }

  root.style.setProperty("--safe-area-top", "env(safe-area-inset-top, 0px)");
  root.style.setProperty(
    "--safe-area-bottom",
    "env(safe-area-inset-bottom, 0px)",
  );
  root.style.setProperty("--safe-area-left", "env(safe-area-inset-left, 0px)");
  root.style.setProperty(
    "--safe-area-right",
    "env(safe-area-inset-right, 0px)",
  );

  root.style.setProperty("--keyboard-height", "0px");
}

/**
 * Mount the React application into the DOM
 */
function mountReactApp(): void {
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("Root element #root not found");

  createRoot(rootEl).render(
    <StrictMode>
      <AppProvider>
        <App />
      </AppProvider>
    </StrictMode>,
  );
}

/** Detect popout mode from URL params. */
function isPopoutWindow(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(
    window.location.search || window.location.hash.split("?")[1] || "",
  );
  return params.has("popout");
}

/**
 * In popout mode, inject the API base from the URL query string so the
 * client can connect without the Electron main-process injection.
 */
function injectPopoutApiBase(): void {
  const params = new URLSearchParams(
    window.location.search || window.location.hash.split("?")[1] || "",
  );
  const apiBase = params.get("apiBase");
  if (apiBase) {
    try {
      const parsed = new URL(apiBase);
      const host = parsed.hostname;
      const allowPrivateHttp =
        /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
        /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
        /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host) ||
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(
          host,
        ) ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        host.endsWith(".ts.net");
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host === window.location.hostname ||
        parsed.protocol === "https:" ||
        (parsed.protocol === "http:" && allowPrivateHttp)
      ) {
        window.__ELIZA_API_BASE__ = apiBase;
      } else {
        console.warn("[Eliza] Rejected non-local apiBase:", host);
      }
    } catch {
      if (apiBase.startsWith("/") && !apiBase.startsWith("//")) {
        window.__ELIZA_API_BASE__ = apiBase;
      } else {
        console.warn("[Eliza] Rejected invalid relative apiBase:", apiBase);
      }
    }
  }
}

/**
 * Main initialization
 */
async function main(): Promise<void> {
  setupPlatformStyles();

  try {
    await applyLaunchConnectionFromUrl();
  } catch (err) {
    console.error(
      "[Eliza] Failed to apply managed cloud launch session:",
      err instanceof Error ? err.message : err,
    );
  }

  if (isPopoutWindow()) {
    injectPopoutApiBase();
    mountReactApp();
    return;
  }

  mountReactApp();
  await initializePlatform();
}

if (!isVitest) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    void main();
  }
}

export {
  dispatchShareTarget,
  handleDeepLink,
  injectPopoutApiBase,
  isAndroid,
  isElectronPlatform as isElectron,
  isIOS,
  isNative,
  isPopoutWindow,
  isWebPlatform as isWeb,
  platform,
  setupPlatformStyles,
};
