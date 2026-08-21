/**
 * Deterministic Telegram group invocation policy. Group messages are ingested
 * into room history, but the agent speaks only when explicitly invoked unless
 * the operator opts into ambient replies. Structured Telegram entities and
 * reply provenance are preferred over text heuristics.
 */
import { logger } from "@elizaos/core";

export type TelegramGroupResponsePolicy =
  | "mention_only"
  | "ambient"
  | "disabled";

export type TelegramGroupInvocation =
  | "command"
  | "mention"
  | "reply"
  | "ambient";

export const DEFAULT_TELEGRAM_GROUP_RESPONSE_POLICY: TelegramGroupResponsePolicy =
  "mention_only";

type TelegramMessageEntity = {
  type?: string;
  offset?: number;
  length?: number;
  user?: { id?: number | string };
};

export type TelegramGroupMessageLike = {
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  reply_to_message?: {
    from?: {
      id?: number | string;
      username?: string;
      is_bot?: boolean;
    };
  };
};

export type TelegramBotIdentity = {
  id?: number | string;
  username?: string;
};

function enabled(raw: unknown): boolean {
  return raw === true || String(raw).trim().toLowerCase() === "true";
}

/**
 * Resolve the operator policy. Existing TELEGRAM_AUTO_REPLY=true deployments
 * retain ambient group behavior until they set the new policy explicitly.
 */
export function resolveTelegramGroupResponsePolicy(
  raw: unknown,
  legacyAutoReplyRaw?: unknown,
): TelegramGroupResponsePolicy {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return enabled(legacyAutoReplyRaw)
      ? "ambient"
      : DEFAULT_TELEGRAM_GROUP_RESPONSE_POLICY;
  }

  const normalized = String(raw).trim().toLowerCase().replaceAll("-", "_");
  if (
    normalized === "mention_only" ||
    normalized === "ambient" ||
    normalized === "disabled"
  ) {
    return normalized;
  }

  logger.warn(
    { src: "plugin:telegram", policy: normalized },
    "Unrecognized TELEGRAM_GROUP_RESPONSE_POLICY value; failing closed to mention_only",
  );
  return DEFAULT_TELEGRAM_GROUP_RESPONSE_POLICY;
}

function messageText(message: TelegramGroupMessageLike): string {
  return message.text ?? message.caption ?? "";
}

function messageEntities(
  message: TelegramGroupMessageLike,
): TelegramMessageEntity[] {
  return message.entities ?? message.caption_entities ?? [];
}

function entityText(text: string, entity: TelegramMessageEntity): string {
  if (
    typeof entity.offset !== "number" ||
    typeof entity.length !== "number" ||
    entity.offset < 0 ||
    entity.length <= 0
  ) {
    return "";
  }
  // Telegram offsets and JavaScript slice indices are both UTF-16 code units.
  return text.slice(entity.offset, entity.offset + entity.length);
}

/** Classify why a Telegram group turn invoked the agent. */
export function classifyTelegramGroupInvocation(
  message: TelegramGroupMessageLike,
  bot: TelegramBotIdentity,
): TelegramGroupInvocation {
  const text = messageText(message);
  const entities = messageEntities(message);
  const botUsername = bot.username?.replace(/^@/, "").toLowerCase();
  const botId = bot.id === undefined ? undefined : String(bot.id);

  const replyFrom = message.reply_to_message?.from;
  if (
    replyFrom &&
    ((botId !== undefined && String(replyFrom.id) === botId) ||
      (replyFrom.is_bot === true &&
        botUsername !== undefined &&
        replyFrom.username?.toLowerCase() === botUsername))
  ) {
    return "reply";
  }

  for (const entity of entities) {
    if (entity.type === "bot_command") {
      return "command";
    }
    if (
      entity.type === "text_mention" &&
      botId !== undefined &&
      String(entity.user?.id) === botId
    ) {
      return "mention";
    }
    if (
      entity.type === "mention" &&
      botUsername !== undefined &&
      entityText(text, entity).replace(/^@/, "").toLowerCase() === botUsername
    ) {
      return "mention";
    }
  }

  // Some Bot API proxies omit entities. A literal @username is still an
  // unambiguous invocation, so retain this narrow fallback.
  if (botUsername) {
    const escaped = botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|\\s)@${escaped}(?=\\s|[,:;.!?]|$)`, "i").test(text)) {
      return "mention";
    }
  }

  return "ambient";
}

/** Decide whether an invocation is allowed to generate a group reply. */
export function shouldReplyToTelegramGroup(
  policy: TelegramGroupResponsePolicy,
  invocation: TelegramGroupInvocation,
): boolean {
  if (policy === "disabled") return false;
  if (policy === "ambient") return true;
  return invocation !== "ambient";
}
