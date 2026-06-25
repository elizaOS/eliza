// Auto-enable check for @elizaos/plugin-embeddings.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
//
// This plugin is a provider-agnostic ("bring your own") TEXT_EMBEDDING slot. It
// is purely additive: it activates ONLY when the operator opts in by setting
// `EMBEDDING_BASE_URL` or `EMBEDDING_API_KEY`. Without either, the plugin never
// loads, so existing deployments (which rely on their chat provider's embedding
// slot, or on local inference / Eliza Cloud) are unaffected.

import type { PluginAutoEnableContext } from "@elizaos/core";

const ENV_KEYS = ["EMBEDDING_BASE_URL", "EMBEDDING_API_KEY"] as const;

export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  return ENV_KEYS.some((k) => {
    const v = ctx.env[k];
    return typeof v === "string" && v.trim() !== "";
  });
}
