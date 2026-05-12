/** Platform detection and initialization utilities. */

import { Capacitor } from "@capacitor/core";
import { isElectrobunRuntime } from "../bridge";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import { userAgentHasElizaOSMarker } from "./aosp-user-agent";

export { userAgentHasElizaOSMarker } from "./aosp-user-agent";

// ── Platform detection ──────────────────────────────────────────────

function detectPlatform(): { platform: string; isNative: boolean } {
  try {
    return {
      platform: Capacitor.getPlatform(),
      isNative: Capacitor.isNativePlatform(),
    };
  } catch {
    /* fallback */
  }
  return { platform: "web", isNative: false };
}

const detected = detectPlatform();

export const platform = isElectrobunRuntime()
  ? "electrobun"
  : detected.platform;
export const isNative = detected.isNative;
export const isIOS = platform === "ios";
export const isAndroid = platform === "android";

export function isDesktopPlatform(): boolean {
  return platform === "electrobun";
}

/**
 * True when the APK is running on the AOSP ElizaOS variant (the system
 * app on a Eliza-branded device), as opposed to the same APK installed
 * on a stock Android phone from Play Store.
 *
 * Detection: `MainActivity.applyElizaOSUserAgentSuffix` appends
 * `ElizaOS/<tag>` to the WebView user-agent when `ro.elizaos.product`
 * is set by the AOSP product makefile (vendor/eliza/eliza_common.mk).
 * Stock Android leaves the user-agent untouched.
 *
 * Used by `RuntimeGate` and the Android boot pre-seed to decide whether
 * the "Choose your setup" picker is bypassed (ElizaOS — the device IS
 * the agent) or rendered (vanilla APK — the user picks Cloud / Remote /
 * Local).
 */
export function isElizaOS(): boolean {
  if (!isAndroid) return false;
  if (typeof navigator === "undefined") return false;
  return userAgentHasElizaOSMarker(navigator.userAgent ?? "");
}

/** True when the runtime can spin up a local agent — desktop or dev server. */
export function canRunLocal(): boolean {
  return isDesktopPlatform() || Boolean(import.meta.env.DEV);
}

/**
 * True when the platform might host a local agent that the UI can reach over
 * the app. Used to decide whether the RuntimeGate's "Local Agent" tile
 * should run a liveness probe before being shown. Desktop and dev mode
 * always qualify; Android qualifies because `ElizaAgentService` starts the
 * bundled agent on `127.0.0.1:31337`; iOS qualifies because app-core handles
 * the same route shape through an in-process ITTP transport.
 */
export function canHostLocalAgent(): boolean {
  return canRunLocal() || isAndroid || isIOS;
}

export function isWebPlatform(): boolean {
  return detected.platform === "web" && !isElectrobunRuntime();
}

// ── Share target ────────────────────────────────────────────────────

export interface ShareTargetFile {
  name: string;
  path?: string;
}

export interface ShareTargetPayload {
  source?: string;
  title?: string;
  text?: string;
  url?: string;
  files?: ShareTargetFile[];
}

declare global {
  interface Window {
    __ELIZAOS_SHARE_QUEUE__?: ShareTargetPayload[];
  }
}

export function dispatchShareTarget(
  payload: ShareTargetPayload,
  dispatchEvent: (name: string, detail: unknown) => void,
  eventName: string,
): void {
  if (!window.__ELIZAOS_SHARE_QUEUE__) {
    window.__ELIZAOS_SHARE_QUEUE__ = [];
  }
  window.__ELIZAOS_SHARE_QUEUE__.push(payload);
  dispatchEvent(eventName, payload);
}

// ── Deep link handling ──────────────────────────────────────────────

export interface DeepLinkHandlers {
  onChat?: () => void;
  onSettings?: () => void;
  onConnect?: (gatewayUrl: string) => void;
  onShare?: (payload: ShareTargetPayload) => void;
  onUnknown?: (path: string) => void;
}

export function handleDeepLink(
  url: string,
  protocol: string,
  handlers: DeepLinkHandlers,
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }

  if (parsed.protocol !== `${protocol}:`) return;

  const path = (parsed.pathname || parsed.host || "").replace(/^\/+/, "");

  switch (path) {
    case "chat":
      handlers.onChat?.();
      break;
    case "settings":
      handlers.onSettings?.();
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
              `[${protocol}] Invalid gateway URL protocol:`,
              validatedUrl.protocol,
            );
            break;
          }
          handlers.onConnect?.(validatedUrl.href);
        } catch {
          console.error(`[${protocol}] Invalid gateway URL format`);
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

      handlers.onShare?.({
        source: "deep-link",
        title,
        text,
        url: sharedUrl,
        files,
      });
      break;
    }
    default:
      handlers.onUnknown?.(path);
  }
}

// ── Platform CSS setup ──────────────────────────────────────────────

export function setupPlatformStyles(): void {
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

// ── Popout helpers ──────────────────────────────────────────────────

export function isPopoutWindow(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(
    window.location.search || window.location.hash.split("?")[1] || "",
  );
  return params.has("popout");
}

export function injectPopoutApiBase(): void {
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
        setBootConfig({ ...getBootConfig(), apiBase });
      } else {
        console.warn("[app-core] Rejected non-local apiBase:", host);
      }
    } catch {
      if (apiBase.startsWith("/") && !apiBase.startsWith("//")) {
        setBootConfig({ ...getBootConfig(), apiBase });
      } else {
        console.warn("[app-core] Rejected invalid relative apiBase:", apiBase);
      }
    }
  }
}
