/**
 * `XDmAdapter` — a LifeOps `BaseMessageAdapter` over the X connector's direct
 * messages, letting LifeOps list, draft, and send X DMs through `XService`. Maps
 * plugin-x DM memories to the LifeOps `MessageRef` shape and surfaces send failures
 * rather than fabricating success. Built into `dist` as its own tsup entry so
 * LifeOps can import it without the full plugin runtime.
 */
import {
  ElizaError,
  type IAgentRuntime,
  type Memory,
  toWellFormedUnicode,
} from "@elizaos/core";
import {
  BaseMessageAdapter,
  type DraftRequest,
  type ListOptions,
  type MessageAdapterCapabilities,
  type MessageRef,
  type MessageSource,
  NotYetImplementedError,
} from "@elizaos/plugin-assistant";
import { isExplicitTwitterRejection } from "./utils/error-handler";

type XRuntimeServiceLike = {
  sendDirectMessageForAccount?: (
    accountId: string | undefined,
    params: { participantId: string; text: string },
  ) => Promise<{ ok?: boolean; status?: number; messageId?: string | null }>;
  fetchDirectMessagesForAccount?: (
    accountId: string | undefined,
    params?: { participantId?: string; limit?: number },
  ) => Promise<Memory[]>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function firstStringField(...values: unknown[]): string {
  for (const value of values) {
    const normalized = stringField(value);
    if (normalized) return normalized;
  }
  return "";
}

function getXRuntimeService(
  runtime: IAgentRuntime,
): XRuntimeServiceLike | null {
  const service = runtime.getService("x") ?? runtime.getService("twitter");
  return service && typeof service === "object"
    ? (service as XRuntimeServiceLike)
    : null;
}

function encodeDraftBody(body: string): string {
  return Buffer.from(body, "utf8").toString("base64url");
}

function decodeDraftBody(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

function memoryToMessageRef(memory: Memory): MessageRef {
  const metadata = record(memory.metadata);
  const content = record(memory.content);
  const x = record(metadata.x);
  const sender = record(metadata.sender);
  const receivedAtMs = Number(memory.createdAt);
  const senderId =
    firstStringField(x.senderId, sender.id, memory.entityId) || "unknown";
  const senderHandle = firstStringField(x.senderUsername, sender.username);
  const body = stringField(content.text);
  const externalId = firstStringField(
    x.dmEventId,
    metadata.messageIdFull,
    memory.id,
  );
  const threadId = firstStringField(x.conversationId, memory.roomId, senderId);
  // The X account that received the DM; a reply must go out from it.
  const accountId = firstStringField(metadata.accountId, x.accountId);
  return {
    id: `twitter:${externalId}`,
    source: "twitter",
    ...(accountId ? { worldId: accountId } : {}),
    externalId,
    threadId,
    from: {
      identifier: senderId,
      displayName: senderHandle,
    },
    to: [],
    snippet: body,
    body,
    receivedAtMs: Number.isFinite(receivedAtMs) ? receivedAtMs : Date.now(),
    hasAttachments: false,
    isRead: false,
    channelId: threadId,
    metadata,
  };
}

function normalizeListLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("X triage limit must be a positive safe integer");
  }
  return limit;
}

function parseDraftId(draftId: string): {
  participantId: string;
  text: string;
  accountId?: string;
  createdAtMs: number;
} {
  const parts = draftId.split(":");
  if ((parts.length !== 4 && parts.length !== 5) || parts[0] !== "twitter") {
    throw new Error(`[XDmAdapter] malformed draftId ${draftId}`);
  }
  let participantId = "";
  let accountId: string | undefined;
  try {
    participantId = parts[1] ? decodeURIComponent(parts[1]) : "";
    accountId = parts[4] ? decodeURIComponent(parts[4]) : undefined;
  } catch {
    // error-policy:J3 draft ids are untrusted client input: a lone "%" or
    // "%ZZ" recipient segment makes decodeURIComponent throw URIError,
    // which would escape sendDraft before the X service is even reached.
    throw new Error(`[XDmAdapter] malformed draftId encoding ${draftId}`);
  }
  const text = parts[3] ? decodeDraftBody(parts[3]) : "";
  if (!participantId) {
    throw new Error(
      `[XDmAdapter] cannot resolve recipient from draftId ${draftId}`,
    );
  }
  if (!text) {
    throw new Error(`[XDmAdapter] cannot resolve body from draftId ${draftId}`);
  }
  const createdAtMs = Number(parts[2]);
  return {
    participantId,
    text,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    ...(accountId ? { accountId } : {}),
  };
}

function sentDmEventId(message: Memory): string | undefined {
  const x = (message.metadata as { x?: { dmEventId?: unknown } } | undefined)
    ?.x;
  return typeof x?.dmEventId === "string" && x.dmEventId
    ? x.dmEventId
    : undefined;
}

export class XDmAdapter extends BaseMessageAdapter {
  readonly source: MessageSource = "twitter";

  /**
   * Drafts whose send X did not confirm (transport failure or 5xx). The next
   * send looks the account's own messages up first so the recipient does not
   * get the message twice.
   */
  private readonly outcomeUnknown = new Set<string>();

  isAvailable(runtime: IAgentRuntime): boolean {
    return Boolean(getXRuntimeService(runtime));
  }

  capabilities(): MessageAdapterCapabilities {
    return {
      list: true,
      search: false,
      manage: {},
      send: { reply: true, new: true, schedule: false },
      worlds: "single",
      channels: "implicit",
    };
  }

  protected async listMessagesImpl(
    runtime: IAgentRuntime,
    opts: ListOptions,
  ): Promise<MessageRef[]> {
    const service = getXRuntimeService(runtime);
    if (typeof service?.fetchDirectMessagesForAccount !== "function") {
      return [];
    }

    const limit = normalizeListLimit(opts.limit);
    const sinceMs = opts.sinceMs;
    // A conversation-scoped request (`channelIds`) lists only those
    // conversations; this adapter owns that scope (`channels: "implicit"`).
    const channels = opts.channelIds?.length ? new Set(opts.channelIds) : null;
    // Every requested X account (`worldIds`), or the service's default account.
    const accountIds: Array<string | undefined> = opts.worldIds?.length
      ? [...new Set(opts.worldIds)]
      : [undefined];
    const refs: MessageRef[] = [];
    for (const accountId of accountIds) {
      // The listing includes the account's own sent DMs; the inbox holds only
      // messages from others, like the Discord triage adapter. Fetch the
      // service's full window before filtering, so recent replies do not push
      // older inbound DMs out of the result.
      const memories = await service.fetchDirectMessagesForAccount(accountId, {
        participantId: undefined,
      });
      const candidates = memories
        .filter((memory) => memory.entityId !== runtime.agentId)
        .map(memoryToMessageRef)
        .filter(
          (ref) =>
            (!channels ||
              (ref.channelId !== undefined && channels.has(ref.channelId))) &&
            (sinceMs === undefined ||
              !Number.isFinite(ref.receivedAtMs) ||
              ref.receivedAtMs >= sinceMs),
        );
      refs.push(...candidates);
    }
    const newest = refs
      .map((ref, index) => ({ ref, index }))
      .sort(
        (left, right) =>
          right.ref.receivedAtMs - left.ref.receivedAtMs ||
          left.index - right.index,
      )
      .map(({ ref }) => ref);
    return limit === undefined ? newest : newest.slice(0, limit);
  }

  protected async getMessageImpl(
    runtime: IAgentRuntime,
    id: string,
  ): Promise<MessageRef | null> {
    const all = await this.listMessages(runtime, { limit: 100 });
    return all.find((ref) => ref.id === id) ?? null;
  }

  protected async createDraftImpl(
    _runtime: IAgentRuntime,
    draft: DraftRequest,
  ): Promise<{ draftId: string; preview: string }> {
    const recipient = draft.to[0]?.identifier;
    if (!recipient) {
      throw new Error(
        "[XDmAdapter] createDraft requires a recipient identifier",
      );
    }
    if (!draft.body.trim()) {
      throw new Error("[XDmAdapter] createDraft requires non-empty body");
    }
    const accountSegment = draft.worldId
      ? `:${encodeURIComponent(draft.worldId)}`
      : "";
    const draftId = `twitter:${encodeURIComponent(recipient)}:${Date.now()}:${encodeDraftBody(draft.body)}${accountSegment}`;
    const preview = toWellFormedUnicode(draft.body);
    return { draftId, preview };
  }

  protected async sendDraftImpl(
    runtime: IAgentRuntime,
    draftId: string,
  ): Promise<{ externalId: string }> {
    const service = getXRuntimeService(runtime);
    if (typeof service?.sendDirectMessageForAccount !== "function") {
      throw new Error("[XDmAdapter] X runtime service is unavailable");
    }

    const { participantId, text, accountId, createdAtMs } =
      parseDraftId(draftId);
    if (this.outcomeUnknown.has(draftId)) {
      const delivered = await this.findSentDm(runtime, service, {
        accountId,
        participantId,
        text,
        createdAtMs,
      });
      if (delivered) {
        this.outcomeUnknown.delete(draftId);
        return { externalId: delivered };
      }
    }
    let sent: { ok?: boolean; status?: number; messageId?: string | null };
    try {
      sent = await service.sendDirectMessageForAccount(accountId, {
        participantId,
        text,
      });
    } catch (error) {
      // A 4xx is a refusal and nothing was delivered. Anything else (no
      // response, 5xx, a later chunk failing after one was accepted) may
      // have reached the recipient.
      if (isExplicitTwitterRejection(error)) throw error;
      this.outcomeUnknown.add(draftId);
      throw new ElizaError(
        "X did not confirm the direct message; it may have been delivered. Confirming the same draft again checks X before sending it again.",
        {
          code: "X_DM_SEND_OUTCOME_UNKNOWN",
          cause: error,
          context: { draftId },
        },
      );
    }
    this.outcomeUnknown.delete(draftId);
    if (sent.ok === false) {
      throw new Error(
        `[XDmAdapter] failed to send direct message${
          sent.status ? ` (status ${sent.status})` : ""
        }`,
      );
    }
    return {
      externalId: sent.messageId ?? `${participantId}:${Date.now()}`,
    };
  }

  /** The account's own message to this recipient with the draft's text, sent since the draft was created. */
  private async findSentDm(
    runtime: IAgentRuntime,
    service: XRuntimeServiceLike,
    draft: {
      accountId?: string;
      participantId: string;
      text: string;
      createdAtMs: number;
    },
  ): Promise<string | undefined> {
    if (typeof service.fetchDirectMessagesForAccount !== "function") {
      return undefined;
    }
    const messages = await service.fetchDirectMessagesForAccount(
      draft.accountId,
      { participantId: draft.participantId, limit: 50 },
    );
    const match = messages.find(
      (message) =>
        message.entityId === runtime.agentId &&
        (message.content.text ?? "").trim() === draft.text.trim() &&
        (message.createdAt ?? 0) >= draft.createdAtMs,
    );
    return match ? sentDmEventId(match) : undefined;
  }

  protected scheduleSendImpl(
    _runtime: IAgentRuntime,
    _draftId: string,
    _sendAtMs: number,
  ): Promise<{ scheduledId: string }> {
    throw new NotYetImplementedError(
      "x_dm adapter does not support provider-native deferred delivery",
    );
  }
}
