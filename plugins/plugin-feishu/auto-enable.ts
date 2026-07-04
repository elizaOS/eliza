// Auto-enable check for @elizaos/plugin-feishu.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/core";

/** Enable when a `feishu` connector block is present and not explicitly disabled. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const c = (ctx.config?.connectors as Record<string, unknown> | undefined)
    ?.feishu;
  if (!c || typeof c !== "object") return false;
  const config = c as Record<string, unknown>;
  if (config.enabled === false) return false;
  // Full per-connector field validation (appId/appSecret) lives in the central
  // engine's isConnectorConfigured. Here we only check that the block is present
  // and not explicitly disabled; the engine applies the stricter check.
  return true;
}
