/**
 * `XDmAdapter` — a LifeOps `BaseMessageAdapter` over the X connector's direct
 * messages, letting LifeOps list, draft, and send X DMs through `XService`. Maps
 * plugin-x DM memories to the LifeOps `MessageRef` shape and surfaces send failures
 * rather than fabricating success. Built into `dist` as its own tsup entry so
 * LifeOps can import it without the full plugin runtime.
 */
import {
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
  return { participantId, text, ...(accountId ? { accountId } : {}) };
}

export class XDmAdapter extends BaseMessageAdapter {
  readonly source: MessageSource = "twitter";

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
      // older inbound DMs out of the result. The window itself is bounded:
      // without a scan cap a sweep with no limit would page the account's
      // entire DM history before the in-memory slice below.
      const memories = await service.fetchDirectMessagesForAccount(accountId, {
        participantId: undefined,
        limit: 15000,
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

    const { participantId, text, accountId } = parseDraftId(draftId);
    const sent = await service.sendDirectMessageForAccount(accountId, {
      participantId,
      text,
    });
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
