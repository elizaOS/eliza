/**
 * Plugin entry for the direct first-party WeChat connector: resolves direct
 * account config (Official Account or WeCom self-built) from
 * `character.settings.connectors.wechat`, starts the public callback server,
 * registers a `MessageConnector` (source `"wechat"`) whose capabilities are
 * mode-aware and health-bound, and surfaces observational account status
 * through the `ConnectorAccountProvider`. Personal WeChat and the legacy
 * proxy transport are explicitly unsupported and rejected with typed errors.
 */
import {
  type Content,
  getConnectorAccountManager,
  type IAgentRuntime,
  logger,
  type Memory,
  type MessageConnectorTarget,
  type Plugin,
  stringToUuid,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import { WechatChannel } from "./channel";
import { createWechatConnectorAccountProvider } from "./connector-account-provider";
import { deliverIncomingWechatMessage } from "./runtime-bridge";
import type { WechatConfig, WechatMessageContext } from "./types";
import { WechatError } from "./types";

export const WECHAT_PLUGIN_PACKAGE = "@elizaos/plugin-wechat" as const;

export function isWechatConnectorConfigured(
  config: WechatConfig | Record<string, unknown> | null | undefined,
): boolean {
  if (!config || config.enabled === false) {
    return false;
  }
  const direct = config as WechatConfig;
  if (
    direct.account &&
    direct.account.enabled !== false &&
    (direct.account.mode === "official-account" ||
      direct.account.mode === "wecom")
  ) {
    return true;
  }
  const accounts = direct.accounts;
  if (accounts && typeof accounts === "object") {
    return Object.values(accounts).some(
      (account) =>
        account.enabled !== false &&
        (account.mode === "official-account" || account.mode === "wecom"),
    );
  }
  return false;
}

let channel: WechatChannel | null = null;

type RuntimeWithWechatConnector = {
  registerMessageConnector?: (registration: Record<string, unknown>) => void;
  getMessageConnectors?: () => Array<{
    source?: string;
    fetchMessages?: (
      context: { runtime: IAgentRuntime; target?: TargetInfo },
      params?: WechatConnectorReadParams,
    ) => Promise<Memory[]>;
  }>;
  registerSendHandler?: (
    source: string,
    handler: (
      runtime: IAgentRuntime,
      target: TargetInfo,
      content: Content,
    ) => Promise<void>,
  ) => void;
};

type WechatConnectorReadParams = {
  target?: TargetInfo;
  limit?: number;
  query?: string;
};

function readRuntimeSetting(runtime: unknown, key: string): string | undefined {
  const value = (
    runtime as { getSetting?: (setting: string) => unknown }
  ).getSetting?.(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Resolve the direct WeChat configuration. Legacy proxy-shaped settings
 * (WECHAT_API_KEY / WECHAT_PROXY_URL) surface as a typed unsupported-mode
 * error instead of silently configuring nothing.
 */
function resolveWechatConfig(
  config: Record<string, unknown>,
  runtime: unknown,
): WechatConfig | undefined {
  const explicit = (config as { connectors?: { wechat?: WechatConfig } })
    ?.connectors?.wechat;
  if (explicit) {
    if (explicit.callbackPort === undefined) {
      // ELIZA_WECHAT_WEBHOOK_PORT is the documented env override for the
      // public callback listener port; wire it so the advertised setting is
      // not inert.
      const envPort = readRuntimeSetting(runtime, "ELIZA_WECHAT_WEBHOOK_PORT");
      const parsed = envPort !== undefined ? Number(envPort) : Number.NaN;
      if (Number.isSafeInteger(parsed) && parsed > 0 && parsed < 65536) {
        explicit.callbackPort = parsed;
      }
    }
    return explicit;
  }

  const legacyApiKey = readRuntimeSetting(runtime, "WECHAT_API_KEY");
  const legacyProxyUrl = readRuntimeSetting(runtime, "WECHAT_PROXY_URL");
  if (legacyApiKey || legacyProxyUrl) {
    // Fail loudly at the boundary: the proxy transport this credential pair
    // served was removed; keeping it silent would fake a configured state.
    throw new WechatError(
      "WECHAT_PROXY_CONFIG_UNSUPPORTED",
      "WECHAT_API_KEY/WECHAT_PROXY_URL configured the removed proxy transport; migrate to a direct official-account or wecom block",
      { legacyEnvKeys: ["WECHAT_API_KEY", "WECHAT_PROXY_URL"] },
    );
  }
  return undefined;
}

function normalizeConnectorLimit(
  limit: number | undefined,
): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RangeError(
      "WeChat connector limit must be a positive finite number",
    );
  }
  return Math.floor(limit);
}

function resolveWechatAccountId(
  _config: WechatConfig,
  target?: TargetInfo,
): string {
  const metadata = (
    target as (TargetInfo & { metadata?: Record<string, unknown> }) | undefined
  )?.metadata;
  const accountId =
    typeof metadata?.accountId === "string" && metadata.accountId.trim()
      ? metadata.accountId.trim()
      : undefined;
  if (accountId) {
    return accountId;
  }
  const ids = channel?.getAccountIds() ?? [];
  // Single-account deployments may omit metadata; multi-account sends must
  // fail closed rather than silently pick another account.
  if (ids.length === 1) {
    return ids[0];
  }
  throw new WechatError(
    "WECHAT_CONFIG_INVALID",
    "target does not identify a wechat account and multiple accounts are configured",
    { accountCount: ids.length },
  );
}

function wechatTarget(
  accountId: string,
  platformUserId: string,
  name: string | undefined,
  kind: "user" | "group",
  score = 0.55,
): MessageConnectorTarget {
  return {
    target: {
      source: "wechat",
      channelId: platformUserId,
      roomId: stringToUuid(
        `wechat:room:${accountId}:${platformUserId}`,
      ) as UUID,
      metadata: { accountId },
    } as TargetInfo,
    label: name || platformUserId,
    kind,
    score,
    contexts: ["social", "connectors"],
    metadata: { accountId, platformUserId },
  };
}

/**
 * Targets are derived only from observed inbound senders — never from
 * configuration presence and never synthetic per-account fallbacks. A passive
 * first-party WeChat transport has no roster API to enumerate contacts.
 */
async function listWechatTargets(): Promise<MessageConnectorTarget[]> {
  if (!channel) {
    return [];
  }
  return channel
    .listObservedTargets()
    .map((observed) =>
      wechatTarget(
        observed.accountId,
        observed.platformUserId,
        observed.name,
        observed.kind,
      ),
    );
}

function filterMemoriesByQuery(
  memories: Memory[],
  query: string,
  limit: number | undefined,
): Memory[] {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? memories.filter((memory) => {
        const text =
          typeof memory.content?.text === "string" ? memory.content.text : "";
        return text.toLowerCase().includes(normalized);
      })
    : memories;
  return limit === undefined ? filtered : filtered.slice(0, limit);
}

export function registerWechatMessageConnector(
  runtime: unknown,
  config: WechatConfig,
): void {
  const connectorRuntime = runtime as RuntimeWithWechatConnector;
  const sendHandler = async (
    _runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ): Promise<void> => {
    if (!channel) {
      throw new WechatError(
        "WECHAT_ACCOUNT_UNAVAILABLE",
        "Channel is not available",
      );
    }
    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      return;
    }
    const accountId = resolveWechatAccountId(config, target);
    const to = String(target.channelId ?? target.entityId ?? "").trim();
    if (!to) {
      throw new WechatError(
        "WECHAT_SEND_FAILED",
        "target is missing channelId/entityId",
        { target },
      );
    }
    await channel.sendText(accountId, to, text);
  };

  if (typeof connectorRuntime.registerMessageConnector === "function") {
    connectorRuntime.registerMessageConnector({
      source: "wechat",
      label: "WeChat",
      description:
        "Direct first-party WeChat connector (Official Account / WeCom) for sending and reading stored conversations.",
      capabilities: ["send_message", "resolve_targets", "chat_context"],
      supportedTargetKinds: ["user", "group", "room"],
      contexts: ["social", "connectors"],
      resolveTargets: async (query: string) => {
        const normalized = query.trim().toLowerCase();
        return (await listWechatTargets())
          .map((target) => {
            const haystack =
              `${target.label ?? ""} ${target.target.channelId ?? ""}`.toLowerCase();
            return {
              ...target,
              score:
                normalized && haystack.includes(normalized)
                  ? 0.8
                  : (target.score ?? 0.4),
            };
          })
          .filter((target) => !normalized || (target.score ?? 0) >= 0.8);
      },
      listRecentTargets: async () => listWechatTargets(),
      fetchMessages: async (
        context: { runtime: IAgentRuntime; target?: TargetInfo },
        params?: WechatConnectorReadParams,
      ) => {
        const limit = normalizeConnectorLimit(params?.limit);
        const target = params?.target ?? context.target;
        if (target?.roomId) {
          return context.runtime.getMemories({
            tableName: "messages",
            roomId: target.roomId,
            ...(limit === undefined ? {} : { limit }),
            orderBy: "createdAt",
            orderDirection: "desc",
          });
        }
        const targets = await listWechatTargets();
        const chunks = await Promise.all(
          targets
            .map((candidate) => candidate.target.roomId)
            .filter((roomId): roomId is UUID => Boolean(roomId))
            .map((roomId) =>
              context.runtime.getMemories({
                tableName: "messages",
                roomId,
                ...(limit === undefined ? {} : { limit }),
                orderBy: "createdAt",
                orderDirection: "desc",
              }),
            ),
        );
        const sorted = chunks
          .flat()
          .sort(
            (left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0),
          );
        return limit === undefined ? sorted : sorted.slice(0, limit);
      },
      searchMessages: async (
        context: { runtime: IAgentRuntime; target?: TargetInfo },
        params: WechatConnectorReadParams & { query: string },
      ) => {
        const limit = normalizeConnectorLimit(params.limit);
        const registration = connectorRuntime
          .getMessageConnectors?.()
          .find((connector) => connector.source === "wechat") as
          | {
              fetchMessages?: (
                context: { runtime: IAgentRuntime; target?: TargetInfo },
                params?: WechatConnectorReadParams,
              ) => Promise<Memory[]>;
            }
          | undefined;
        const messages =
          (await registration?.fetchMessages?.(context, {
            target: params.target ?? context.target,
            ...(limit === undefined ? {} : { limit }),
          })) ?? [];
        return filterMemoriesByQuery(messages, params.query, limit);
      },
      sendHandler,
    });
    return;
  }

  connectorRuntime.registerSendHandler?.("wechat", sendHandler);
}

const wechatPlugin: Plugin = {
  name: "wechat",
  description:
    "Direct first-party WeChat messaging (Official Account / WeCom self-built)",
  connectorSources: [
    {
      source: "wechat",
      aliases: ["wechat"],
      sourceKind: "passive",
      isPassive: true,
    },
  ],

  // Self-declared auto-enable: activate when the "wechat" connector is
  // configured under config.connectors. The hardcoded CONNECTOR_PLUGINS map
  // in plugin-auto-enable-engine.ts still serves as a fallback.
  autoEnable: {
    connectorKeys: ["wechat"],
  },

  async init(config: Record<string, string>, runtime: IAgentRuntime) {
    try {
      const manager = getConnectorAccountManager(runtime as IAgentRuntime);
      manager.registerProvider(
        createWechatConnectorAccountProvider(runtime as IAgentRuntime, {
          // Observational status: once the channel starts (below), its
          // evidence map feeds the provider so "connected" always reflects a
          // real first-party observation. listAccounts reads the map lazily,
          // so registration order (provider before channel start) is safe.
          healthSource: () => {
            const map = new Map<string, { state: string }>();
            for (const evidence of channel?.listAccountEvidence() ?? []) {
              if (evidence.health) {
                map.set(evidence.accountId, evidence.health);
              }
            }
            return map;
          },
        }),
      );
    } catch (err) {
      // error-policy:J4 provider registration failure degrades account
      // observability; the connector keeps operating without it.
      logger.warn(
        `[wechat] Failed to register provider with ConnectorAccountManager: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const wechatConfig = resolveWechatConfig(config, runtime);

    if (!wechatConfig) {
      logger.warn("[wechat] No wechat config found in connectors — skipping");
      return;
    }

    if (wechatConfig.enabled === false) {
      logger.log("[wechat] Plugin disabled via config");
      return;
    }

    channel = new WechatChannel({
      config: wechatConfig,
      onDeliveryError: (error, accountId) => {
        runtime.reportError("wechat:callback-delivery", error, { accountId });
      },
      onMessage: async (accountId: string, msg: WechatMessageContext) => {
        await deliverIncomingWechatMessage({
          runtime,
          accountId,
          message: msg,
          sendText: async (replyAccountId, to, text) => {
            if (!channel) {
              throw new WechatError(
                "WECHAT_ACCOUNT_UNAVAILABLE",
                "Channel is not available for replies",
              );
            }
            await channel.sendText(replyAccountId, to, text);
          },
        });
      },
    });

    await channel.start();
    registerWechatMessageConnector(runtime, wechatConfig);
    logger.log("[wechat] Plugin initialized");
  },
  async dispose() {
    if (channel) {
      await channel.stop();
      channel = null;
      logger.log("[wechat] Plugin disposed");
    }
  },
};

export default wechatPlugin;
export { Bot } from "./bot";
export { WechatChannel } from "./channel";
export { ReplyDispatcher } from "./reply-dispatcher";
export { deliverIncomingWechatMessage } from "./runtime-bridge";
export type {
  WechatAccountConfig,
  WechatConfig,
  WechatMessageContext,
  WechatMode,
} from "./types";
export { WechatError } from "./types";
export { wechatPlugin };
