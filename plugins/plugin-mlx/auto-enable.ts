// Auto-enable check for @elizaos/plugin-mlx.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
//
// MLX (Apple's machine-learning framework) only runs on Apple Silicon, so the
// plugin gates itself behind `darwin-arm64`. On any other host the env-driven
// signal is ignored — there is no MLX server to talk to. A live reachability
// probe lives on the plugin's `autoEnable.shouldEnable` predicate so the
// auto-enable engine can stay synchronous here.

import type { PluginAutoEnableContext } from "@elizaos/core";

const ENV_KEYS = ["MLX_BASE_URL"] as const;

function isAppleSilicon(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  if (!isAppleSilicon()) {
    return false;
  }
  return ENV_KEYS.some((k) => {
    const v = ctx.env[k];
    return typeof v === "string" && v.trim() !== "";
  });
}
