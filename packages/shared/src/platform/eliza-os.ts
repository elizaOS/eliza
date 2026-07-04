/**
 * AOSP ElizaOS renderer detection. Pure user-agent matching plus a `navigator`
 * probe, React-free so Node/Bun-reachable update-policy code can ask "is this
 * device an ElizaOS system image?" without importing the renderer's platform
 * barrel (Capacitor + bridge modules). `@elizaos/ui/platform` re-exports these.
 *
 * The Android framework appends `ElizaOS/<tag>` to the WebView user-agent only
 * on Eliza-derived AOSP system images (see MainActivity user-agent suffix);
 * stock Android and non-Android platforms never carry it.
 */

export function userAgentHasElizaOSMarker(
  userAgent: string | null | undefined,
): boolean {
  if (typeof userAgent !== "string" || userAgent.length === 0) return false;
  return /\bElizaOS\/\S/.test(userAgent);
}

export const isAospElizaUserAgent = userAgentHasElizaOSMarker;

/**
 * True when the current runtime is an ElizaOS AOSP system image, detected via
 * the renderer's `navigator.userAgent`. In non-browser runtimes (Node/Bun API
 * process) there is no `navigator`, so this is `false`.
 */
export function isElizaOS(): boolean {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  if (!nav) return false;
  return userAgentHasElizaOSMarker(nav.userAgent ?? "");
}
