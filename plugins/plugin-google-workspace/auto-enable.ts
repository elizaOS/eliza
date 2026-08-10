// Auto-enable check for @elizaos/plugin-google-workspace.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
import {
  isGoogleChatConfigured,
  type PluginAutoEnableContext,
} from "@elizaos/core";

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
 * - a configured `googlechat` connector block (not empty `{}`)
 * - plugins.entries["google-workspace"].enabled === true
 * - GOOGLE_CLIENT_ID + GOOGLE_REDIRECT_URI configured
 *
 * Do not enable merely because Calendar is present — Calendar also covers
 * Apple, Microsoft, and ICS feeds without Google.
 * The client secret is intentionally not inspected here: normal operation
 * keeps it in the runtime secrets service, which this pure predicate cannot
 * access. OAuth fails closed later if that vault entry is absent.
 * `plugins.entries["google-workspace"].enabled === false` is an unconditional veto.
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
  if (isGoogleChatConfigured(connectors?.googlechat)) {
    return true;
  }

  if (entryEnabled(entries, "google-workspace")) {
    return true;
  }

  // Non-secret app identifiers are the narrow observable OAuth signal here.
  // The connector provider resolves and validates the secret from the vault.
  if (
    hasNonEmptyEnv(ctx.env, "GOOGLE_CLIENT_ID") &&
    hasNonEmptyEnv(ctx.env, "GOOGLE_REDIRECT_URI")
  ) {
    return true;
  }

  return false;
}
