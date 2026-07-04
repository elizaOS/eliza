// Auto-enable check for @elizaos/plugin-meetings.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. This is the ONLY mechanism the runtime
// auto-enable engine reads: `packages/agent/src/runtime/plugin-resolver.ts`
// walks each plugin's package.json and runs `autoEnableModule.shouldEnable(ctx)`
// ("Auto-enable is sourced exclusively from per-plugin manifests … no central
// map exists"). Keep this module light: config/env reads only, no service init,
// no transitive imports of the plugin runtime (Playwright / the browser bots) —
// the engine dynamic-imports dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/core";

/** `config.features.<key>` truthy / not explicitly `{ enabled: false }`. */
function isFeatureEnabled(
  config: PluginAutoEnableContext["config"],
  key: string,
): boolean {
  const feature = (config.features as Record<string, unknown> | undefined)?.[
    key
  ];
  if (feature === true) return true;
  if (feature && typeof feature === "object") {
    return (feature as Record<string, unknown>).enabled !== false;
  }
  return false;
}

/**
 * Enable when the user has turned the "meetings" feature on in their config AND
 * the host can actually run the browser bots.
 *
 * No bespoke on/off env flag — the plugin follows the standard feature-toggle
 * convention (cf. plugin-shell / plugin-browser): it comes on when meetings is
 * enabled in config, not when an `ELIZA_MEETINGS_*` switch is set. The only
 * capability gate is the mobile veto: browser automation cannot run inside an
 * Android / iOS app sandbox (`ctx.isNativePlatform`, which the resolver derives
 * from `isMobilePlatform(process.env)`), so mobile users route meeting
 * transcripts through a cloud-hosted agent instead. `ELIZA_MEETINGS_CHROMIUM_PATH`
 * stays a Chromium-resolution override, not an enable switch.
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  return isFeatureEnabled(ctx.config, "meetings") && !ctx.isNativePlatform;
}
