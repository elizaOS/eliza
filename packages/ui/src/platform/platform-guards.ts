/**
 * Client-side platform guards for dynamic view loading.
 *
 * iOS App Store and Google Play builds prohibit apps from downloading and
 * executing JavaScript not bundled with the binary at submission time.
 * These utilities detect that restriction so the UI can gate dynamic bundle
 * imports and surface appropriate fallback messaging.
 */

import { Capacitor } from "@capacitor/core";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";

declare global {
  interface Window {
    /** Set by the XR view-host (plugin-facewear / plugin-xr) inside a headset. */
    __elizaXRContext?: unknown;
  }
}

/** Frontend platform identifier matching the server-side AgentPlatform type. */
export type FrontendPlatform = "ios" | "android" | "web" | "desktop";

/**
 * Detect the current frontend platform.
 *
 * Resolution order:
 * 1. Electrobun desktop shell — via `isElectrobunRuntime()` (the renderer's
 *    `__electrobunWindowId`/`__electrobunWebviewId` + RPC bridge, the same
 *    signal platform/init.ts uses). The legacy `window.__ELECTROBUN__` flag
 *    this used to read is set NOWHERE in the shell, so desktop was silently
 *    mis-reported as "web" (wrong frontendPlatform to the server + wrong
 *    provider / runtime-class / available-views gating on desktop).
 * 2. Capacitor.getPlatform() — set by the Capacitor runtime on iOS/Android.
 * 3. Default: "web".
 */
export function getFrontendPlatform(): FrontendPlatform {
  if (isElectrobunRuntime()) {
    return "desktop";
  }
  const getPlatform = (Capacitor as { getPlatform?: () => unknown })
    .getPlatform;
  const p = typeof getPlatform === "function" ? getPlatform() : "web";
  if (p === "ios") return "ios";
  if (p === "android") return "android";
  return "web";
}

/**
 * Returns true when the current platform permits dynamic remote JS loading.
 *
 * iOS App Store and Google Play builds cannot load remote JS at runtime.
 * Desktop (Electrobun) and web contexts have no such restriction.
 */
export function isDynamicViewLoadingAllowed(): boolean {
  const platform = getFrontendPlatform();
  return platform !== "ios" && platform !== "android";
}

/**
 * True when the app runs as a PLAIN mobile web page: the `web` platform (no
 * Capacitor native bridge, no Electrobun shell) on a touch-first device.
 *
 * Mobile browsers — iOS Safari above all — refuse `window.open` once the
 * user-gesture context is lost across an `await`, and block featured/named
 * popups outright, so any login flow that pops a window there dead-ends on a
 * "allow pop-ups" error the user cannot reasonably act on. Flows that would
 * pop a window on desktop must branch on this guard and navigate the CURRENT
 * tab instead (#15143).
 *
 * Touch-first = coarse primary pointer (`(pointer: coarse)` also catches
 * iPadOS Safari, whose UA masquerades as macOS), with a mobile-UA fallback
 * for engines that misreport pointer capabilities.
 */
export function isMobileWebBrowser(): boolean {
  if (getFrontendPlatform() !== "web") return false;
  if (typeof window === "undefined") return false;
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  ) {
    return true;
  }
  const ua =
    typeof navigator !== "undefined" ? (navigator.userAgent ?? "") : "";
  return /android|iphone|ipad|ipod|mobile/i.test(ua);
}

/** Presentation modality of the surface the dashboard renders inside. */
export type ViewModality = "gui" | "tui" | "xr";

/**
 * Detect the active view modality of the current surface.
 *
 * The dashboard shell is a GUI surface on every device platform (web, desktop,
 * iOS, Android). The WebXR view host (`@elizaos/plugin-facewear`) sets the
 * `window.__elizaXRContext` global when a view runs inside a headset, so its
 * presence means the surface is XR. The terminal renderer is a separate,
 * non-DOM host, so the React shell never reports `tui`.
 */
export function getActiveViewModality(): ViewModality {
  if (typeof window !== "undefined" && window.__elizaXRContext) {
    return "xr";
  }
  return "gui";
}
