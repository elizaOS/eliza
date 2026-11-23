// spec/os/android/networkPolicy.md, "Story: Download a large file only on a link I do not pay for"
/**
 * Type definitions for the network cost bridge of @elizaos/os
 * (`@elizaos/os/bridges/definitions/network-policy`).
 *
 * The native side is implemented in Kotlin under
 * android/network-policy/src/main/java/ai/eliza/plugins/networkpolicy/NetworkPolicyPlugin.kt
 * and is registered with Capacitor as `ElizaNetworkPolicy`, or under the host's
 * own name where the host subclasses it. There is no web implementation: the
 * client in `../network-policy.vibe` answers unknown wherever Android did not.
 */

/** Android's metered flag for the active network. */
export interface MeteredHint {
  /** `true` when the active network is metered, `false` when not, `null` when Android did not answer. */
  metered: boolean | null;
  /** Always `"android-os"` from this bridge. */
  source: "android-os";
}

/** iOS path cost hints; Android answers none. */
export interface PathHints {
  /** `NWPath.isExpensive`; always `null` on Android. */
  isExpensive: boolean | null;
  /** `NWPath.isConstrained` (Low Data Mode); always `null` on Android. */
  isConstrained: boolean | null;
  /** Always `"nw-path-monitor"`. */
  source: "nw-path-monitor";
}

/** The native `ElizaNetworkPolicy` plugin. */
export interface NetworkPolicyPlugin {
  /** Android's metered flag for the active network. */
  getMeteredHint(): Promise<MeteredHint>;
  /** iOS cost hints; unknown on Android. */
  getPathHints(): Promise<PathHints>;
}
