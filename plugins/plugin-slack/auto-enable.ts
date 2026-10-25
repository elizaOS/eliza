/**
 * Auto-enable gate for the Slack connector: true when a `slack` connector block
 * is present under `config.connectors` and not explicitly disabled.
 *
 * Referenced by package.json's `elizaos.plugin.autoEnableModule` and loaded by the
 * auto-enable engine (dozens per boot), so this module stays light — env reads
 * only, no service init, no transitive imports of the full plugin runtime.
 */
import type { PluginAutoEnableContext } from "@elizaos/core";

/** Enable when a `slack` connector block is present and not explicitly disabled. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const c = (ctx.config.connectors as Record<string, unknown> | undefined)
    ?.slack;
  if (!c || typeof c !== "object") return false;
  const config = c as Record<string, unknown>;
  if (config.enabled === false) return false;
  // The full per-connector field check (botToken/appToken) lives in the central
  // engine's isConnectorConfigured; this module only checks block-present + not
  // explicitly-disabled and defers the stricter validation to that engine.
  return true;
}
