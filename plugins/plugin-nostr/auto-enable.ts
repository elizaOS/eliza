/**
 * Auto-enable predicate for @elizaos/plugin-nostr, referenced by package.json's
 * `elizaos.plugin.autoEnableModule`. Kept light — env reads only, no service
 * init, no transitive imports of the full plugin runtime — because the
 * auto-enable engine loads dozens of these per boot.
 */
import type { PluginAutoEnableContext } from "@elizaos/core";

/** Enable when a `nostr` connector block is present and not explicitly disabled. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const c = (ctx.config.connectors as Record<string, unknown> | undefined)?.nostr;
  if (!c || typeof c !== "object") return false;
  const config = c as Record<string, unknown>;
  if (config.enabled === false) return false;
  // The full per-connector field check (private key / relays) lives in the
  // central engine's isConnectorConfigured; this module only asserts the block
  // is present and not explicitly disabled.
  return true;
}
