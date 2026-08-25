// Auto-enable check for @elizaos/plugin-anthropic.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/core";

/**
 * Placeholder patterns treated the same as "unset" — mirrors the canonical
 * placeholder detection in evm-signing-capability.ts so a stale
 * "REDACTED"/"PLACEHOLDER" in env (e.g. copied from a template) does not
 * spoof the gate into enabling the provider with a non-functional key.
 */
const PLACEHOLDER_RE =
  /^\[?\s*(REDACTED|PLACEHOLDER|T(?:O)D(?:O)|CHANGEME|EMPTY)\s*]?$/i;

function isConcreteKey(value: string | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed) && !PLACEHOLDER_RE.test(trimmed as string);
}

/** Enable when an Anthropic / Claude API key is present and concrete. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const env = ctx.env;
  return isConcreteKey(env.ANTHROPIC_API_KEY) || isConcreteKey(env.CLAUDE_API_KEY);
}
