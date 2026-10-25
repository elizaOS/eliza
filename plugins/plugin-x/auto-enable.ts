/**
 * Auto-enable entry-point for the X connector, referenced by package.json's
 * `elizaos.plugin.autoEnableModule`. Kept deliberately light — env reads only,
 * no service init, no transitive imports of the full plugin runtime — because
 * the auto-enable engine loads dozens of these modules per boot.
 */
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
    // in the central engine's isConnectorConfigured; this module only decides
    // presence + not-explicitly-disabled and delegates the stricter check.
    return true;
  }

  return false;
}
