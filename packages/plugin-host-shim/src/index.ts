/**
 * @elizaos/plugin-host-shim
 *
 * The cross-platform shim contract that a remote-mode plugin's view JS
 * uses to talk to whichever environment it's mounted in (Electrobun
 * webview, iOS WKWebView, Android WebView, web iframe). Per-platform
 * packages provide the wire wiring; the contract is identical, so view
 * code is the same on all four.
 *
 * Author usage inside a view bundle:
 *
 * ```ts
 * import { getHostShim } from "@elizaos/plugin-host-shim";
 * const shim = getHostShim();
 * const ctx = await shim.request("provider.get", { name: "spotify" });
 * shim.on("plugin.event", (payload) => { /* ... *\/ });
 * ```
 *
 * The bundle MUST be served by the agent's view registry at
 * `/api/views/:id/bundle.js` (or the platform's equivalent
 * file/asset URL). The shim resolves the right URL via
 * `resolveViewUrl()` per platform.
 */

import type { JsonValue } from "@elizaos/plugin-remote-manifest";

/** Cross-platform contract every shim implements. */
export interface PluginHostShim {
  /**
   * Resolve a relative view asset to an absolute URL the platform can
   * load. Used to build `<script>` / `<link>` URLs for assets the view
   * needs.
   */
  resolveViewUrl(pluginName: string, relativePath: string): URL;

  /**
   * Issue a host-mediated request to the plugin's host. The host
   * routes it to the corresponding remote-mode plugin worker over the
   * standard wire envelope.
   *
   * Methods follow the `surface.target` convention from the wire
   * envelope:
   * - `provider.<name>` → invoke a provider's `get`
   * - `action.<name>`   → invoke an action's handler
   * - `event.<name>`    → emit an event into the runtime
   */
  request<T extends JsonValue = JsonValue>(
    method: string,
    params: JsonValue,
  ): Promise<T>;

  /**
   * Subscribe to host → view events. Returns an unsubscribe function.
   * The host emits these via the existing `event` envelope with the
   * matching event name.
   */
  on(event: string, handler: (data: JsonValue) => void): () => void;
}

/**
 * Module-level singleton slot. The platform shim registers itself once
 * the view bundle loads (via `installHostShim`); the view code reaches
 * for `getHostShim()`.
 */
let activeShim: PluginHostShim | null = null;

/** Install a shim. Called once by the platform package. */
export function installHostShim(shim: PluginHostShim): void {
  activeShim = shim;
}

/** Get the active shim. Throws if no platform has installed one. */
export function getHostShim(): PluginHostShim {
  if (!activeShim) {
    throw new Error(
      "PluginHostShim not installed. Did you import a platform package " +
        "(@elizaos/plugin-host-shim-electrobun / -ios / -android / -web)?",
    );
  }
  return activeShim;
}

/** Reset the shim. Used in tests; never in production. */
export function resetHostShim(): void {
  activeShim = null;
}
