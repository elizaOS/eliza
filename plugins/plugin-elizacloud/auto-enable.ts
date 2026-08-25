// Auto-enable check for @elizaos/plugin-elizacloud.
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

function isTruthyCloudFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/** Enable when an Eliza Cloud API key (concrete) or enabled flag is present. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  return (
    isConcreteKey(ctx.env.ELIZAOS_CLOUD_API_KEY) ||
    isTruthyCloudFlag(ctx.env.ELIZAOS_CLOUD_ENABLED)
  );
}
