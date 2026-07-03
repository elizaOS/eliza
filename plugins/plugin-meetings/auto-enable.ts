// Auto-enable check for @elizaos/plugin-meetings.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. This is the ONLY mechanism the runtime
// auto-enable engine reads: `packages/agent/src/runtime/plugin-resolver.ts`
// walks each plugin's package.json and runs `autoEnableModule.shouldEnable(ctx)`
// ("Auto-enable is sourced exclusively from per-plugin manifests … no central
// map exists"). Keep this module light: env reads only, no service init, no
// transitive imports of the plugin runtime (Playwright / the browser bots) — the
// engine dynamic-imports dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/core";

/**
 * The browser meeting bots need a Chromium binary on the host, so the plugin is
 * opt-in: it auto-enables only when the operator flags it via
 * `ELIZA_MEETINGS_ENABLED` or points at a Chromium binary via
 * `ELIZA_MEETINGS_CHROMIUM_PATH`.
 *
 * The mobile veto keeps the flag honest: browser automation cannot run inside an
 * Android / iOS app sandbox, so even a set env key must NOT auto-enable there
 * (mobile users get meeting transcripts via a cloud-hosted agent — see
 * docs/DEPLOYMENT.md). `ctx.isNativePlatform` is the engine's own
 * `isMobilePlatform(process.env)` probe, so the veto needs no runtime import.
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  if (ctx.isNativePlatform) return false;
  const enabled = ctx.env.ELIZA_MEETINGS_ENABLED?.trim();
  const chromiumPath = ctx.env.ELIZA_MEETINGS_CHROMIUM_PATH?.trim();
  return Boolean(enabled || chromiumPath);
}
