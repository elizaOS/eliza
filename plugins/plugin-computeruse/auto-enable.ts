/**
 * Selects the computer-use runtime without importing native automation code.
 * The package manifest evaluates this lightweight predicate during plugin
 * discovery so both the documented feature flag and environment opt-in work.
 */
import type { PluginAutoEnableContext } from "@elizaos/core";

function isFeatureEnabled(
  config: PluginAutoEnableContext["config"],
  key: string,
): boolean {
  const feature = (config?.features as Record<string, unknown> | undefined)?.[
    key
  ];
  if (feature === true) return true;
  if (feature && typeof feature === "object") {
    return (feature as Record<string, unknown>).enabled !== false;
  }
  return false;
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isUiCapabilityEnabled(
  config: PluginAutoEnableContext["config"],
): boolean {
  const ui = config?.ui;
  if (!ui || typeof ui !== "object") return false;
  const capabilities = (ui as Record<string, unknown>).capabilities;
  return (
    !!capabilities &&
    typeof capabilities === "object" &&
    (capabilities as Record<string, unknown>).computerUse === true
  );
}

/** Enable only on an explicit Computer Use UI, feature, or environment signal. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  return (
    isUiCapabilityEnabled(ctx.config) ||
    isFeatureEnabled(ctx.config, "computeruse") ||
    isTruthyEnv(ctx.env.COMPUTER_USE_ENABLED)
  );
}
