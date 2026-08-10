/**
 * Resolves the Browser view's platform-neutral session presentation into the
 * concrete surface rendered by the current host. Installed apps use native
 * child webviews; web and cloud hosts consume a same-origin remote-browser
 * stream or an explicit snapshot, never arbitrary third-party iframes.
 */

import type { SurfaceIsolationLevel } from "@elizaos/core";
import type {
  BrowserWorkspaceMode,
  BrowserWorkspacePresentation,
} from "./api/browser-contracts";

export type BrowserTabRenderPath =
  | "native-child-webview"
  | "native-mobile-webview"
  | "remote-browser-stream"
  | "server-snapshot"
  | "unavailable";

/** Select the host renderer while preserving the declared isolation boundary. */
export function resolveBrowserTabRenderPath(input: {
  isolation: SurfaceIsolationLevel;
  mode: BrowserWorkspaceMode;
  nativeMobileShell: boolean;
  presentation?: BrowserWorkspacePresentation;
}): BrowserTabRenderPath {
  const { isolation, mode, nativeMobileShell, presentation } = input;
  const wantsNative = isolation === "native-webview";

  if (mode === "desktop" && wantsNative) return "native-child-webview";
  if (nativeMobileShell && wantsNative) return "native-mobile-webview";
  if (presentation === "remote-stream") return "remote-browser-stream";
  if (presentation === "snapshot" || mode === "cloud") {
    return "server-snapshot";
  }
  return "unavailable";
}
