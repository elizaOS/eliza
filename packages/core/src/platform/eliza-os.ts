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

/**
 * Shared AOSP renderer detection.
 *
 * The Android framework appends the framework marker `ElizaOS/<tag>` only on
 * Eliza-derived AOSP system images. White-label builds may append additional
 * brand markers, but they still carry this base marker.
 */
export function userAgentHasElizaOSMarker(
	userAgent: string | null | undefined,
): boolean {
	if (typeof userAgent !== "string" || userAgent.length === 0) return false;
	return /\bElizaOS\/\S/.test(userAgent);
}

export const isAospElizaUserAgent = userAgentHasElizaOSMarker;
