/** WeChat connector plugin package name. */
export const WECHAT_PLUGIN_PACKAGE = "@elizaos/plugin-wechat" as const;

/**
 * Detect whether the WeChat connector block in `connectors.wechat` is
 * sufficiently configured to auto-enable the plugin.
 */
export function isWechatConfigured(config: Record<string, unknown>): boolean {
  if (config.enabled === false) return false;

  // Single-account: top-level apiKey
  if (config.apiKey) return true;

  // Multi-account: at least one enabled account with apiKey
  const accounts = config.accounts;
  if (accounts && typeof accounts === "object") {
    return Object.values(
      accounts as Record<string, Record<string, unknown>>,
    ).some((acc) => {
      if (acc.enabled === false) return false;
      return Boolean(acc.apiKey);
    });
  }

  return false;
}
