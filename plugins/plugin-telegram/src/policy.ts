/**
 * Telegram inbound activation policy for the bot runtime. It interprets the
 * typed `connectors.telegram` account/group/topic config after startup has
 * copied that object into `character.settings.telegram`, and returns a single
 * decision before the message manager creates memory or dispatches a model turn.
 */
import { checkPairingAllowed, type IAgentRuntime } from "@elizaos/core";
import type { Message, User } from "@telegraf/types";
import type { TelegramAccountConfig } from "./accounts";

type TelegramGroupConfig = NonNullable<TelegramAccountConfig["groups"]>[string];
type TelegramTopicConfig = NonNullable<
  NonNullable<TelegramGroupConfig>["topics"]
>[string];

type TelegramPolicyConfig = Pick<
  TelegramAccountConfig,
  | "dmPolicy"
  | "groupPolicy"
  | "allowFrom"
  | "groupAllowFrom"
  | "replyToMode"
  | "groups"
>;

export type TelegramPolicyDecision = {
  shouldDispatch: boolean;
  textOverride?: string;
  denialMessage?: string;
  reason:
    | "forced"
    | "legacy-auto-reply"
    | "dm"
    | "mention"
    | "reply-to-bot"
    | "blocked";
};

function normalizeList(values: Array<string | number> | undefined): string[] {
  return (values ?? [])
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);
}

function matchesAllowList(
  values: Array<string | number> | undefined,
  identifiers: string[],
): boolean {
  const normalized = normalizeList(values);
  if (normalized.includes("*")) {
    return true;
  }
  return identifiers.some((identifier) => normalized.includes(identifier));
}

function hasEntries(values: Array<string | number> | undefined): boolean {
  return normalizeList(values).length > 0;
}

function senderIdentifiers(from: User): string[] {
  return [
    String(from.id),
    from.username ? `@${from.username}` : "",
    from.username ?? "",
  ].filter(Boolean);
}

export function hasTypedTelegramPolicyConfig(
  config: TelegramPolicyConfig,
): boolean {
  return Boolean(
    config.dmPolicy ||
      config.groupPolicy ||
      config.replyToMode ||
      hasEntries(config.allowFrom) ||
      hasEntries(config.groupAllowFrom) ||
      (config.groups && Object.keys(config.groups).length > 0),
  );
}

function resolveGroupConfig(
  config: TelegramPolicyConfig,
  chatId: string,
): TelegramGroupConfig {
  return config.groups?.[chatId];
}

function resolveTopicConfig(
  groupConfig: TelegramGroupConfig,
  threadId?: string,
): TelegramTopicConfig {
  return threadId ? groupConfig?.topics?.[threadId] : undefined;
}

function messageText(message: Message): string {
  if ("text" in message && typeof message.text === "string") {
    return message.text;
  }
  if ("caption" in message && typeof message.caption === "string") {
    return message.caption;
  }
  return "";
}

function messageEntities(
  message: Message,
): Array<{ type: string; offset: number; length: number }> {
  if ("entities" in message && Array.isArray(message.entities)) {
    return message.entities;
  }
  if (
    "caption_entities" in message &&
    Array.isArray(message.caption_entities)
  ) {
    return message.caption_entities;
  }
  return [];
}

function detectAddressedMention(
  message: Message,
  botUsername: string | undefined,
): { mentioned: boolean; text: string } {
  const text = messageText(message);
  const normalizedBot = botUsername?.replace(/^@/, "").trim().toLowerCase();
  if (!text || !normalizedBot) {
    return { mentioned: false, text };
  }

  for (const entity of messageEntities(message)) {
    if (entity.type !== "mention") {
      continue;
    }
    const mention = text.slice(entity.offset, entity.offset + entity.length);
    if (mention.replace(/^@/, "").toLowerCase() !== normalizedBot) {
      continue;
    }
    return {
      mentioned: true,
      text: `${text.slice(0, entity.offset)}${text.slice(
        entity.offset + entity.length,
      )}`.trim(),
    };
  }

  return { mentioned: false, text };
}

function isReplyToBot(message: Message, botInfo?: User): boolean {
  if (!("reply_to_message" in message) || !message.reply_to_message) {
    return false;
  }
  const repliedMessage = message.reply_to_message;
  const repliedFrom =
    "from" in repliedMessage && repliedMessage.from
      ? repliedMessage.from
      : undefined;
  if (!repliedFrom?.is_bot) {
    return false;
  }
  if (botInfo?.id !== undefined) {
    return repliedFrom.id === botInfo.id;
  }
  return false;
}

async function resolveDmAccess(params: {
  runtime: IAgentRuntime;
  config: TelegramPolicyConfig;
  identifiers: string[];
  from: User;
}): Promise<{ allowed: boolean; denialMessage?: string }> {
  const policy = params.config.dmPolicy ?? "pairing";
  if (policy === "disabled") {
    return { allowed: false };
  }
  if (policy === "open") {
    return { allowed: true };
  }
  if (policy === "allowlist") {
    return {
      allowed: matchesAllowList(params.config.allowFrom, params.identifiers),
    };
  }

  const metadata: Record<string, string> = {};
  if (params.from.username) {
    metadata.username = params.from.username;
  }
  if (params.from.first_name) {
    metadata.name = params.from.first_name;
  }
  const result = await checkPairingAllowed(params.runtime, {
    channel: "telegram",
    senderId: String(params.from.id),
    metadata,
  });
  return { allowed: result.allowed, denialMessage: result.replyMessage };
}

function groupSelected(params: {
  policy: "open" | "disabled" | "allowlist";
  groupConfig: TelegramGroupConfig;
  topicConfig: TelegramTopicConfig;
}): boolean {
  if (params.policy === "disabled") {
    return false;
  }
  if (
    params.groupConfig?.enabled === false ||
    params.topicConfig?.enabled === false
  ) {
    return false;
  }
  if (params.policy === "open") {
    return true;
  }
  return Boolean(params.groupConfig);
}

function groupSenderAllowed(params: {
  config: TelegramPolicyConfig;
  groupConfig: TelegramGroupConfig;
  topicConfig: TelegramTopicConfig;
  identifiers: string[];
}): boolean {
  if (hasEntries(params.topicConfig?.allowFrom)) {
    return matchesAllowList(params.topicConfig?.allowFrom, params.identifiers);
  }
  if (hasEntries(params.groupConfig?.allowFrom)) {
    return matchesAllowList(params.groupConfig?.allowFrom, params.identifiers);
  }
  if (hasEntries(params.config.groupAllowFrom)) {
    return matchesAllowList(params.config.groupAllowFrom, params.identifiers);
  }
  return true;
}

export async function evaluateTelegramPolicy(params: {
  runtime: IAgentRuntime;
  config: TelegramPolicyConfig;
  message: Message;
  from: User;
  chatType: string;
  chatId: string;
  threadId?: string;
  botInfo?: User;
  forceReply?: boolean;
  legacyAutoReply?: boolean;
}): Promise<TelegramPolicyDecision> {
  if (!hasTypedTelegramPolicyConfig(params.config)) {
    if (params.forceReply) {
      return { shouldDispatch: true, reason: "forced" };
    }
    return params.legacyAutoReply
      ? { shouldDispatch: true, reason: "legacy-auto-reply" }
      : { shouldDispatch: false, reason: "blocked" };
  }

  const identifiers = senderIdentifiers(params.from);
  const mention = detectAddressedMention(
    params.message,
    params.botInfo?.username,
  );

  if (params.chatType === "private") {
    const access = await resolveDmAccess({
      runtime: params.runtime,
      config: params.config,
      identifiers,
      from: params.from,
    });
    return access.allowed
      ? {
          shouldDispatch: true,
          reason: params.forceReply ? "forced" : "dm",
        }
      : {
          shouldDispatch: false,
          reason: "blocked",
          denialMessage: access.denialMessage,
        };
  }

  const policy = params.config.groupPolicy ?? "allowlist";
  const groupConfig = resolveGroupConfig(params.config, params.chatId);
  const topicConfig = resolveTopicConfig(groupConfig, params.threadId);
  if (!groupSelected({ policy, groupConfig, topicConfig })) {
    return { shouldDispatch: false, reason: "blocked" };
  }
  if (
    !groupSenderAllowed({
      config: params.config,
      groupConfig,
      topicConfig,
      identifiers,
    })
  ) {
    return { shouldDispatch: false, reason: "blocked" };
  }

  if (params.forceReply) {
    return { shouldDispatch: true, reason: "forced" };
  }

  const replyToBot = isReplyToBot(params.message, params.botInfo);
  const requireMention =
    topicConfig?.requireMention ?? groupConfig?.requireMention ?? true;
  if (mention.mentioned) {
    return {
      shouldDispatch: true,
      reason: "mention",
      textOverride: mention.text,
    };
  }
  if (replyToBot) {
    return { shouldDispatch: true, reason: "reply-to-bot" };
  }
  if (!requireMention) {
    return { shouldDispatch: true, reason: "mention" };
  }
  return { shouldDispatch: false, reason: "blocked" };
}
