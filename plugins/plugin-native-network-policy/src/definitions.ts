/**
 * Type definitions for the `@elizaos/capacitor-network-policy` bridge.
 *
 * Backs the on-device portion of the voice-model auto-updater
 * network-policy decision (R5-versioning §4). Two methods:
 *
 *  - `getMeteredHint()` — Android. Wraps
 *    `ConnectivityManager.getNetworkCapabilities(activeNetwork).hasCapability(
 *    NetworkCapabilities.NET_CAPABILITY_NOT_METERED)`. Android docs warn
 *    explicitly that "cellular" is NOT a synonym for "metered" so the
 *    metered flag is mandatory.
 *  - `getPathHints()` — iOS. Wraps `NWPathMonitor.currentPath.isExpensive`
 *    and `.isConstrained`. `isExpensive == true` is Apple's "treat as
 *    metered" flag (cellular by default, plus tethered Wi-Fi from a
 *    cellular hotspot).
 *
 * The plugin populates `globalThis.ElizaNetworkPolicy` so the platform-
 * agnostic probes in `plugin-local-inference/src/services/network-policy.ts`
 * can read it without depending on Capacitor at compile time.
 */

export interface MeteredHint {
	/**
	 * `true` if Android reports `NET_CAPABILITY_NOT_METERED === false`
	 * (i.e. the link IS metered), `false` if not metered, `null` when the
	 * platform cannot report a definitive answer (no active network or
	 * permission denied).
	 */
	metered: boolean | null;
	/** Source label for debugging — always `"android-os"` from this plugin. */
	source: "android-os";
}

export interface PathHints {
	/** `NWPath.isExpensive` — true when the link is metered per Apple's policy. */
	isExpensive: boolean;
	/**
	 * `NWPath.isConstrained` — true when Low Data Mode is engaged. The voice-
	 * updater treats this as "metered" because the user has explicitly asked
	 * the OS to limit non-essential traffic.
	 */
	isConstrained: boolean;
	/** Source label for debugging — always `"nw-path-monitor"` from this plugin. */
	source: "nw-path-monitor";
}

export interface NetworkPolicyPlugin {
	/** Android-only. Returns `{ metered: null, source: "android-os" }` on iOS / web. */
	getMeteredHint(): Promise<MeteredHint>;
	/** iOS-only. Returns `{ isExpensive: false, isConstrained: false, source: "nw-path-monitor" }` on Android / web. */
	getPathHints(): Promise<PathHints>;
}
