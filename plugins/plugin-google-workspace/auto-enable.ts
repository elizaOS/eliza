// Auto-enable check for @elizaos/plugin-google-workspace.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
import type { PluginAutoEnableContext } from "@elizaos/core";

function entryEnabled(
  entries: Record<string, unknown> | undefined,
  id: string,
): boolean {
  const entry = entries?.[id];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  return (entry as { enabled?: unknown }).enabled === true;
}

function hasNonEmptyEnv(
  env: NodeJS.ProcessEnv | Record<string, unknown>,
  key: string,
): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Enable Google Workspace only on an explicit Google signal:
 * - a `googlechat` connector block present and not explicitly disabled
 * - plugins.entries["google-workspace"].enabled === true
 * - GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET configured (local OAuth)
 *
 * Do not enable merely because Calendar is present — Calendar also covers
 * Apple, Microsoft, and ICS feeds without Google.
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

  const connectors = ctx.config.connectors as
    | Record<string, unknown>
    | undefined;
  const googleChat = connectors?.googlechat;
  if (
    googleChat &&
    typeof googleChat === "object" &&
    !Array.isArray(googleChat)
  ) {
    const config = googleChat as Record<string, unknown>;
    if (config.enabled !== false) {
      // The full per-connector field check (service account credentials / project)
      // lives in the central engine's isConnectorConfigured; this module gates only
      // on "block present + not explicitly disabled".
      return true;
    }
  }

  if (entryEnabled(entries, "google-workspace")) {
    return true;
  }

  // Local OAuth client pair — enough to start authorization without Chat.
  if (
    hasNonEmptyEnv(ctx.env, "GOOGLE_CLIENT_ID") &&
    hasNonEmptyEnv(ctx.env, "GOOGLE_CLIENT_SECRET")
  ) {
    return true;
  }

  return false;
}
