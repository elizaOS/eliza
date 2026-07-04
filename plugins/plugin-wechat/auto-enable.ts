/**
 * Decides whether the WeChat connector should auto-enable from character config.
 *
 * Referenced by package.json's `elizaos.plugin.autoEnableModule` and loaded by
 * the auto-enable engine for every plugin at boot — so it must stay light: env
 * reads only, no service init, no transitive imports of the full plugin
 * runtime. Only gates on block-present-and-not-disabled; the engine's
 * `isConnectorConfigured` performs the full per-account credential check.
 */
import type { PluginAutoEnableContext } from "@elizaos/core";

/** Enable when a `wechat` connector block is present and not explicitly disabled. */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const c = (ctx.config?.connectors as Record<string, unknown> | undefined)
    ?.wechat;
  if (!c || typeof c !== "object") return false;
  const config = c as Record<string, unknown>;
  if (config.enabled === false) return false;
  // The central engine's isConnectorConfigured performs the full per-account
  // credential check; this module only gates on block-present and not
  // explicitly disabled.
  return true;
}
