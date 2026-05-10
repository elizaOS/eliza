// Auto-enable check for @elizaos/plugin-whatsapp.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/core";

/** Enable when a `whatsapp` connector block is present and not explicitly disabled. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const c = (ctx.config?.connectors as Record<string, unknown> | undefined)
    ?.whatsapp;
  if (!c || typeof c !== "object") return false;
  const config = c as Record<string, unknown>;
  if (config.enabled === false) return false;
  // The full per-connector field check (token/phoneNumberId) lives in the
  // central engine's isConnectorConfigured. We delegate to a simple "block
  // present + not explicitly disabled" check here; the central engine's
  // stricter check remains as a fallback during migration.
  return true;
}
