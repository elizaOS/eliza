/**
 * Determines whether the integrated native Messages/Blooio plugin should load.
 * This manifest entry point stays limited to config and environment reads
 * because the auto-enable engine evaluates many plugin modules during boot.
 */
import type { PluginAutoEnableContext } from "@elizaos/core";

function isFalse(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no";
}

/** Enable from connector config or an explicit environment-backed transport. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  if (isFalse(ctx.env.IMESSAGE_ENABLED)) return false;
  if (ctx.env.IMESSAGE_TRANSPORT?.trim().toLowerCase() === "blooio") return true;
  if (ctx.env.IMESSAGE_ENABLED?.trim()) return true;
  const connectors = ctx.config.connectors as Record<string, unknown> | undefined;
  const configuredConnector = [connectors?.imessage, connectors?.blooio].find(
    (connector) =>
      connector !== null &&
      typeof connector === "object" &&
      (connector as Record<string, unknown>).enabled !== false
  );
  if (!configuredConnector) return false;
  // The full per-connector field check (chat.db / Messages.app integration)
  // lives in the central engine's isConnectorConfigured. We delegate to a
  // simple "block present + not explicitly disabled" check here; the central
  // engine's stricter check remains as a fallback during migration.
  return true;
}
