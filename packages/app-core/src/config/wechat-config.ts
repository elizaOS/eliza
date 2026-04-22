export const WECHAT_PLUGIN_PACKAGE = "@elizaos/plugin-wechat" as const;

export function isWechatConfigured(
  config: Record<string, unknown> | null | undefined,
): boolean {
  if (!config || config.enabled === false) {
    return false;
  }

  if (config.apiKey) {
    return true;
  }

  const accounts = config.accounts;
  if (accounts && typeof accounts === "object") {
    return Object.values(
      accounts as Record<string, Record<string, unknown>>,
    ).some((account) => {
      if (
        !account ||
        typeof account !== "object" ||
        account.enabled === false
      ) {
        return false;
      }
      return Boolean(account.apiKey);
    });
  }

  return false;
}
