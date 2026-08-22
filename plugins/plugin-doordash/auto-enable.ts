/** Enables the DoorDash plugin only when explicitly configured. */

import type { PluginAutoEnableContext } from "@elizaos/core";

function featureEnabled(config: PluginAutoEnableContext["config"]): boolean {
  const feature = (config.features as Record<string, unknown> | undefined)
    ?.doordash;
  if (feature === true) return true;
  return Boolean(
    feature &&
      typeof feature === "object" &&
      !Array.isArray(feature) &&
      (feature as { enabled?: unknown }).enabled !== false,
  );
}

/** Enable through `features.doordash` or an environment-declared MCP endpoint. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const url = ctx.env.MCP_SERVER_DOORDASH_URL;
  return (
    featureEnabled(ctx.config) ||
    (typeof url === "string" && url.trim().length > 0)
  );
}
