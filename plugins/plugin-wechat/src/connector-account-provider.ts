/**
 * WeChat ConnectorAccountManager provider.
 *
 * Adapts the multi-account scaffolding (`WechatConfig.accounts`) to the
 * `ConnectorAccountProvider` contract from
 * `@elizaos/core/connectors/account-manager`.
 *
 * Source of truth is the wechat config block (proxy URL + API key per account).
 * AccountKey is the proxy account id (the key in `WechatConfig.accounts`) or
 * `default` for single-account env-only deployments. Role is `AGENT` since
 * wechat proxy creds authenticate the bot, not the user.
 */

import type {
  ConnectorAccount,
  ConnectorAccountManager,
  ConnectorAccountPatch,
  ConnectorAccountProvider,
  IAgentRuntime,
} from "@elizaos/core";
import type { WechatConfig } from "./types";

export const WECHAT_PROVIDER_ID = "wechat";
export const WECHAT_DEFAULT_ACCOUNT_ID = "default";

function getWechatConfig(runtime: IAgentRuntime): WechatConfig | undefined {
  const character = runtime.character?.settings as
    | { connectors?: { wechat?: WechatConfig }; wechat?: WechatConfig }
    | undefined;
  return character?.connectors?.wechat ?? character?.wechat;
}

interface WechatResolvedAccount {
  id: string;
  enabled: boolean;
  apiKeyConfigured: boolean;
  proxyUrl?: string;
  wcId?: string;
  nickName?: string;
  name?: string;
}

function listWechatAccounts(runtime: IAgentRuntime): WechatResolvedAccount[] {
  const config = getWechatConfig(runtime);
  const result: WechatResolvedAccount[] = [];

  if (!config) {
    // Single-account env-only fallback
    const envApiKey = runtime.getSetting?.("WECHAT_API_KEY") as
      | string
      | undefined;
    const envProxy = runtime.getSetting?.("WECHAT_PROXY_URL") as
      | string
      | undefined;
    if (envApiKey?.trim() || envProxy?.trim()) {
      result.push({
        id: WECHAT_DEFAULT_ACCOUNT_ID,
        enabled: true,
        apiKeyConfigured: Boolean(envApiKey?.trim()),
        proxyUrl: envProxy?.trim() || undefined,
      });
    }
    return result;
  }

  if (config.enabled === false) {
    // Plugin disabled — still surface the account as `disabled`.
    if (config.apiKey?.trim() || config.accounts) {
      result.push({
        id: WECHAT_DEFAULT_ACCOUNT_ID,
        enabled: false,
        apiKeyConfigured: Boolean(config.apiKey?.trim()),
        proxyUrl: config.proxyUrl,
      });
    }
    return result;
  }

  if (config.apiKey?.trim()) {
    result.push({
      id: WECHAT_DEFAULT_ACCOUNT_ID,
      enabled: true,
      apiKeyConfigured: true,
      proxyUrl: config.proxyUrl,
    });
  }

  if (config.accounts && typeof config.accounts === "object") {
    for (const [id, account] of Object.entries(config.accounts)) {
      if (!id) continue;
      result.push({
        id: id.trim().toLowerCase(),
        enabled: account.enabled !== false,
        apiKeyConfigured: Boolean(account.apiKey?.trim()),
        proxyUrl: account.proxyUrl,
        wcId: account.wcId,
        nickName: account.nickName,
        name: account.name,
      });
    }
  }

  return result;
}

function toConnectorAccount(account: WechatResolvedAccount): ConnectorAccount {
  const now = Date.now();
  return {
    id: account.id,
    provider: WECHAT_PROVIDER_ID,
    label: account.name ?? account.nickName ?? account.id,
    role: "AGENT",
    purpose: ["messaging"],
    accessGate: "open",
    status:
      account.enabled && account.apiKeyConfigured ? "connected" : "disabled",
    externalId: account.wcId || undefined,
    displayHandle: account.nickName || undefined,
    createdAt: now,
    updatedAt: now,
    metadata: {
      proxyUrl: account.proxyUrl ?? "",
      wcId: account.wcId ?? "",
      nickName: account.nickName ?? "",
    },
  };
}

export function createWechatConnectorAccountProvider(
  runtime: IAgentRuntime,
): ConnectorAccountProvider {
  return {
    provider: WECHAT_PROVIDER_ID,
    label: "WeChat",
    listAccounts: async (
      _manager: ConnectorAccountManager,
    ): Promise<ConnectorAccount[]> => {
      const accounts = listWechatAccounts(runtime);
      if (accounts.length === 0) {
        // No accounts configured — surface a placeholder default so the
        // connector is visible in the manager UI.
        return [
          toConnectorAccount({
            id: WECHAT_DEFAULT_ACCOUNT_ID,
            enabled: false,
            apiKeyConfigured: false,
          }),
        ];
      }
      return accounts.map(toConnectorAccount);
    },
    createAccount: async (
      input: ConnectorAccountPatch,
      _manager: ConnectorAccountManager,
    ) => {
      return {
        ...input,
        provider: WECHAT_PROVIDER_ID,
        role: input.role ?? "AGENT",
        purpose: input.purpose ?? ["messaging"],
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
      };
    },
    patchAccount: async (
      _accountId: string,
      patch: ConnectorAccountPatch,
      _manager: ConnectorAccountManager,
    ) => {
      return { ...patch, provider: WECHAT_PROVIDER_ID };
    },
    deleteAccount: async (
      _accountId: string,
      _manager: ConnectorAccountManager,
    ) => {
      // No-op at provider layer — runtime credentials live in character
      // settings; deletion of those is out of band.
    },
  };
}
