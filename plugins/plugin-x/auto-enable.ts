// Auto-enable check for @elizaos/plugin-x.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/core";

/** Enable when an `x` (or legacy `twitter`) connector block is present and not explicitly disabled. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const connectors = ctx.config?.connectors as
    | Record<string, unknown>
    | undefined;
  if (!connectors) return false;

  // Either `connectors.x` or the legacy `connectors.twitter` enables the plugin.
  for (const key of ["x", "twitter"] as const) {
    const c = connectors[key];
    if (!c || typeof c !== "object") continue;
    const config = c as Record<string, unknown>;
    if (config.enabled === false) continue;
    // The full per-connector field check (apiKey/apiSecret/accessToken) lives
    // in the central engine's isConnectorConfigured. We delegate to a simple
    // "block present + not explicitly disabled" check here; the central
    // engine's stricter check remains as a fallback during migration.
    return true;
  }

  return false;
}
