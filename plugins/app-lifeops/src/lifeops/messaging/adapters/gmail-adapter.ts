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
} from "@elizaos/core";
import type {
  LifeOpsGmailBulkOperation,
  LifeOpsGmailMessageSummary,
} from "../../../contracts/index.js";
import { LifeOpsService } from "../../service.js";

const INTERNAL_URL = new URL("http://127.0.0.1/");

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

function lifeOpsId(messageId: string): string {
  return messageId.startsWith("gmail:") ? messageId.slice("gmail:".length) : messageId;
}

function asReceivedAtMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function mapGmailMessage(message: LifeOpsGmailMessageSummary): MessageRef {
  const fromIdentifier = message.fromEmail?.trim() || message.from.trim();
  return {
    id: refId(message.id),
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
    body:
      typeof message.metadata.bodyText === "string"
        ? message.metadata.bodyText
        : undefined,
    receivedAtMs: asReceivedAtMs(message.receivedAt),
    hasAttachments: Boolean(message.metadata.hasAttachments),
    isRead: !message.isUnread,
    worldId: message.accountEmail ?? message.grantId,
    channelId: message.labels[0],
    tags: [...message.labels],
    metadata: {
      ...message.metadata,
      accountEmail: message.accountEmail,
      grantId: message.grantId,
      htmlLink: message.htmlLink,
      lifeOpsMessageId: message.id,
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
  operation: LifeOpsGmailBulkOperation;
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

export class LifeOpsGmailAdapter extends BaseMessageAdapter {
  readonly source: MessageSource = "gmail";

  private readonly messageCache = new Map<string, MessageRef>();
  private readonly draftCache = new Map<string, GmailDraftContext>();

  isAvailable(_runtime: IAgentRuntime): boolean {
    return true;
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
    opts: ListOptions,
  ): Promise<MessageRef[]> {
    const service = new LifeOpsService(runtime);
    const feed = await service.getGmailTriage(INTERNAL_URL, {
      forceSync: true,
      maxResults: opts.limit ?? 50,
    });
    return this.cacheAndFilter(
      feed.messages.map(mapGmailMessage),
      opts,
    );
  }

  protected async getMessageImpl(
    runtime: IAgentRuntime,
    id: string,
  ): Promise<MessageRef | null> {
    const cached = this.messageCache.get(id) ?? this.messageCache.get(refId(id));
    if (cached) return cached;
    const messages = await this.listMessages(runtime, { limit: 100 });
    return (
      messages.find((message) => message.id === id || message.id === refId(id)) ??
      null
    );
  }

  protected async searchMessagesImpl(
    runtime: IAgentRuntime,
    filters: SearchMessagesFilters,
  ): Promise<MessageRef[]> {
    const service = new LifeOpsService(runtime);
    const feed = await service.getGmailSearch(INTERNAL_URL, {
      query: searchQuery(filters),
      includeSpamTrash: true,
      forceSync: true,
      maxResults: filters.limit ?? 25,
    });
    const refs = feed.messages.map(mapGmailMessage);
    return this.cacheAndFilter(refs, {
      sinceMs: filters.sinceMs,
      limit: filters.limit,
      worldIds: filters.worldIds,
      channelIds: filters.channelIds,
    });
  }

  protected async createDraftImpl(
    runtime: IAgentRuntime,
    draft: DraftRequest,
  ): Promise<{ draftId: string; preview: string }> {
    if (!draft.inReplyToId) {
      throw new Error("[LifeOpsGmailAdapter] Gmail replies require inReplyToId");
    }
    const messageId = lifeOpsId(draft.inReplyToId);
    const service = new LifeOpsService(runtime);
    const rendered = await service.createGmailReplyDraft(INTERNAL_URL, {
      messageId,
      intent: draft.body,
      includeQuotedOriginal: false,
    });
    const draftId = `gmail-draft:${messageId}:${Date.now()}`;
    const preview = clip(rendered.bodyText, 240);
    this.draftCache.set(draftId, { request: draft, preview });
    return { draftId, preview };
  }

  protected async sendDraftImpl(
    runtime: IAgentRuntime,
    draftId: string,
  ): Promise<{ externalId: string }> {
    const draft = this.draftCache.get(draftId);
    if (!draft?.request.inReplyToId) {
      throw new Error(`[LifeOpsGmailAdapter] no cached draft for ${draftId}`);
    }
    const messageId = lifeOpsId(draft.request.inReplyToId);
    const service = new LifeOpsService(runtime);
    await service.sendGmailReply(INTERNAL_URL, {
      messageId,
      bodyText: draft.request.body,
      confirmSend: true,
    });
    return { externalId: `gmail-reply:${messageId}:${Date.now()}` };
  }

  protected async manageMessageImpl(
    runtime: IAgentRuntime,
    messageId: string,
    op: ManageOperation,
  ): Promise<ManageResult> {
    const service = new LifeOpsService(runtime);
    if (op.kind === "unsubscribe") {
      const ref = await this.getMessage(runtime, messageId);
      const senderEmail = ref?.from.identifier.includes("@")
        ? ref.from.identifier
        : null;
      if (!senderEmail) {
        return {
          ok: false,
          reason: `No sender email resolved for Gmail message ${messageId}`,
        };
      }
      await service.unsubscribeEmailSender(INTERNAL_URL, {
        senderEmail,
        confirmed: true,
        blockAfter: true,
        trashExisting: true,
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
    await service.manageGmailMessages(INTERNAL_URL, {
      operation: mapped.operation,
      messageIds: [lifeOpsId(messageId)],
      labelIds: mapped.labelIds,
      confirmDestructive: true,
    });
    return { ok: true };
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
      this.messageCache.set(lifeOpsId(message.id), message);
      out.push(message);
    }
    return out.slice(0, opts.limit ?? out.length);
  }
}
