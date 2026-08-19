/** Defines which typed detached desktop host restricts the pill to clicks. */

import type { AppBootConfig } from "../config/boot-config-store";

/**
 * The click-only pill is a macOS native-host policy, not a property of the
 * `?shellMode=chat-overlay` route itself. The route is also supported in plain
 * browsers and on Windows/Linux, where push-to-talk gestures remain available.
 */
export function shouldUseClickOnlyChatOverlayPill(
  desktopHost: AppBootConfig["desktopHost"],
): boolean {
  return (
    desktopHost?.platform === "darwin" && desktopHost.surface === "bottom-bar"
  );
}
