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
  /** `NWPath.isExpensive`; null when no authoritative path is available. */
  isExpensive: boolean | null;
  /**
   * `NWPath.isConstrained`: true for Low Data Mode, null when unavailable.
   * The updater treats true as metered because the user asked the OS to
   * limit non-essential traffic.
   */
  isConstrained: boolean | null;
  /** Source label for debugging — always `"nw-path-monitor"` from this plugin. */
  source: "nw-path-monitor";
}

export interface NetworkPolicyPlugin {
  /** Android cost hint; otherwise unknown, except browser Data Saver can restrict it. */
  getMeteredHint(): Promise<MeteredHint>;
  /** iOS cost hints; otherwise null, except browser Data Saver can supply true. */
  getPathHints(): Promise<PathHints>;
}
