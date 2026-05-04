import { type Content, type Memory, stringToUuid } from "@elizaos/core";
import type { WechatMessageContext } from "./types";

type ResponseCallback = (content: Content) => Promise<Memory[]>;

type RuntimeLike = {
  agentId?: string;
  ensureConnection?: (details: Record<string, unknown>) => Promise<unknown>;
  elizaOS?: {
    sendMessage?: (
      runtime: unknown,
      message: Memory,
      options?: { onResponse?: ResponseCallback },
    ) => Promise<{ responseContent?: Content } | undefined>;
  };
  messageService?: {
    handleMessage?: (
      runtime: unknown,
      message: Memory,
      onResponse: ResponseCallback,
    ) => Promise<{ responseContent?: Content } | undefined>;
  };
  emitEvent?: (events: string[], payload: unknown) => Promise<unknown>;
  createMemory?: (memory: Memory, tableName: string) => Promise<unknown>;
  logger?: {
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
};

export interface IncomingWechatDeliveryOptions {
  runtime: unknown;
  accountId: string;
  message: WechatMessageContext;
  sendText: (accountId: string, to: string, text: string) => Promise<void>;
}

export async function deliverIncomingWechatMessage(
  options: IncomingWechatDeliveryOptions,
): Promise<void> {
  const runtime = options.runtime as RuntimeLike;
  const agentId =
    typeof runtime.agentId === "string" && runtime.agentId.length > 0
      ? runtime.agentId
      : stringToUuid("wechat-agent");
  const incomingMemory = buildIncomingMemory(
    agentId,
    options.accountId,
    options.message,
  );
  const replyTarget = resolveReplyTarget(options.message);
  let replyIndex = 0;
  let replyDelivered = false;

  const onResponse: ResponseCallback = async (content) => {
    const replyText = extractReplyText(content);
    if (!replyText) {
      return [];
    }

    replyDelivered = true;
    await options.sendText(options.accountId, replyTarget, replyText);

    const replyMemory = buildReplyMemory(
      agentId,
      options.accountId,
      options.message,
      replyText,
      replyIndex,
    );
    replyIndex += 1;

    await runtime.createMemory?.(replyMemory, "messages");
    return [replyMemory];
  };

  await runtime.ensureConnection?.({
    entityId: incomingMemory.entityId,
    roomId: incomingMemory.roomId,
    worldId: stringToUuid(`wechat:world:${options.accountId}`),
    userName: options.message.sender,
    userId: options.message.sender,
    name: options.message.sender,
    source: "wechat",
    type: getChannelType(options.message),
    channelId: resolveChannelId(options.message),
    worldName: "WeChat",
  });

  if (typeof runtime.elizaOS?.sendMessage === "function") {
    const result = await runtime.elizaOS.sendMessage(
      options.runtime,
      incomingMemory,
      { onResponse },
    );
    await maybeHandleResponseContent(result, replyDelivered, onResponse);
    return;
  }

  if (typeof runtime.messageService?.handleMessage === "function") {
    const result = await runtime.messageService.handleMessage(
      options.runtime,
      incomingMemory,
      onResponse,
    );
    await maybeHandleResponseContent(result, replyDelivered, onResponse);
    return;
  }

  if (typeof runtime.emitEvent === "function") {
    await runtime.emitEvent(["MESSAGE_RECEIVED"], {
      runtime: options.runtime,
      message: incomingMemory,
      callback: onResponse,
      source: "wechat",
    });
    return;
  }

  runtime.logger?.warn?.(
    "[wechat] No inbound runtime message pipeline is available",
  );
}

function buildIncomingMemory(
  agentId: string,
  accountId: string,
  message: WechatMessageContext,
): Memory {
  return {
    id: stringToUuid(`wechat:incoming:${accountId}:${message.id}`),
    agentId,
    entityId: stringToUuid(`wechat:entity:${accountId}:${message.sender}`),
    roomId: stringToUuid(
      `wechat:room:${accountId}:${resolveChannelId(message)}`,
    ),
    createdAt: message.timestamp,
    content: {
      text: message.content,
      source: "wechat",
      channelType: getChannelType(message),
      metadata: {
        accountId,
        sender: message.sender,
        recipient: message.recipient,
        messageType: message.type,
        threadId: message.threadId,
        groupSubject: message.group?.subject,
        imageUrl: message.imageUrl,
      },
    },
    metadata: {
      type: "message",
      source: "wechat",
      provider: "wechat",
      timestamp: message.timestamp,
      entityName: message.sender,
      entityUserName: message.sender,
      fromId: message.sender,
      sourceId: stringToUuid(`wechat:entity:${accountId}:${message.sender}`),
      chatType: getChannelType(message),
      messageIdFull: message.id,
      sender: {
        id: message.sender,
        name: message.sender,
        username: message.sender,
      },
      wechat: {
        id: message.sender,
        userId: message.sender,
        username: message.sender,
        userName: message.sender,
        name: message.sender,
        messageId: message.id,
        accountId,
        recipient: message.recipient,
        threadId: message.threadId,
        groupSubject: message.group?.subject,
      },
    },
  } as Memory;
}

function buildReplyMemory(
  agentId: string,
  accountId: string,
  message: WechatMessageContext,
  text: string,
  replyIndex: number,
): Memory {
  return {
    id: stringToUuid(`wechat:reply:${accountId}:${message.id}:${replyIndex}`),
    agentId,
    entityId: agentId,
    roomId: stringToUuid(
      `wechat:room:${accountId}:${resolveChannelId(message)}`,
    ),
    createdAt: Date.now(),
    content: {
      text,
      source: "wechat",
      channelType: getChannelType(message),
      inReplyTo: message.id,
      metadata: {
        accountId,
        recipient: resolveReplyTarget(message),
      },
    },
    metadata: {
      type: "message",
      source: "wechat",
      provider: "wechat",
      timestamp: Date.now(),
      fromBot: true,
      fromId: agentId,
      sourceId: agentId,
      chatType: getChannelType(message),
      messageIdFull: `wechat:reply:${message.id}:${replyIndex}`,
      wechat: {
        accountId,
        recipient: resolveReplyTarget(message),
        threadId: message.threadId,
      },
    },
  } as Memory;
}

function getChannelType(message: WechatMessageContext): "DM" | "GROUP" {
  return message.group ? "GROUP" : "DM";
}

function resolveChannelId(message: WechatMessageContext): string {
  return message.threadId ?? message.sender;
}

function resolveReplyTarget(message: WechatMessageContext): string {
  return message.threadId ?? message.sender;
}

function extractReplyText(content: Content): string | null {
  if (typeof content.text !== "string") {
    return null;
  }

  const trimmed = content.text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function maybeHandleResponseContent(
  result: { responseContent?: Content } | undefined,
  replyDelivered: boolean,
  onResponse: ResponseCallback,
): Promise<void> {
  if (replyDelivered || !result?.responseContent) {
    return;
  }

  await onResponse(result.responseContent);
}
