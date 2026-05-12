import {
  type Content,
  getConnectorAccountManager,
  type IAgentRuntime,
  type Memory,
  type MessageConnectorTarget,
  stringToUuid,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import { WechatChannel } from "./channel";
import { createWechatConnectorAccountProvider } from "./connector-account-provider";
import { deliverIncomingWechatMessage } from "./runtime-bridge";
import type { WechatConfig, WechatMessageContext } from "./types";

export const WECHAT_PLUGIN_PACKAGE = "@elizaos/plugin-wechat" as const;

export function isWechatConnectorConfigured(
  config: WechatConfig | Record<string, unknown> | null | undefined,
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
      if (account.enabled === false) {
        return false;
      }
      return Boolean(account.apiKey);
    });
  }

  return false;
}

export interface Plugin {
  name: string;
  description: string;
  init?: (
    config: Record<string, unknown>,
    runtime: unknown,
  ) => Promise<void | (() => Promise<void>)>;
  /**
   * Declarative auto-enable conditions consumed by the runtime's
   * plugin-auto-enable engine. Mirrors the shape on `@elizaos/core` Plugin.
   */
  autoEnable?: {
    envKeys?: string[];
    connectorKeys?: string[];
    shouldEnable?: (
      env: Record<string, string | undefined>,
      config: Record<string, unknown>,
    ) => boolean;
  };
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

function resolveWechatConfig(
  config: Record<string, unknown>,
  runtime: unknown,
): WechatConfig | undefined {
  const explicit = (config as { connectors?: { wechat?: WechatConfig } })
    ?.connectors?.wechat;
  if (explicit) return explicit;
  const apiKey = readRuntimeSetting(runtime, "WECHAT_API_KEY");
  const proxyUrl = readRuntimeSetting(runtime, "WECHAT_PROXY_URL");
  if (!apiKey && !proxyUrl) return undefined;
  return {
    apiKey,
    proxyUrl,
  };
}

function normalizeConnectorLimit(
  limit: number | undefined,
  fallback = 50,
): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(limit), 200);
}

function getConfiguredAccountIds(config: WechatConfig): string[] {
  if (config.accounts && typeof config.accounts === "object") {
    return Object.entries(config.accounts)
      .filter(
        ([, account]) => account.enabled !== false && Boolean(account.apiKey),
      )
      .map(([id]) => id);
  }
  return config.apiKey ? ["default"] : [];
}

function resolveWechatAccountId(
  config: WechatConfig,
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
  return (
    channel?.getAccountIds()[0] ??
    getConfiguredAccountIds(config)[0] ??
    "default"
  );
}

function wechatTarget(
  accountId: string,
  wxid: string,
  name: string | undefined,
  kind: "user" | "group",
  score = 0.55,
): MessageConnectorTarget {
  return {
    target: {
      source: "wechat",
      channelId: wxid,
      roomId: stringToUuid(`wechat:room:${accountId}:${wxid}`) as UUID,
      metadata: { accountId },
    } as TargetInfo,
    label: name || wxid,
    kind,
    score,
    contexts: ["social", "connectors"],
    metadata: { accountId, wxid },
  };
}

async function listWechatTargets(
  config: WechatConfig,
): Promise<MessageConnectorTarget[]> {
  if (!channel) {
    return [];
  }
  const targets: MessageConnectorTarget[] = [];
  for (const accountId of channel.getAccountIds()) {
    const contacts = await channel.listContacts(accountId).catch(() => null);
    if (!contacts) {
      continue;
    }
    targets.push(
      ...contacts.friends.map((friend) =>
        wechatTarget(accountId, friend.wxid, friend.name, "user"),
      ),
      ...contacts.chatrooms.map((chatroom) =>
        wechatTarget(accountId, chatroom.wxid, chatroom.name, "group"),
      ),
    );
  }
  if (targets.length > 0) {
    return targets;
  }
  return getConfiguredAccountIds(config).map((accountId) =>
    wechatTarget(
      accountId,
      accountId,
      `WeChat account ${accountId}`,
      "user",
      0.25,
    ),
  );
}

function filterMemoriesByQuery(
  memories: Memory[],
  query: string,
  limit: number,
): Memory[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return memories.slice(0, limit);
  }
  return memories
    .filter((memory) => {
      const text =
        typeof memory.content?.text === "string" ? memory.content.text : "";
      return text.toLowerCase().includes(normalized);
    })
    .slice(0, limit);
}

function registerWechatMessageConnector(
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
      throw new Error("[wechat] Channel is not available");
    }
    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      return;
    }
    const accountId = resolveWechatAccountId(config, target);
    const to = String(target.channelId ?? target.entityId ?? "").trim();
    if (!to) {
      throw new Error("[wechat] target is missing channelId/entityId");
    }
    await channel.sendText(accountId, to, text);
  };

  if (typeof connectorRuntime.registerMessageConnector === "function") {
    connectorRuntime.registerMessageConnector({
      source: "wechat",
      label: "WeChat",
      description:
        "WeChat connector for sending and reading stored DM/group messages.",
      capabilities: [
        "send_message",
        "resolve_targets",
        "list_rooms",
        "chat_context",
      ],
      supportedTargetKinds: ["user", "group", "room"],
      contexts: ["social", "connectors"],
      resolveTargets: async (query: string) => {
        const normalized = query.trim().toLowerCase();
        return (await listWechatTargets(config))
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
          .filter((target) => !normalized || (target.score ?? 0) >= 0.8)
          .slice(0, 25);
      },
      listRecentTargets: async () =>
        (await listWechatTargets(config)).slice(0, 10),
      listRooms: async () => listWechatTargets(config),
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
            limit,
            orderBy: "createdAt",
            orderDirection: "desc",
          });
        }
        const targets = (await listWechatTargets(config)).slice(0, 10);
        const chunks = await Promise.all(
          targets
            .map((candidate) => candidate.target.roomId)
            .filter((roomId): roomId is UUID => Boolean(roomId))
            .map((roomId) =>
              context.runtime.getMemories({
                tableName: "messages",
                roomId,
                limit,
                orderBy: "createdAt",
                orderDirection: "desc",
              }),
            ),
        );
        return chunks
          .flat()
          .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
          .slice(0, limit);
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
            limit: Math.max(limit, 100),
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
  description: "WeChat messaging via proxy API",

  // Self-declared auto-enable: activate when the "wechat" connector is
  // configured under config.connectors. The hardcoded CONNECTOR_PLUGINS map
  // in plugin-auto-enable-engine.ts still serves as a fallback.
  autoEnable: {
    connectorKeys: ["wechat"],
  },

  async init(config: Record<string, unknown>, runtime: unknown) {
    try {
      const manager = getConnectorAccountManager(runtime as IAgentRuntime);
      manager.registerProvider(
        createWechatConnectorAccountProvider(runtime as IAgentRuntime),
      );
    } catch (err) {
      console.warn(
        "[wechat] Failed to register provider with ConnectorAccountManager:",
        err instanceof Error ? err.message : String(err),
      );
    }

    const wechatConfig = resolveWechatConfig(config, runtime);

    if (!wechatConfig) {
      console.warn("[wechat] No wechat config found in connectors — skipping");
      return;
    }

    if (wechatConfig.enabled === false) {
      console.log("[wechat] Plugin disabled via config");
      return;
    }

    channel = new WechatChannel({
      config: wechatConfig,
      onMessage: async (accountId: string, msg: WechatMessageContext) => {
        await deliverIncomingWechatMessage({
          runtime,
          accountId,
          message: msg,
          sendText: async (replyAccountId, to, text) => {
            if (!channel) {
              throw new Error("[wechat] Channel is not available for replies");
            }
            await channel.sendText(replyAccountId, to, text);
          },
        });
      },
    });

    await channel.start();
    registerWechatMessageConnector(runtime, wechatConfig);
    console.log("[wechat] Plugin initialized");

    // Return cleanup function
    return async () => {
      if (channel) {
        await channel.stop();
        channel = null;
        console.log("[wechat] Plugin stopped");
      }
    };
  },
};

export default wechatPlugin;
export { Bot } from "./bot";
export { WechatChannel } from "./channel";
export { ProxyClient } from "./proxy-client";
export { ReplyDispatcher } from "./reply-dispatcher";
export { deliverIncomingWechatMessage } from "./runtime-bridge";
export type { WechatConfig, WechatMessageContext } from "./types";
export { wechatPlugin };
