/** Makes personal Google setup available unless an operator explicitly disables the plugin. */
import type { PluginAutoEnableContext } from "@elizaos/core";

/**
 * The connector must be visible before an OAuth registration exists so the UI
 * can collect that registration into the vault. Loading the plugin does not
 * expose Google actions; actions remain account- and product-bound.
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const entries = (
    ctx.config.plugins as { entries?: Record<string, unknown> } | undefined
  )?.entries;
  // Explicit disable is authoritative over every other signal.
  const workspaceEntry = entries?.["google-workspace"];
  if (
    workspaceEntry &&
    typeof workspaceEntry === "object" &&
    !Array.isArray(workspaceEntry) &&
    (workspaceEntry as { enabled?: unknown }).enabled === false
  ) {
    return false;
  }

  return true;
}
