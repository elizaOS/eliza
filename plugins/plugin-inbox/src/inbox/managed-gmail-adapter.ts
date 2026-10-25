/** Owner-checked Google mail through standard MESSAGE/INBOX tools. */
import { createHash } from "node:crypto";
import {
  buildContentReference,
  buildReadSlice,
  buildReadView,
  ElizaError,
  hasRoleAccess,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import {
  BaseMessageAdapter,
  type DraftRequest,
  type ListOptions,
  type ManageOperation,
  type ManageResult,
  type MessageDraftContext,
  type MessageManageContext,
  type MessageRef,
  type MessageSendContext,
  type ReadMessageRequest,
  type ReadMessageResult,
  type SearchMessagesFilters,
} from "@elizaos/plugin-assistant";
import { readGmailTextRange } from "@elizaos/plugin-google-workspace/gmail-text-range";
import { managedGmailManager } from "./managed-gmail-manage.ts";
import {
  managedGmailMessageReader,
  managedGmailReadFetcher,
} from "./managed-gmail-read.ts";
import {
  type ManagedSendContent,
  managedGmailSender,
} from "./managed-gmail-send.ts";

const unavailable = (message: string) =>
  new ElizaError(message, { code: "MANAGED_GMAIL_READ_UNAVAILABLE" });
async function owner(runtime: IAgentRuntime, requester?: Memory) {
  if (!requester)
    throw unavailable("Gmail reads require a current owner request.");
  if (
    (requester.agentId && requester.agentId !== runtime.agentId) ||
    !(await hasRoleAccess(runtime, requester, "OWNER"))
  )
    throw unavailable("Gmail is restricted to its owner.");
  return requester;
}
export class ManagedGmailAdapter extends BaseMessageAdapter {
  readonly source = "gmail" as const;
  readonly cachePolicy = "none" as const;
  private readonly fetcher = managedGmailReadFetcher();
  private readonly reader = managedGmailMessageReader();
  private readonly sender = managedGmailSender();
  private readonly manager = managedGmailManager();
  private readonly drafts = new Map<
    string,
    {
      agentId: string;
      entityId: string;
      roomId: string;
      content: ManagedSendContent;
      reviewDigest: string;
      attempted: boolean;
    }
  >();
  isAvailable() {
    return Boolean(this.fetcher && this.reader);
  }
  capabilities() {
    return {
      list: true,
      search: true,
      manage: this.manager
        ? { archive: true, trash: true, markRead: true }
        : {},
      send: this.sender
        ? { new: true, requiresLiveRequester: true }
        : { requiresLiveRequester: true },
      worlds: "single" as const,
      channels: "none" as const,
    };
  }
  protected async manageMessageImpl(
    runtime: IAgentRuntime,
    messageId: string,
    operation: ManageOperation,
    context?: MessageManageContext,
  ): Promise<ManageResult> {
    const requester = await owner(runtime, context?.requester);
    if (!this.manager)
      throw new ElizaError(
        "Managed Gmail mailbox changes are not available on this device yet. Nothing was changed.",
        { code: "MANAGED_GMAIL_MAILBOX_UNAVAILABLE" },
      );
    if (!requester.id || !requester.roomId || !requester.entityId)
      throw unavailable("Mailbox changes need the current owner turn.");
    const kind =
      operation.kind === "mark_read"
        ? operation.read
          ? "mark-read"
          : "mark-unread"
        : operation.kind === "archive" || operation.kind === "trash"
          ? operation.kind
          : null;
    if (!kind)
      return {
        ok: false,
        reason: "This Gmail mailbox operation is not supported.",
      };
    const hex = createHash("sha256")
      .update(
        JSON.stringify([
          runtime.agentId,
          requester.entityId,
          requester.roomId,
          requester.id,
          messageId,
          kind,
        ]),
      )
      .digest("hex")
      .slice(0, 32)
      .split("");
    hex[12] = "4";
    hex[16] = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16);
    const h = hex.join("");
    const requestId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    const result = await this.manager({ messageId, kind, requestId });
    await owner(runtime, requester);
    return result;
  }
  async authorizeSend(
    runtime: IAgentRuntime,
    requester?: Memory,
    draftId?: string,
  ) {
    const caller = await owner(runtime, requester),
      draft = draftId && this.drafts.get(draftId);
    if (
      !draft ||
      draft.agentId !== runtime.agentId ||
      draft.entityId !== caller.entityId ||
      draft.roomId !== caller.roomId
    )
      throw unavailable(
        "Review this email in the owner conversation that prepared it.",
      );
  }
  protected async createDraftImpl(
    runtime: IAgentRuntime,
    draft: DraftRequest,
    context?: MessageDraftContext,
  ) {
    const caller = await owner(runtime, context?.requester);
    if (!this.sender)
      throw new ElizaError(
        "Managed Gmail sending is not available on this device yet. Nothing was sent.",
        { code: "MANAGED_GMAIL_SEND_UNAVAILABLE" },
      );
    if (
      draft.source !== "gmail" ||
      draft.inReplyToId ||
      draft.threadId ||
      draft.channelId ||
      (draft.worldId && draft.worldId !== "default")
    )
      throw unavailable(
        "Prepare a new Gmail email with explicit recipients; threaded sending is not available through this host yet.",
      );
    const content = {
      to: draft.to.map((to) => to.identifier),
      subject: draft.subject ?? "",
      bodyText: draft.body,
    };
    const prepared = await this.sender.prepare(content);
    await owner(runtime, context?.requester);
    this.drafts.set(prepared.id, {
      agentId: runtime.agentId,
      entityId: caller.entityId,
      roomId: caller.roomId,
      content: structuredClone(content),
      reviewDigest: prepared.reviewDigest,
      attempted: false,
    });
    return {
      draftId: prepared.id,
      preview: `From: ${prepared.from}\nTo: ${content.to.join(", ")}\nSubject: ${content.subject}\n\n${content.bodyText}`,
    };
  }
  protected async sendDraftImpl(
    runtime: IAgentRuntime,
    draftId: string,
    context?: MessageSendContext,
  ) {
    await this.authorizeSend(runtime, context?.requester, draftId);
    const draft = this.drafts.get(draftId)!,
      snapshot = context?.snapshot;
    if (
      !this.sender ||
      !snapshot ||
      snapshot.source !== "gmail" ||
      snapshot.inReplyToId ||
      snapshot.threadId ||
      snapshot.body !== draft.content.bodyText ||
      (snapshot.subject ?? "") !== draft.content.subject ||
      JSON.stringify(snapshot.to.map((to) => to.identifier)) !==
        JSON.stringify(draft.content.to)
    )
      throw unavailable(
        "The email changed after its provider review. Prepare and review the current email before sending.",
      );
    const accepted = (
      receipt: Awaited<ReturnType<NonNullable<typeof this.sender>["receipt"]>>,
    ) => {
      if (
        receipt.reviewDigest !== draft.reviewDigest ||
        receipt.state !== "succeeded" ||
        typeof receipt.providerResult?.messageId !== "string" ||
        !receipt.providerResult.messageId
      )
        throw unavailable(
          "Delivery is not confirmed. Check this exact saved receipt; do not send this email again.",
        );
      return { externalId: receipt.providerResult.messageId };
    };
    const prior = await this.sender.receipt(draftId);
    await owner(runtime, context.requester);
    if (prior.state === "succeeded") return accepted(prior);
    if (
      prior.state !== "prepared" ||
      prior.reviewDigest !== draft.reviewDigest ||
      draft.attempted
    )
      throw unavailable(
        "This send outcome needs review. Check its saved receipt; this email will not be sent again automatically.",
      );
    draft.attempted = true;
    let result;
    try {
      result = await this.sender.dispatch(
        draftId,
        draft.reviewDigest,
        draft.content,
      );
    } catch {
      result = await this.sender.receipt(draftId);
    }
    await owner(runtime, context.requester);
    return accepted(result);
  }
  private async messages(
    runtime: IAgentRuntime,
    opts: ListOptions,
    query?: string,
  ) {
    await owner(runtime, opts.requester);
    if (!this.fetcher)
      throw unavailable("The owner Gmail host is unavailable.");
    if (
      opts.worldIds?.some((id) => id !== "default") ||
      opts.channelIds?.length
    )
      throw unavailable(
        "Use a Gmail query for this source; account and channel ids cannot override its owner.",
      );
    const parts = [query || "in:inbox"];
    if (opts.unreadOnly) parts.push("is:unread");
    if (opts.sinceMs !== undefined && !Number.isFinite(opts.sinceMs))
      throw unavailable("Invalid Gmail date.");
    const rows = await this.fetcher({
      runtime,
      limit: opts.limit,
      query: parts.join(" "),
      requester: opts.requester,
      ...(opts.sinceMs === undefined
        ? {}
        : { since: new Date(opts.sinceMs).toISOString() }),
    });
    await owner(runtime, opts.requester);
    return rows.map(
      (row): MessageRef => ({
        id: row.id,
        source: "gmail",
        externalId: row.id,
        from: { identifier: row.senderName, displayName: row.senderName },
        to: [],
        subject: row.threadTopic,
        snippet: row.snippet,
        receivedAtMs: Date.parse(row.receivedAt),
        hasAttachments: false,
        isRead: row.unread === false,
        worldId: "default",
      }),
    );
  }
  protected listMessagesImpl(runtime: IAgentRuntime, opts: ListOptions) {
    return this.messages(runtime, opts);
  }
  protected searchMessagesImpl(
    runtime: IAgentRuntime,
    filters: SearchMessagesFilters,
  ) {
    if (filters.tags?.length || filters.untilMs !== undefined || filters.sender)
      throw unavailable(
        "Use a Gmail query for sender, label, or date-range filters.",
      );
    return this.messages(runtime, filters, filters.content);
  }
  protected async readMessageImpl(
    runtime: IAgentRuntime,
    request: ReadMessageRequest,
  ): Promise<ReadMessageResult> {
    const caller = await owner(runtime, request.requester);
    if (
      request.requesterEntityId !== caller.entityId ||
      request.requesterRoomId !== caller.roomId
    )
      throw unavailable("Gmail read requester changed.");
    if (
      (request.reference || (request.offset ?? 0) > 0) &&
      !request.expectedRevision
    )
      throw unavailable(
        "Gmail continuation requires the recorded source revision.",
      );
    if (
      request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) || request.limit < 1)
    )
      throw unavailable("Choose a positive Gmail read limit.");
    const id = request.messageId ?? request.reference;
    if (!id)
      throw unavailable("Select a Gmail message from the current inbox.");
    if (!this.reader) throw unavailable("The owner Gmail host is unavailable.");
    const result = await this.reader(id);
    await owner(runtime, request.requester);
    const text = result.bodyText,
      revision = createHash("sha256").update(text).digest("hex");
    if (
      request.expectedRevision !== undefined &&
      request.expectedRevision !== revision
    )
      throw unavailable(
        "Gmail message text changed. Read it again before continuing.",
      );
    const page = readGmailTextRange(
      text,
      request.unit ?? "byte",
      request.offset ?? 0,
      request.limit,
    );
    if (request.limit !== undefined && Buffer.byteLength(page.text) > 65536)
      throw unavailable(
        "This Gmail unit page exceeds 64 KiB. Retry with byte units.",
      );
    const more = page.end < page.total;
    return {
      text: page.text,
      ...(more && request.limit !== undefined
        ? {
            control: {
              action: "read_message" as const,
              source: "gmail" as const,
              reference: id,
              offset: page.end,
              limit: request.limit,
              unit: page.unit,
              expectedRevision: revision,
            },
          }
        : {}),
      readView: buildReadView({
        reference: buildContentReference({
          kind: "email",
          ref: id,
          revision,
          resumability: "restart-safe",
        }),
        slice: buildReadSlice({
          range: {
            unit: page.unit,
            start: page.start,
            end: page.end,
            total: page.total,
          },
          completeness: more ? "partial-recoverable" : "complete",
          revision,
          sliceSha256: createHash("sha256").update(page.text).digest("hex"),
          sourceSha256: revision,
        }),
      }),
      sourceWork: {
        headReads: 0,
        segmentRows: 0,
        providerRevisionReads: 0,
        providerBodyFetches: 1,
      },
    };
  }
}
