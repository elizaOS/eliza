// Auto-enable check for @elizaos/plugin-anthropic-proxy.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/core";

/**
 * Enable when the operator has explicitly opted into proxy mode. The proxy
 * plugin is middleware: it self-injects ANTHROPIC_BASE_URL on init so the
 * existing plugin-anthropic transparently routes through the local Claude
 * Code OAuth proxy ("inline") or a shared upstream ("shared"). It MUST NOT
 * activate by default — the explicit mode env is the opt-in signal.
 *
 * - CLAUDE_MAX_PROXY_MODE=inline  → enabled
 * - CLAUDE_MAX_PROXY_MODE=shared  → enabled
 * - CLAUDE_MAX_PROXY_MODE=off     → NOT enabled
 * - CLAUDE_MAX_PROXY_MODE unset   → NOT enabled
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const raw = ctx.env.CLAUDE_MAX_PROXY_MODE;
  if (!raw) return false;
  const mode = raw.trim().toLowerCase();
  if (mode === "" || mode === "off") return false;
  return mode === "inline" || mode === "shared";
}
