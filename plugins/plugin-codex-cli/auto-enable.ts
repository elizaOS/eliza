/**
 * Auto-enable gate for the Codex CLI model-provider plugin.
 * The manifest loads this module during boot, so it stays limited to config inspection and avoids backend/auth imports.
 */

import type { PluginAutoEnableContext } from "@elizaos/core";

/**
 * Enable when any auth profile in the user's config selects the codex-cli
 * provider. The plugin authenticates via OAuth tokens from `~/.codex/auth.json`,
 * not an env var, so config presence is the right signal.
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const profiles = (ctx.config?.auth as Record<string, unknown> | undefined)
    ?.profiles;
  if (!profiles || typeof profiles !== "object") return false;
  return Object.values(profiles as Record<string, unknown>).some((p) => {
    if (!p || typeof p !== "object") return false;
    return (p as Record<string, unknown>).provider === "codex-cli";
  });
}

/**
 * Force-enable when the user picked the openai-codex subscription, even if
 * the plugin entry has been explicitly disabled. The user deliberately
 * connected the subscription, so the runtime needs the codex-cli plugin to
 * resolve their chosen provider.
 */
export function shouldForce(ctx: PluginAutoEnableContext): boolean {
  const agents = (ctx.config as Record<string, unknown> | undefined)?.agents as
    | Record<string, unknown>
    | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  return defaults?.subscriptionProvider === "openai-codex";
}
