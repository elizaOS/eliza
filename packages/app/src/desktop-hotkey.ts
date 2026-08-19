/**
 * Pure decision for the global chat-overlay summon hotkey (#10716 / #12184).
 *
 * The hotkey toggles the floating chat surface (which, on desktop, is the main
 * window / bottom-bar pill): pressing it while the window is already focused +
 * visible dismisses it (returning focus to the previously active app via the
 * macOS orderOut path); otherwise it summons + focuses it. Kept pure so the
 * toggle logic is unit-testable without the Electrobun bridge.
 */

export interface DesktopWindowState {
  focused: boolean;
  visible: boolean;
}

export type ChatOverlayToggleAction = "show" | "hide";

export type DesktopHostPlatform = "darwin" | "linux" | "win32" | "unknown";

/** Normalize the renderer's browser-platform string into the native host OS. */
export function resolveDesktopHostPlatform(
  navigatorPlatform: string,
): DesktopHostPlatform {
  if (/Mac/i.test(navigatorPlatform)) return "darwin";
  if (/Win/i.test(navigatorPlatform)) return "win32";
  if (/Linux/i.test(navigatorPlatform)) return "linux";
  return "unknown";
}

/**
 * Only the macOS detached pill is explicit-control-only. Linux kiosk and
 * Windows/Linux overlay windows retain the established ambient PTT contract.
 */
export function shouldEnableDesktopPushToTalk(
  chatOverlayShell: boolean,
  hostPlatform: DesktopHostPlatform,
): boolean {
  return !(chatOverlayShell && hostPlatform === "darwin");
}

/**
 * Decide whether a hotkey press should summon or dismiss the chat overlay.
 * Only a window that is BOTH focused and visible is dismissed; anything else
 * (hidden, or visible-but-backgrounded behind another app) is summoned +
 * focused so the chord always brings the overlay forward first.
 */
export function decideChatOverlayToggle(
  state: DesktopWindowState,
): ChatOverlayToggleAction {
  return state.focused && state.visible ? "hide" : "show";
}
