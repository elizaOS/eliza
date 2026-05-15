/**
 * `@elizaos/capacitor-network-policy` — Android `metered` / iOS `isExpensive`
 * shims for the voice-model auto-updater network policy (R5-versioning §4).
 *
 * Registers as `ElizaNetworkPolicy` on the Capacitor bridge. The
 * platform-agnostic probes in `plugin-local-inference` read the bridge
 * via `globalThis.ElizaNetworkPolicy` so this module's only job is to
 * register and install the global.
 */

import { registerPlugin } from "@capacitor/core";

import type { NetworkPolicyPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.NetworkPolicyWeb());

export const NetworkPolicy = registerPlugin<NetworkPolicyPlugin>(
	"ElizaNetworkPolicy",
	{ web: loadWeb },
);

/**
 * Install `globalThis.ElizaNetworkPolicy` so the runtime probe in
 * `plugin-local-inference/src/services/network-policy.ts` can call into
 * the native bridge without compile-time Capacitor dependencies.
 *
 * Idempotent — re-installing replaces the existing handle with the same
 * `NetworkPolicy` instance.
 */
export function installNetworkPolicyGlobal(): void {
	(globalThis as unknown as { ElizaNetworkPolicy?: NetworkPolicyPlugin }).ElizaNetworkPolicy =
		NetworkPolicy;
}

// Side-effect: install on import so callers that simply
// `import "@elizaos/capacitor-network-policy"` from the app bootstrap
// pick up the global without any extra wiring.
installNetworkPolicyGlobal();
