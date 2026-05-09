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
} from "@elizaos/core";
import {
  fetchXDirectMessagesWithRuntimeService,
  sendXDirectMessageWithRuntimeService,
} from "../../runtime-service-delegates.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function encodeDraftBody(body: string): string {
  return Buffer.from(body, "utf8").toString("base64url");
}

function decodeDraftBody(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

function memoryToMessageRef(memory: Memory): MessageRef {
  const metadata = record(memory.metadata);
  const x = record(metadata.x);
  const sender = record(metadata.sender);
  const receivedAtMs = Number(memory.createdAt);
  const senderId = stringField(
    x.senderId ?? sender.id ?? memory.entityId,
    "unknown",
  );
  const senderHandle = stringField(x.senderUsername ?? sender.username);
  const body = stringField(memory.content?.text);
  return {
    id: `twitter:${stringField(x.dmEventId ?? metadata.messageIdFull ?? memory.id)}`,
    source: "twitter",
    externalId: stringField(x.dmEventId ?? metadata.messageIdFull ?? memory.id),
    threadId: stringField(x.conversationId ?? memory.roomId, senderId),
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
    channelId: stringField(x.conversationId ?? memory.roomId, senderId),
    metadata,
  };
}

export class XDmAdapter extends BaseMessageAdapter {
  readonly source: MessageSource = "twitter";

  isAvailable(runtime: IAgentRuntime): boolean {
    const service =
      runtime.getService?.("x") ?? runtime.getService?.("twitter") ?? null;
    return Boolean(service);
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
    const limit = opts.limit ?? 25;
    const sinceMs = opts.sinceMs;
    const result = await fetchXDirectMessagesWithRuntimeService({
      runtime,
      limit,
    });
    if (result.status !== "handled") return [];
    const refs = result.value.map(memoryToMessageRef);
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
    const draftId = `twitter:${encodeURIComponent(recipient)}:${Date.now()}:${encodeDraftBody(draft.body)}`;
    const preview =
      draft.body.length > 200 ? `${draft.body.slice(0, 197)}...` : draft.body;
    return { draftId, preview };
  }

  protected async sendDraftImpl(
    runtime: IAgentRuntime,
    draftId: string,
  ): Promise<{ externalId: string }> {
    const parts = draftId.split(":");
    const participantId = parts[1] ? decodeURIComponent(parts[1]) : "";
    const text = parts[3] ? decodeDraftBody(parts[3]) : "";
    if (!participantId) {
      throw new Error(
        `[XDmAdapter] cannot resolve recipient from draftId ${draftId}`,
      );
    }
    if (!text) {
      throw new Error(
        `[XDmAdapter] cannot resolve body from draftId ${draftId}`,
      );
    }
    const result = await sendXDirectMessageWithRuntimeService({
      runtime,
      participantId,
      text,
    });
    if (result.status !== "handled") {
      throw new Error(
        `[XDmAdapter] sendXDirectMessage failed: ${result.reason}`,
      );
    }
    return {
      externalId: result.value.externalId ?? `${participantId}:${Date.now()}`,
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
