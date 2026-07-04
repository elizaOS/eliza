/**
 * Auto-enable predicate for @elizaos/plugin-vision.
 *
 * This package-manifest entrypoint stays limited to config inspection so the
 * auto-enable engine can load it without initializing vision services or native
 * detector dependencies.
 */
import type { PluginAutoEnableContext } from "@elizaos/core";

function isFeatureEnabled(
  config: PluginAutoEnableContext["config"],
  key: string,
): boolean {
  const f = (config?.features as Record<string, unknown> | undefined)?.[key];
  if (f === true) return true;
  if (f && typeof f === "object" && f !== null) {
    return (f as Record<string, unknown>).enabled !== false;
  }
  return false;
}

/**
 * Enable when `config.features.vision` is truthy, or when the user has
 * explicitly chosen a vision provider via `config.media.vision.provider`.
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  if (isFeatureEnabled(ctx.config, "vision")) return true;
  const visionProvider = ctx.config?.media?.vision?.provider;
  return typeof visionProvider === "string" && visionProvider.length > 0;
}
