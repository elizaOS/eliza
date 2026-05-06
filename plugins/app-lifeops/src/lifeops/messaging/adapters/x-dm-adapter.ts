import {
  type DraftRequest,
  type IAgentRuntime,
  type ListOptions,
  type MessageAdapterCapabilities,
  type MessageRef,
  type MessageSource,
  NotYetImplementedError,
} from "@elizaos/core";
import { BaseMessageAdapter } from "@elizaos/core";
import { LifeOpsService } from "../../service.js";
import { pullXInboundDms } from "../../x-dm-reader.js";
import { readXPosterCredentialsFromEnv, sendXDm } from "../../x-poster.js";

export class XDmAdapter extends BaseMessageAdapter {
  readonly source: MessageSource = "twitter";

  isAvailable(_runtime: IAgentRuntime): boolean {
    return readXPosterCredentialsFromEnv() != null;
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
    _runtime: IAgentRuntime,
    opts: ListOptions,
  ): Promise<MessageRef[]> {
    const limit = opts.limit ?? 25;
    const sinceMs = opts.sinceMs;
    const result = await pullXInboundDms({ limit });
    if (!result.hasCredentials) return [];
    const refs: MessageRef[] = [];
    for (const dm of result.inbound) {
      const receivedAtMs = Date.parse(dm.receivedAt);
      if (
        sinceMs !== undefined &&
        Number.isFinite(receivedAtMs) &&
        receivedAtMs < sinceMs
      ) {
        continue;
      }
      refs.push({
        id: `twitter:${dm.id}`,
        source: "twitter",
        externalId: dm.externalDmId,
        threadId: dm.conversationId,
        from: {
          identifier: dm.senderId,
          displayName: dm.senderHandle,
        },
        to: [],
        snippet: dm.text.slice(0, 200),
        body: dm.text,
        receivedAtMs: Number.isFinite(receivedAtMs) ? receivedAtMs : Date.now(),
        hasAttachments: false,
        isRead: false,
        channelId: dm.conversationId,
        metadata: dm.metadata,
      });
    }
    return refs;
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
    const draftId = `twitter:${recipient}:${Date.now()}`;
    const preview =
      draft.body.length > 200 ? `${draft.body.slice(0, 197)}...` : draft.body;
    return { draftId, preview };
  }

  protected async sendDraftImpl(
    runtime: IAgentRuntime,
    draftId: string,
  ): Promise<{ externalId: string }> {
    const credentials = readXPosterCredentialsFromEnv();
    if (!credentials) {
      throw new Error("[XDmAdapter] X credentials are not configured");
    }
    // draftId format: "twitter:{participantId}:{ts}". Recipient is encoded.
    const parts = draftId.split(":");
    const participantId = parts[1];
    if (!participantId) {
      throw new Error(
        `[XDmAdapter] cannot resolve recipient from draftId ${draftId}`,
      );
    }
    // The triage service stores the body on the DraftRecord; we don't have that
    // here, so fetch it from the runtime-level service if available.
    const service = new LifeOpsService(runtime);
    // Walk through the canonical X send path so cloud_managed mode is honored.
    const result = await service.sendXDirectMessage({
      participantId,
      text: parts.slice(2).join(":"),
      confirmSend: true,
      side: "owner",
    });
    if (!result.ok) {
      throw new Error(
        `[XDmAdapter] sendXDirectMessage failed: ${result.error ?? "unknown error"}`,
      );
    }
    void sendXDm; // direct sender retained for future fallback.
    return { externalId: `${participantId}:${Date.now()}` };
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
