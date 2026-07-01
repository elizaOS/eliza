// Auto-enable check for @elizaos/plugin-cli-inference.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: config/env reads
// only, no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/core";

/**
 * Enable ONLY when `ELIZA_CHAT_VIA_CLI` is set to `claude`, `claude-sdk`,
 * `codex`, or `codex-sdk`. This is the single env gate for the SAFE/CLOUD
 * inference route — unset means the plugin is never added to the resolved set, so
 * it cannot affect any existing running code path. Even if it were force-loaded,
 * its models map is empty unless the same env var is set, so the cheap configured
 * provider keeps serving every tier.
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const raw = ctx.env.ELIZA_CHAT_VIA_CLI?.trim().toLowerCase();
  return (
    raw === "claude" ||
    raw === "claude-sdk" ||
    raw === "codex" ||
    raw === "codex-sdk"
  );
}
