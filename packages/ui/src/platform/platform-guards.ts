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

/** Frontend platform identifier matching the server-side AgentPlatform type. */
export type FrontendPlatform = "ios" | "android" | "web" | "desktop";

/**
 * Detect the current frontend platform.
 *
 * Resolution order:
 * 1. Electrobun desktop shell — via `isElectrobunRuntime()` (the renderer's
 *    `__electrobunWindowId`/`__electrobunWebviewId` + RPC bridge, the same
 *    signal platform/init.ts uses).
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

/** Presentation modality of the surface the dashboard renders inside. */
export type ViewModality = "gui" | "tui" | "xr";

/**
 * Detect the active view modality of the current surface.
 *
 * The shipped dashboard shell is a GUI surface on every device platform. The
 * retained union leaves room for future hosts to report other modalities
 * through their own adapters.
 */
export function getActiveViewModality(): ViewModality {
  return "gui";
}
