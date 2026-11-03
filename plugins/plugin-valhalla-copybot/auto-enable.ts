import type { PluginAutoEnableContext } from "@elizaos/core";

const ENV_KEYS = ["VALHALLA_COPYBOT"] as const;

export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  return ENV_KEYS.some((key) => {
    const value = ctx.env[key];
    return value === "1" || value === "true";
  });
}
