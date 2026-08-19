/** Defines which detached desktop host deliberately restricts the pill to clicks. */

/**
 * The click-only pill is a macOS native-host policy, not a property of the
 * `?shellMode=chat-overlay` route itself. The route is also supported in plain
 * browsers and on Windows/Linux, where push-to-talk gestures remain available.
 */
export function shouldUseClickOnlyChatOverlayPill(
  electrobunRuntime: boolean,
  navigatorPlatform: string,
): boolean {
  return electrobunRuntime && /Mac/i.test(navigatorPlatform);
}
