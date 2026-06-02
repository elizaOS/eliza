import {
  BaseMessageAdapter,
  type DraftRequest,
  type IAgentRuntime,
  type ListOptions,
  type ManageOperation,
  type ManageResult,
  type MessageAdapterCapabilities,
  type MessageRef,
  type MessageSource,
  type SearchMessagesFilters,
} from "@elizaos/core/node";
import type {
  GoogleGmailBulkOperation,
  GoogleGmailMessageSummary,
  IGoogleGmailService,
} from "./types.js";

const DEFAULT_GOOGLE_ACCOUNT_ID = "default";

interface GmailDraftContext {
  readonly request: DraftRequest;
  readonly preview: string;
}

function clip(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function refId(messageId: string): string {
  return `gmail:${messageId}`;
}

function gmailId(messageId: string): string {
  return messageId.startsWith("gmail:") ? messageId.slice("gmail:".length) : messageId;
}

function externalMessageId(messageId: string): string {
  const marker = ":gmail:";
  const markerIndex = messageId.lastIndexOf(marker);
  if (markerIndex >= 0) {
    return messageId.slice(markerIndex + marker.length);
  }
  return gmailId(messageId);
}

function asReceivedAtMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function mapGmailMessage(accountId: string, message: GoogleGmailMessageSummary): MessageRef {
  const fromIdentifier = message.fromEmail?.trim() || message.from.trim();
  return {
    id: refId(message.externalId),
    source: "gmail",
    externalId: message.externalId,
    threadId: message.threadId,
    from: {
      identifier: fromIdentifier,
      displayName: message.from,
    },
    to: message.to.map((identifier) => ({ identifier })),
    subject: message.subject,
    snippet: message.snippet,
    body: typeof message.metadata.bodyText === "string" ? message.metadata.bodyText : undefined,
    receivedAtMs: asReceivedAtMs(message.receivedAt),
    hasAttachments: Boolean(message.metadata.hasAttachments),
    isRead: !message.isUnread,
    worldId: accountId,
    channelId: message.labels[0],
    tags: [...message.labels],
    metadata: {
      ...message.metadata,
      accountId,
      htmlLink: message.htmlLink,
      likelyReplyNeeded: message.likelyReplyNeeded,
      triageReason: message.triageReason,
    },
  };
}

function searchQuery(filters: SearchMessagesFilters): string {
  const tokens: string[] = ["in:anywhere"];
  const sender = filters.sender;
  if (sender?.identifier) {
    tokens.push(`from:${sender.identifier}`);
  } else if (sender?.displayName) {
    tokens.push(`from:${sender.displayName}`);
  }
  if (filters.content) {
    tokens.push(filters.content);
  }
  for (const tag of filters.tags ?? []) {
    tokens.push(`label:${tag}`);
  }
  return tokens.join(" ");
}

function toGmailOperation(op: ManageOperation): {
  operation: GoogleGmailBulkOperation;
  labelIds?: string[];
} | null {
  switch (op.kind) {
    case "archive":
      return { operation: "archive" };
    case "trash":
      return { operation: "trash" };
    case "spam":
      return { operation: "report_spam" };
    case "mark_read":
      return { operation: op.read ? "mark_read" : "mark_unread" };
    case "label_add":
      return { operation: "apply_label", labelIds: [op.label] };
    case "label_remove":
      return { operation: "remove_label", labelIds: [op.label] };
    default:
      return null;
  }
}

function getGoogleService(runtime: IAgentRuntime): IGoogleGmailService | null {
  const service = runtime.getService("google");
  return service && typeof service === "object" ? (service as IGoogleGmailService) : null;
}

function messageAccountId(message: MessageRef | null | undefined): string {
  return message?.worldId ?? DEFAULT_GOOGLE_ACCOUNT_ID;
}

export class GoogleGmailAdapter extends BaseMessageAdapter {
  readonly source: MessageSource = "gmail";

  private readonly messageCache = new Map<string, MessageRef>();
  private readonly draftCache = new Map<string, GmailDraftContext>();

  isAvailable(runtime: IAgentRuntime): boolean {
    return getGoogleService(runtime) !== null;
  }

  capabilities(): MessageAdapterCapabilities {
    return {
      list: true,
      search: true,
      manage: {
        archive: true,
        trash: true,
        spam: true,
        label: true,
        markRead: true,
        unsubscribe: true,
      },
      send: { reply: true, new: false, schedule: false },
      worlds: "multi",
      channels: "explicit",
    };
  }

  protected async listMessagesImpl(
    runtime: IAgentRuntime,
    opts: ListOptions
  ): Promise<MessageRef[]> {
    const service = this.requireService(runtime);
    const accountId = opts.worldIds?.[0] ?? DEFAULT_GOOGLE_ACCOUNT_ID;
    const messages = await service.listGmailTriageMessages({
      accountId,
      maxResults: opts.limit ?? 50,
    });
    return this.cacheAndFilter(
      messages.map((message) => mapGmailMessage(accountId, message)),
      opts
    );
  }

  protected async getMessageImpl(runtime: IAgentRuntime, id: string): Promise<MessageRef | null> {
    const cached = this.messageCache.get(id) ?? this.messageCache.get(refId(id));
    if (cached) return cached;
    const messages = await this.listMessages(runtime, { limit: 100 });
    return messages.find((message) => message.id === id || message.id === refId(id)) ?? null;
  }

  protected async searchMessagesImpl(
    runtime: IAgentRuntime,
    filters: SearchMessagesFilters
  ): Promise<MessageRef[]> {
    const service = this.requireService(runtime);
    const accountId = filters.worldIds?.[0] ?? DEFAULT_GOOGLE_ACCOUNT_ID;
    const messages = await service.searchGmailMessages({
      accountId,
      query: searchQuery(filters),
      includeSpamTrash: true,
      maxResults: filters.limit ?? 25,
    });
    const refs = messages.map((message) => mapGmailMessage(accountId, message));
    return this.cacheAndFilter(refs, {
      sinceMs: filters.sinceMs,
      limit: filters.limit,
      worldIds: filters.worldIds,
      channelIds: filters.channelIds,
    });
  }

  protected async createDraftImpl(
    runtime: IAgentRuntime,
    draft: DraftRequest
  ): Promise<{ draftId: string; preview: string }> {
    if (!draft.inReplyToId) {
      throw new Error("[GoogleGmailAdapter] Gmail replies require inReplyToId");
    }
    await this.ensureMessage(runtime, draft.inReplyToId);
    const messageId = externalMessageId(draft.inReplyToId);
    const draftId = `gmail-draft:${messageId}:${Date.now()}`;
    const preview = clip(draft.body, 240);
    this.draftCache.set(draftId, { request: draft, preview });
    return { draftId, preview };
  }

  protected async sendDraftImpl(
    runtime: IAgentRuntime,
    draftId: string
  ): Promise<{ externalId: string }> {
    const draft = this.draftCache.get(draftId);
    if (!draft?.request.inReplyToId) {
      throw new Error(`[GoogleGmailAdapter] no cached draft for ${draftId}`);
    }
    const message = await this.ensureMessage(runtime, draft.request.inReplyToId);
    const service = this.requireService(runtime);
    const sent = await service.sendGmailReply({
      accountId: messageAccountId(message),
      to: [message.from.identifier],
      subject: message.subject ?? "Re: your message",
      bodyText: draft.request.body,
      inReplyTo: metadataString(message.metadata ?? {}, "messageIdHeader"),
      references: metadataString(message.metadata ?? {}, "references"),
    });
    return {
      externalId: sent.messageId ?? `gmail-reply:${message.externalId}`,
    };
  }

  protected async manageMessageImpl(
    runtime: IAgentRuntime,
    messageId: string,
    op: ManageOperation
  ): Promise<ManageResult> {
    const service = this.requireService(runtime);
    const ref = await this.ensureMessage(runtime, messageId);
    const accountId = messageAccountId(ref);
    if (op.kind === "unsubscribe") {
      const senderEmail = ref.from.identifier.includes("@") ? ref.from.identifier : null;
      if (!senderEmail) {
        return {
          ok: false,
          reason: `No sender email resolved for Gmail message ${messageId}`,
        };
      }
      await service.createGmailFilterForSender({
        accountId,
        fromAddress: senderEmail,
        trash: true,
      });
      return { ok: true };
    }

    const mapped = toGmailOperation(op);
    if (!mapped) {
      return {
        ok: false,
        reason: `Gmail adapter does not support ${op.kind}`,
      };
    }
    await service.modifyGmailMessages({
      accountId,
      operation: mapped.operation,
      messageIds: [externalMessageId(messageId)],
      labelIds: mapped.labelIds,
    });
    return { ok: true };
  }

  private requireService(runtime: IAgentRuntime): IGoogleGmailService {
    const service = getGoogleService(runtime);
    if (!service) {
      throw new Error("[GoogleGmailAdapter] Google service is unavailable");
    }
    return service;
  }

  private async ensureMessage(runtime: IAgentRuntime, id: string): Promise<MessageRef> {
    const message = await this.getMessage(runtime, id);
    if (!message) {
      throw new Error(`[GoogleGmailAdapter] Gmail message not found: ${id}`);
    }
    return message;
  }

  private cacheAndFilter(messages: MessageRef[], opts: ListOptions): MessageRef[] {
    const worlds = opts.worldIds ? new Set(opts.worldIds) : null;
    const channels = opts.channelIds ? new Set(opts.channelIds) : null;
    const out: MessageRef[] = [];
    for (const message of messages) {
      if (opts.sinceMs !== undefined && message.receivedAtMs < opts.sinceMs) {
        continue;
      }
      if (worlds && (!message.worldId || !worlds.has(message.worldId))) {
        continue;
      }
      if (channels && (!message.channelId || !channels.has(message.channelId))) {
        continue;
      }
      this.messageCache.set(message.id, message);
      this.messageCache.set(gmailId(message.id), message);
      out.push(message);
    }
    return out.slice(0, opts.limit ?? out.length);
  }
}
