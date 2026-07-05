/** Platform detection and initialization utilities. */

import { Capacitor } from "@capacitor/core";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
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

/**
 * True when the app is running as an INSTALLED PWA in standalone (or fullscreen)
 * display-mode — i.e. added to the home screen and launched chrome-less — while
 * the Capacitor platform is still `web` (this is NOT the native App Store /
 * Play Store build; that reports `ios`/`android` and takes the `native` path).
 *
 * This is the iOS-home-screen-PWA case specifically: `Capacitor.getPlatform()`
 * returns `web`, so the app never gets the `native`/`platform-ios` body class
 * and — critically — never gets the mobile touch-viewport lockdown in
 * `styles/base.css`. Without that lockdown the body stays at the default
 * `touch-action: auto`, so iOS WebKit routes the first frames of every drag
 * into its own body-pan / edge-nav pipeline and fires `pointercancel` — the
 * home-screen swipe-up (open chat) and horizontal rail flick both silently
 * never commit. Tagging the body with `pwa-standalone` lets base.css apply the
 * same lockdown to the installed PWA and hand drags to the app's gestures.
 *
 * Detection order: the standard `display-mode` media query (Chrome/Android +
 * modern iOS), then the legacy iOS-only `navigator.standalone` boolean.
 * Best-effort — any absence of `matchMedia`/`navigator` returns false.
 */
export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (typeof window.matchMedia === "function") {
      if (
        window.matchMedia("(display-mode: standalone)").matches ||
        window.matchMedia("(display-mode: fullscreen)").matches
      ) {
        return true;
      }
    }
  } catch {
    /* matchMedia unavailable — fall through to the legacy iOS signal */
  }
  // Legacy iOS Safari home-screen flag (pre-display-mode support).
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  return (nav as { standalone?: boolean } | undefined)?.standalone === true;
}

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
 * Used by the Android boot pre-seed to decide whether the device itself is
 * the agent.
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
 * True when the onboarding runtime selector should offer the **Local** card.
 *
 * Local is a first-class option on platforms that own their hardware: desktop
 * (Electrobun), the AOSP ElizaOS system build, and the dev server. Stock
 * mobile installs (iOS App Store / Play Store APK) and the web app cannot run
 * a bundled local agent, so they only see Cloud + Remote.
 */
export function canSelectLocalRuntime(): boolean {
  return canRunLocal() || isElizaOS();
}

/**
 * True when the platform might host a local agent that the UI can reach over
 * the app. Used to decide whether the local first-run option should run a
 * liveness probe before being shown. Desktop and dev mode
 * always qualify; Android qualifies because `ElizaAgentService` starts the
 * bundled loopback agent; iOS qualifies because the same route shape is
 * carried over in-process ITTP/Capacitor IPC, not a TCP listener.
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
    // error-policy:J3 malformed deep link (untrusted external input) is
    // ignored rather than routed.
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
            break;
          }
          handlers.onConnect?.(validatedUrl.href);
        } catch {
          // invalid gateway URL format — ignore
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

  // Installed PWA on the WEB platform (iOS home-screen app, chrome-less Android
  // PWA): apply the mobile touch-viewport lockdown that the Capacitor `native`
  // path gets, so the body claims `touch-action` and hands drags to the app's
  // home-screen gestures instead of iOS WebKit's page-pan/edge-nav (which
  // otherwise fires pointercancel and silently drops the swipe-up-open + rail
  // flick). Scoped to `platform === "web"`: the native App Store / Play Store
  // build already locks down via `native`, and desktop (electrobun) must keep
  // its window scroll/trackpad behavior.
  if (platform === "web" && isStandalonePwa()) {
    document.body.classList.add("pwa-standalone");
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
      }
    } catch {
      if (apiBase.startsWith("/") && !apiBase.startsWith("//")) {
        setBootConfig({ ...getBootConfig(), apiBase });
      }
    }
  }

  const waifuAccessToken = params.get("waifu_access_token")?.trim();
  if (waifuAccessToken) {
    setBootConfig({ ...getBootConfig(), apiToken: waifuAccessToken });
    window.history.replaceState(
      window.history.state,
      "",
      removeUrlParameter(window.location.href, "waifu_access_token"),
    );
  }
}

function removeUrlParameter(href: string, parameter: string): URL {
  const nextUrl = new URL(href);
  nextUrl.searchParams.delete(parameter);
  const hashQueryIndex = nextUrl.hash.indexOf("?");
  if (hashQueryIndex >= 0) {
    const hashPath = nextUrl.hash.slice(0, hashQueryIndex);
    const hashParams = new URLSearchParams(
      nextUrl.hash.slice(hashQueryIndex + 1),
    );
    hashParams.delete(parameter);
    const serializedHashParams = hashParams.toString();
    nextUrl.hash = serializedHashParams
      ? `${hashPath}?${serializedHashParams}`
      : hashPath;
  }
  return nextUrl;
}
