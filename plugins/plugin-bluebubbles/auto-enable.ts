/**
 * Auto-enable predicate for @elizaos/plugin-bluebubbles, referenced by
 * package.json's `elizaos.plugin.autoEnableModule`. Kept light — env/config
 * reads only, no service init, no transitive imports of the full plugin
 * runtime, because the auto-enable engine loads dozens of these per boot.
 */
import type { PluginAutoEnableContext } from "@elizaos/core";

/** Enable when a `bluebubbles` connector block is present and not explicitly disabled. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const c = (ctx.config?.connectors as Record<string, unknown> | undefined)
    ?.bluebubbles;
  if (!c || typeof c !== "object") return false;
  const config = c as Record<string, unknown>;
  if (config.enabled === false) return false;
  // The full per-connector field check (serverUrl + password) lives in the
  // central engine's isConnectorConfigured; this delegates to a simpler "block
  // present + not explicitly disabled" test, with that stricter check as a
  // fallback.
  return true;
}
