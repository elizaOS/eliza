/**
 * Auto-enable gate for the Signal connector, referenced by package.json's
 * `elizaos.plugin.autoEnableModule`. Kept light — env/config reads only, no
 * service init, no transitive imports of the full plugin runtime — because the
 * auto-enable engine loads dozens of these modules per boot.
 */
import type { PluginAutoEnableContext } from "@elizaos/core";

/** Enable when a `signal` connector block is present and not explicitly disabled. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const c = (ctx.config.connectors as Record<string, unknown> | undefined)?.signal;
  if (!c || typeof c !== "object") return false;
  const config = c as Record<string, unknown>;
  if (config.enabled === false) return false;
  // The full per-connector field check (signal-cli endpoint / phone number)
  // lives in the central engine's isConnectorConfigured. This module only
  // checks "block present + not explicitly disabled"; the central engine's
  // stricter check remains the authoritative gate.
  return true;
}
