/**
 * `XDmAdapter` — a LifeOps `BaseMessageAdapter` over the X connector's direct
 * messages, letting LifeOps list, draft, and send X DMs through `XService`. Maps
 * plugin-x DM memories to the LifeOps `MessageRef` shape and surfaces send failures
 * rather than fabricating success. Built into `dist` as its own tsup entry so
 * LifeOps can import it without the full plugin runtime.
 */
import {
  BaseMessageAdapter,
  type DraftRequest,
  type IAgentRuntime,
  type ListOptions,
  type Memory,
  type MessageAdapterCapabilities,
  type MessageRef,
  type MessageSource,
  NotYetImplementedError,
} from "@elizaos/core/node";

type XRuntimeServiceLike = {
  sendDirectMessageForAccount?: (
    accountId: string,
    params: { participantId: string; text: string },
  ) => Promise<{ ok?: boolean; status?: number; messageId?: string | null }>;
  fetchDirectMessagesForAccount?: (
    accountId: string,
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
  return {
    id: `twitter:${externalId}`,
    source: "twitter",
    externalId,
    threadId,
    from: {
      identifier: senderId,
      displayName: senderHandle,
    },
    to: [],
    snippet: body.slice(0, 200),
    body,
    receivedAtMs: Number.isFinite(receivedAtMs) ? receivedAtMs : Date.now(),
    hasAttachments: false,
    isRead: false,
    channelId: threadId,
    metadata,
  };
}

function normalizeListLimit(limit: number | undefined): number {
  if (limit === undefined) return 25;
  if (!Number.isFinite(limit)) return 25;
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

function parseDraftId(draftId: string): {
  participantId: string;
  text: string;
} {
  const parts = draftId.split(":");
  if (parts.length !== 4 || parts[0] !== "twitter") {
    throw new Error(`[XDmAdapter] malformed draftId ${draftId}`);
  }
  const participantId = parts[1] ? decodeURIComponent(parts[1]) : "";
  const text = parts[3] ? decodeDraftBody(parts[3]) : "";
  if (!participantId) {
    throw new Error(
      `[XDmAdapter] cannot resolve recipient from draftId ${draftId}`,
    );
  }
  if (!text) {
    throw new Error(`[XDmAdapter] cannot resolve body from draftId ${draftId}`);
  }
  return { participantId, text };
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
    const memories = await service.fetchDirectMessagesForAccount("default", {
      participantId: undefined,
      limit,
    });
    const refs = memories.map(memoryToMessageRef);
    return refs.filter((ref) => {
      if (
        sinceMs !== undefined &&
        Number.isFinite(ref.receivedAtMs) &&
        ref.receivedAtMs < sinceMs
      ) {
        return false;
      }
      return true;
    });
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
    const draftId = `twitter:${encodeURIComponent(recipient)}:${Date.now()}:${encodeDraftBody(draft.body)}`;
    const preview =
      draft.body.length > 200 ? `${draft.body.slice(0, 197)}...` : draft.body;
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

    const { participantId, text } = parseDraftId(draftId);
    const sent = await service.sendDirectMessageForAccount("default", {
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
      "x_dm adapter: native scheduleSend (use core's local timer fallback)",
    );
  }
}
