// Auto-enable check for @elizaos/plugin-codex-cli.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: config reads
// only, no service init, no transitive imports of the full plugin runtime.
// The auto-enable engine loads dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/shared";

/**
 * Enable when any auth profile in the user's config selects the codex-cli
 * provider. The plugin authenticates via OAuth tokens from `~/.codex/auth.json`,
 * not an env var, so config presence is the right signal.
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const profiles = (ctx.config?.auth as Record<string, unknown> | undefined)
    ?.profiles;
  if (!profiles || typeof profiles !== "object") return false;
  return Object.values(profiles as Record<string, unknown>).some((p) => {
    if (!p || typeof p !== "object") return false;
    return (p as Record<string, unknown>).provider === "codex-cli";
  });
}
