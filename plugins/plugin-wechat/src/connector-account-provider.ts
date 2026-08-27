/**
 * WeChat ConnectorAccountManager provider for the direct first-party
 * connector. Source of truth is the direct config block (official-account or
 * wecom self-built credentials per account); account status is observational:
 * configuration presence yields at most "pending" — "connected" requires a
 * successful first-party observation surfaced by the channel's health map
 * (token probe or verified callback). Personal WeChat and proxy credentials
 * are surfaced as "error" with a migration hint, never silently configured.
 */

import type {
  ConnectorAccount,
  ConnectorAccountManager,
  ConnectorAccountPatch,
  ConnectorAccountProvider,
  IAgentRuntime,
} from "@elizaos/core";
import type { WechatAccountConfig, WechatConfig } from "./types";

const WECHAT_PROVIDER_ID = "wechat";
const WECHAT_DEFAULT_ACCOUNT_ID = "default";

/** Live observational health keyed by account id, fed by the channel. */
export type WechatHealthSource = () => Map<
  string,
  { state: string; lastSuccessAt?: number; lastFailureAt?: number }
>;

function getWechatConfig(runtime: IAgentRuntime): WechatConfig | undefined {
  const character = runtime.character?.settings as
    | { connectors?: { wechat?: WechatConfig }; wechat?: WechatConfig }
    | undefined;
  return character?.connectors?.wechat ?? character?.wechat;
}

interface WechatResolvedAccount {
  id: string;
  enabled: boolean;
  config: WechatAccountConfig;
}

function listWechatAccounts(runtime: IAgentRuntime): WechatResolvedAccount[] {
  const config = getWechatConfig(runtime);
  const result: WechatResolvedAccount[] = [];

  if (!config) {
    return result;
  }

  const globalDisabled = config.enabled === false;
  if (config.account) {
    result.push({
      id: WECHAT_DEFAULT_ACCOUNT_ID,
      enabled: !globalDisabled && config.account.enabled !== false,
      config: config.account,
    });
  }
  for (const [id, account] of Object.entries(config.accounts ?? {})) {
    if (!id) continue;
    result.push({
      id: id.trim().toLowerCase(),
      enabled: !globalDisabled && account.enabled !== false,
      config: account,
    });
  }

  return result;
}

/** True for account shapes that cannot ever start (unsupported/invalid modes). */
function isUnsupportedConfig(config: WechatAccountConfig): boolean {
  const mode = (config as { mode?: unknown }).mode;
  return mode !== "official-account" && mode !== "wecom";
}

/** Only well-formed, credential-free HTTPS origins belong in metadata. */
function safeCallbackBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return "";
    // Origins only: scheme + host + port. Strip credentials, and any path,
    // query, or fragment the configured value may carry.
    const port = url.port ? `:${url.port}` : "";
    return `${url.protocol}//${url.hostname}${port}`;
  } catch {
    // error-policy:J3 an unparseable callback URL is untrusted input; render
    // it as absent rather than echoing attacker-controlled text.
    return "";
  }
}

function observationalStatus(
  account: WechatResolvedAccount,
  health: { state: string } | undefined,
): ConnectorAccount["status"] {
  if (!account.enabled) {
    return "disabled";
  }
  switch (health?.state) {
    case "connected":
      return "connected";
    case "degraded":
    case "unavailable":
      return "error";
    default:
      // Configuration presence alone never claims "connected".
      return "pending";
  }
}

export function createWechatConnectorAccountProvider(
  runtime: IAgentRuntime,
  options?: { healthSource?: WechatHealthSource },
): ConnectorAccountProvider {
  // Health comes from the live channel when the plugin wired one (see
  // src/index.ts) or from an explicit source in tests; with neither, no
  // observation exists and every configured account reads as pending.
  const healthSource = options?.healthSource ?? (() => new Map());

  return {
    provider: WECHAT_PROVIDER_ID,
    label: "WeChat",
    listAccounts: async (
      _manager: ConnectorAccountManager,
    ): Promise<ConnectorAccount[]> => {
      const now = Date.now();
      const health = healthSource();
      return listWechatAccounts(runtime).map((account) => {
        const config = account.config as unknown as Record<string, unknown>;
        const mode = typeof config.mode === "string" ? config.mode : "unknown";
        const externalId =
          mode === "official-account"
            ? String(config.appId ?? "")
            : mode === "wecom"
              ? `${String(config.corpId ?? "")}_${String(config.agentId ?? "")}`
              : "";
        return {
          id: account.id,
          provider: WECHAT_PROVIDER_ID,
          label:
            (typeof config.name === "string" && config.name) ||
            (mode === "wecom"
              ? `WeCom ${String(config.corpId ?? "")}`
              : `WeChat ${mode}`),
          role: "AGENT",
          purpose: ["messaging"],
          accessGate: "open",
          // Unsupported shapes (personal/proxy/unknown mode) surface as an
          // explicit error state, never a healthy-looking pending.
          status: isUnsupportedConfig(account.config)
            ? ("error" as const)
            : observationalStatus(account, health.get(account.id)),
          externalId: externalId || undefined,
          createdAt: now,
          updatedAt: now,
          // Never copy secrets or unvalidated URLs into account metadata.
          metadata: {
            mode,
            callbackBaseUrl: safeCallbackBaseUrl(config.callbackBaseUrl),
          },
        } satisfies ConnectorAccount;
      });
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
      // Provider-layer account deletion returns cleanly; runtime credentials live in character
      // settings; deletion of those is out of band.
    },
  };
}
