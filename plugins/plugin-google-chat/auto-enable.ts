// Auto-enable check for @elizaos/plugin-google-chat.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/core";

/** Enable when a `googlechat` connector block is present and not explicitly disabled. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const c = (ctx.config.connectors as Record<string, unknown> | undefined)
    ?.googlechat;
  if (!c || typeof c !== "object") return false;
  const config = c as Record<string, unknown>;
  if (config.enabled === false) return false;
  // The full per-connector field check (service account credentials / project)
  // lives in the central engine's isConnectorConfigured; this module gates only
  // on "block present + not explicitly disabled".
  return true;
}
