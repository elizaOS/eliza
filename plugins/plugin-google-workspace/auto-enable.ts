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

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** True when a googlechat block has real config fields, not just `{}`. */
function isGoogleChatConnectorConfigured(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  if (config.enabled === false) return false;
  // Usable Chat credential material only — projectId alone is not enough.
  if (nonEmptyString(config.serviceAccountKey)) return true;
  if (nonEmptyString(config.serviceAccount)) return true;
  if (Array.isArray(config.accounts)) {
    return config.accounts.some((account) => {
      if (!account || typeof account !== "object" || Array.isArray(account)) {
        return false;
      }
      const row = account as Record<string, unknown>;
      return Boolean(
        nonEmptyString(row.serviceAccountKey) || nonEmptyString(row.keyFile),
      );
    });
  }
  return false;
}

/**
 * Enable Google Workspace only on an explicit Google signal:
 * - a configured `googlechat` connector block (not empty `{}`)
 * - plugins.entries["google-workspace"].enabled === true
 * - GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET configured (local OAuth)
 *
 * Do not enable merely because Calendar is present — Calendar also covers
 * Apple, Microsoft, and ICS feeds without Google.
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
  if (isGoogleChatConnectorConfigured(connectors?.googlechat)) {
    return true;
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
