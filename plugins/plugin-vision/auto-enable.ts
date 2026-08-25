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
  if (f && typeof f === "object" && f !== null && !Array.isArray(f)) {
    return (f as Record<string, unknown>).enabled !== false;
  }
  return false;
}

/**
 * Enable when `config.features.vision` is truthy, or when the user has
 * explicitly chosen a vision provider via `config.media.vision.provider`
 * (honoring an explicit `media.vision.enabled: false` disable switch, matching
 * the plugin's inline predicate in `index.ts`).
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  if (isFeatureEnabled(ctx.config, "vision")) return true;
  const visionMedia = ctx.config?.media?.vision as
    | { enabled?: unknown; provider?: unknown }
    | undefined;
  if (!visionMedia || visionMedia.enabled === false) return false;
  const visionProvider = visionMedia.provider;
  return typeof visionProvider === "string" && visionProvider.trim().length > 0;
}
