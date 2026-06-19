// Auto-enable check for @elizaos/plugin-lmstudio.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
//
// LM Studio activates when either:
//   1. The operator opted in explicitly via `LMSTUDIO_BASE_URL`, or
//   2. The default `http://localhost:1234/v1/models` endpoint is reachable —
//      handled at runtime by the plugin's `autoEnable.shouldEnable` predicate.
//      This manifest just registers the env signal; the live probe is the
//      plugin's responsibility so the autoenable engine can stay synchronous.

import type { PluginAutoEnableContext } from "@elizaos/core";

const ENV_KEYS = ["LMSTUDIO_BASE_URL"] as const;

export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  return ENV_KEYS.some((k) => {
    const v = ctx.env[k];
    return typeof v === "string" && v.trim() !== "";
  });
}
