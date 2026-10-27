/**
 * Client for the Eliza Cloud managed Gmail routes used by a phone or browser
 * mailbox. The host injects the authenticated transport (credential storage,
 * HTTP, timeouts and redirect policy stay host-owned) and its own
 * invalid-response error, so failure classification stays consistent.
 *
 * Every response is validated before it is returned; provider content never
 * crosses as unchecked data. Reviewed effects use prepare, then one explicit
 * dispatch: any lost or aborted dispatch reply must be resolved with
 * `gmailOperation`, never with an automatic send retry.
 */
import {
  type MailAttachmentReviewer,
  type OpaqueMailAttachment,
  type OutgoingMailAttachment,
  reviewOpaqueAttachment,
} from "./attachments.ts";
import { ManagedGmailProtocolError } from "./failures.ts";
import { safeMailLink } from "./links.ts";
import type {
  GmailAccount,
  GmailDraftContent,
  GmailDraftSummary,
  GmailInboxCapabilities,
  GmailInboxReceipt,
  GmailLink,
  GmailMessage,
  GmailMessageAttachment,
  GmailReadResult,
  GmailSearchPage,
  GmailThreadPage,
  GoogleConnection,
} from "./types.ts";

type ObjectValue = Record<string, unknown>;

export interface ManagedGmailTransport {
  /**
   * One authenticated request on the Cloud API origin. A body selects POST.
   * Non-2xx answers must reject with the host's protocol error (code `http`,
   * numeric `status`). Returns the decoded JSON body.
   */
  request(
    path: string,
    signal: AbortSignal,
    options?: { body?: unknown; timeoutMs?: number },
  ): Promise<unknown>;
  /** The host's invalid-response error. Defaults to ManagedGmailProtocolError. */
  invalidResponse?(): Error;
  /** Content review of a downloaded attachment (plugin-files `reviewMailAttachment`). */
  reviewAttachment: MailAttachmentReviewer;
}

const OPERATION_KINDS: readonly string[] = [
  "send",
  "draft-create",
  "draft-replace",
  "draft-delete",
  "archive",
  "unarchive",
  "trash",
  "untrash",
  "mark-read",
  "mark-unread",
];
const RECEIPT_STATES: readonly string[] = [
  "prepared",
  "dispatched",
  "succeeded",
  "rejected",
  "outcome-unknown",
];
/** Attachment types the content review can open; others are opaque byte copies. */
const REVIEWABLE_TYPES: readonly string[] = [
  "application/pdf",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp",
];
const INBOX_V1 = "/api/v1/eliza/google/gmail/inbox-v1";
const DISPATCH_TIMEOUT_MS = 45000;

export class ManagedGmailMailboxClient {
  private readonly transport: ManagedGmailTransport;

  constructor(transport: ManagedGmailTransport) {
    this.transport = transport;
  }

  private invalid(): Error {
    return (
      this.transport.invalidResponse?.() ??
      new ManagedGmailProtocolError("invalid-response")
    );
  }
  private object(value: unknown): ObjectValue {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw this.invalid();
    return value as ObjectValue;
  }
  private string(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) throw this.invalid();
    return value;
  }
  private optionalString(value: unknown): string | null {
    return value == null ? null : this.string(value);
  }
  private async call(
    path: string,
    signal: AbortSignal,
    options?: { body?: unknown; timeoutMs?: number },
  ): Promise<ObjectValue> {
    return this.object(await this.transport.request(path, signal, options));
  }

  /** Inert, validated links; at most 50 distinct. */
  mailLinks(value: unknown): GmailLink[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 200) throw this.invalid();
    const seen = new Set<string>(),
      links: GmailLink[] = [];
    for (const row of value) {
      const link = safeMailLink(row);
      if (link && !seen.has(link.href)) {
        seen.add(link.href);
        links.push(link);
      }
    }
    return links.slice(0, 50);
  }

  /** The complete optional display body; oversized HTML keeps the plain alternative. */
  private mailHtml(value: unknown): { bodyHtml?: string } {
    if (value !== undefined && value !== null && typeof value !== "string")
      throw this.invalid();
    return typeof value === "string" &&
      value &&
      new TextEncoder().encode(value).length <= 512 * 1024
      ? { bodyHtml: value }
      : {};
  }

  googleConnection(value: unknown): GmailAccount {
    const data = this.object(value);
    if (
      typeof data.configured !== "boolean" ||
      typeof data.connected !== "boolean" ||
      !Array.isArray(data.grantedCapabilities)
    )
      throw this.invalid();
    const identity = data.identity == null ? {} : this.object(data.identity);
    return {
      configured: data.configured,
      connected: data.connected,
      reason: this.string(data.reason),
      connectionId: this.optionalString(data.connectionId),
      grantedCapabilities: data.grantedCapabilities.map((row) =>
        this.string(row),
      ),
      label:
        this.optionalString(identity.email) ??
        this.optionalString(identity.name) ??
        "Google account",
    };
  }

  gmailMessage(value: unknown): GmailMessage {
    const data = this.object(value);
    if (
      !Array.isArray(data.to) ||
      typeof data.isUnread !== "boolean" ||
      typeof data.subject !== "string" ||
      typeof data.snippet !== "string"
    )
      throw this.invalid();
    if (
      data.hasAttachments !== undefined &&
      typeof data.hasAttachments !== "boolean"
    )
      throw this.invalid();
    return {
      id: this.string(data.externalId),
      threadId: this.string(data.threadId),
      subject: data.subject,
      from: this.string(data.from),
      fromEmail: this.optionalString(data.fromEmail),
      to: data.to.map((row) => this.string(row)),
      cc: Array.isArray(data.cc) ? data.cc.map((row) => this.string(row)) : [],
      replyTo: this.optionalString(data.replyTo),
      snippet: data.snippet,
      receivedAt: this.string(data.receivedAt),
      unread: data.isUnread,
      ...(data.hasAttachments === undefined
        ? {}
        : { hasAttachments: data.hasAttachments }),
    };
  }

  async gmailAccounts(signal: AbortSignal): Promise<GmailAccount[]> {
    const data = await this.transport.request(
      "/api/v1/eliza/google/accounts?side=owner",
      signal,
    );
    if (!Array.isArray(data)) throw this.invalid();
    return data.map((value) => this.googleConnection(value));
  }

  async gmailStatus(signal: AbortSignal): Promise<GoogleConnection> {
    const data = await this.call(
      "/api/v1/eliza/google/status?side=owner",
      signal,
    );
    if (
      typeof data.configured !== "boolean" ||
      typeof data.connected !== "boolean" ||
      !Array.isArray(data.grantedCapabilities)
    )
      throw this.invalid();
    return {
      configured: data.configured,
      connected: data.connected,
      reason: this.string(data.reason),
      connectionId: this.optionalString(data.connectionId),
      grantedCapabilities: data.grantedCapabilities.map((row) =>
        this.string(row),
      ),
    };
  }

  /**
   * Revokes Eliza Cloud's stored Google grant for one owner connection. It does
   * not delete mail and cannot remove the app from the user's Google Account
   * permissions; callers verify with gmailAccounts.
   */
  async disconnectGmail(
    connectionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const data = await this.call("/api/v1/eliza/google/disconnect", signal, {
      body: { side: "owner", connectionId: this.string(connectionId) },
    });
    if (data.ok !== true) throw this.invalid();
  }

  /**
   * One search page. `mailboxHistoryId` is the Gmail mailbox revision read
   * before the page was listed; two pages of one search with different values
   * came from a changed mailbox. Older Cloud servers omit it.
   */
  async gmailSearch(
    grantId: string,
    query: string,
    signal: AbortSignal,
    maxResults: 10 | 25 | 50 = 25,
    pageToken?: string,
  ): Promise<GmailSearchPage> {
    if (
      pageToken !== undefined &&
      (typeof pageToken !== "string" || !pageToken || pageToken.length > 4096)
    )
      throw new TypeError("Invalid Gmail page token");
    const params = new URLSearchParams({
      side: "owner",
      grantId: this.string(grantId),
      query: this.string(query),
      maxResults: String(maxResults),
    });
    if (pageToken !== undefined) params.set("pageToken", pageToken);
    const data = await this.call(
      `/api/v1/eliza/google/gmail/search?${params}`,
      signal,
    );
    if (!Array.isArray(data.messages)) throw this.invalid();
    const next = data.nextPageToken;
    if (
      next != null &&
      (typeof next !== "string" ||
        !next ||
        next.length > 4096 ||
        next === pageToken)
    )
      throw this.invalid();
    const revision = data.mailboxHistoryId;
    if (
      revision != null &&
      (typeof revision !== "string" || !/^\d{1,20}$/.test(revision))
    )
      throw this.invalid();
    if (
      data.supportsSpamTrash !== undefined &&
      typeof data.supportsSpamTrash !== "boolean"
    )
      throw this.invalid();
    return {
      messages: data.messages.map((value) => this.gmailMessage(value)),
      syncedAt: this.string(data.syncedAt),
      nextPageToken: next == null ? null : next,
      ...(revision == null ? {} : { mailboxHistoryId: revision }),
      supportsSpamTrash: data.supportsSpamTrash === true,
    };
  }

  async gmailRead(
    grantId: string,
    messageId: string,
    signal: AbortSignal,
  ): Promise<GmailReadResult> {
    const params = new URLSearchParams({
      side: "owner",
      grantId: this.string(grantId),
      messageId: this.string(messageId),
    });
    const data = await this.call(
      `/api/v1/eliza/google/gmail/read?${params}`,
      signal,
    );
    if (typeof data.bodyText !== "string") throw this.invalid();
    const message = this.gmailMessage(data.message);
    if (message.id !== messageId) throw this.invalid();
    const metadata =
      data.message && typeof data.message === "object"
        ? this.object(this.object(data.message).metadata ?? {})
        : {};
    const attachments: GmailMessageAttachment[] = Array.isArray(
      data.attachments,
    )
      ? data.attachments.map((value) => {
          const a = this.object(value);
          const name = typeof a.filename === "string" ? a.filename : a.name;
          if (
            typeof a.partId !== "string" ||
            typeof name !== "string" ||
            typeof a.mimeType !== "string" ||
            !Number.isSafeInteger(a.size) ||
            (a.size as number) < 0 ||
            (a.supported !== undefined && typeof a.supported !== "boolean")
          )
            throw this.invalid();
          return {
            partId: a.partId,
            name,
            mimeType: a.mimeType,
            size: a.size as number,
            supported:
              typeof a.supported === "boolean"
                ? a.supported
                : REVIEWABLE_TYPES.includes(a.mimeType),
          };
        })
      : [];
    return {
      message,
      bodyText: data.bodyText,
      ...this.mailHtml(data.bodyHtml),
      links: this.mailLinks(data.links),
      historyId:
        typeof metadata.historyId === "string" ? metadata.historyId : null,
      attachments,
    };
  }

  async gmailInboxCapabilities(
    grantId: string,
    signal: AbortSignal,
  ): Promise<GmailInboxCapabilities> {
    const data = await this.call(
      `${INBOX_V1}/capabilities?${new URLSearchParams({ grantId })}`,
      signal,
    );
    if (
      data.version !== 1 ||
      data.providerExactlyOnce !== false ||
      data.atomicDraftReplacement !== false ||
      [
        "threads",
        "send",
        "providerDrafts",
        "mailboxMutations",
        "attachments",
      ].some((key) => typeof data[key] !== "boolean")
    )
      throw this.invalid();
    for (const key of [
      "readState",
      "draftsList",
      "forwardAttachments",
      "opaqueAttachments",
      "searchTrash",
    ])
      if (data[key] !== undefined && typeof data[key] !== "boolean")
        throw this.invalid();
    const policy =
      data.attachmentPolicy === undefined
        ? {}
        : this.object(data.attachmentPolicy);
    const limit = (value: unknown, fallback: number, max: number): number => {
      if (value === undefined) return fallback;
      if (
        !Number.isSafeInteger(value) ||
        (value as number) < 1 ||
        (value as number) > max
      )
        throw this.invalid();
      return value as number;
    };
    const maximumBytes = limit(
      policy.maximumBytes,
      5 * 1024 * 1024,
      25 * 1024 * 1024,
    );
    return {
      version: 1,
      from: this.string(data.from),
      threads: data.threads as boolean,
      send: data.send as boolean,
      providerDrafts: data.providerDrafts as boolean,
      mailboxMutations: data.mailboxMutations as boolean,
      attachments: data.attachments as boolean,
      providerExactlyOnce: false,
      atomicDraftReplacement: false,
      readState: data.readState === true,
      draftsList: data.draftsList === true,
      forwardAttachments: data.forwardAttachments === true,
      opaqueAttachments: data.opaqueAttachments === true,
      searchTrash: data.searchTrash === true,
      attachmentPolicy: {
        maximumOutgoing: limit(policy.maximumOutgoing, 1, 20),
        maximumBytes,
        maximumTotalBytes: limit(
          policy.maximumTotalBytes,
          maximumBytes,
          25 * 1024 * 1024,
        ),
      },
    };
  }

  async gmailThread(
    grantId: string,
    threadId: string,
    signal: AbortSignal,
    cursor?: { offset: number; historyId: string },
  ): Promise<GmailThreadPage> {
    const params = new URLSearchParams({ grantId, threadId });
    if (cursor) {
      params.set("offset", String(cursor.offset));
      params.set("historyId", cursor.historyId);
    }
    const data = await this.call(`${INBOX_V1}/thread?${params}`, signal);
    if (
      data.version !== 1 ||
      data.threadId !== threadId ||
      !Array.isArray(data.messages) ||
      data.messages.length > 25 ||
      !Number.isSafeInteger(data.total) ||
      !Number.isSafeInteger(data.offset) ||
      data.offset !== (cursor?.offset ?? 0)
    )
      throw this.invalid();
    const messages = data.messages.map((row) => {
      const item = this.object(row),
        message = this.gmailMessage(item.message);
      if (message.threadId !== threadId || typeof item.bodyText !== "string")
        throw this.invalid();
      return {
        message,
        bodyText: item.bodyText,
        ...this.mailHtml(item.bodyHtml),
        links: this.mailLinks(item.links),
        historyId: typeof item.historyId === "string" ? item.historyId : null,
        attachments: Array.isArray(item.attachments)
          ? item.attachments.map((value) => {
              const a = this.object(value);
              if (
                typeof a.name !== "string" ||
                typeof a.mimeType !== "string" ||
                typeof a.size !== "number" ||
                typeof a.supported !== "boolean" ||
                typeof a.partId !== "string"
              )
                throw this.invalid();
              return {
                partId: a.partId,
                name: a.name,
                mimeType: a.mimeType,
                size: a.size,
                supported: a.supported,
              };
            })
          : [],
      };
    });
    const total = data.total as number,
      offset = data.offset as number;
    if (
      total < offset + messages.length ||
      total > 2000 ||
      data.nextOffset !==
        (offset + messages.length < total ? offset + messages.length : null)
    )
      throw this.invalid();
    const historyId = this.string(data.historyId);
    if (cursor && cursor.historyId !== historyId) throw this.invalid();
    return {
      messages,
      total,
      offset,
      historyId,
      nextOffset: data.nextOffset as number | null,
    };
  }

  /**
   * Opaque byte copy of any type under the server cap. The bytes are never
   * previewed or interpreted; only the name, size and SHA-256 are checked here.
   */
  async gmailOpaqueAttachment(
    grantId: string,
    messageId: string,
    partId: string,
    historyId: string,
    signal: AbortSignal,
  ): Promise<OpaqueMailAttachment> {
    const data = await this.call(
      `${INBOX_V1}/attachment?${new URLSearchParams({ grantId, messageId, partId, historyId, opaque: "1" })}`,
      signal,
    );
    if (
      data.version !== 1 ||
      data.opaque !== true ||
      data.messageId !== messageId ||
      data.partId !== partId ||
      data.historyId !== historyId
    )
      throw this.invalid();
    let checked: OpaqueMailAttachment;
    try {
      checked = await reviewOpaqueAttachment({
        name: this.string(data.name),
        mimeType: typeof data.mimeType === "string" ? data.mimeType : "",
        dataBase64: this.string(data.dataBase64),
      });
    } catch {
      throw this.invalid();
    }
    if (checked.sha256 !== data.sha256 || checked.size !== data.size)
      throw this.invalid();
    return checked;
  }

  /** One page of provider drafts. Metadata only; open one with gmailDraftContent. */
  async gmailDrafts(
    grantId: string,
    signal: AbortSignal,
    pageToken?: string,
  ): Promise<{ drafts: GmailDraftSummary[]; nextPageToken: string | null }> {
    if (pageToken !== undefined && (!pageToken || pageToken.length > 4096))
      throw new TypeError("Invalid Gmail page token");
    const params = new URLSearchParams({ grantId });
    if (pageToken !== undefined) params.set("pageToken", pageToken);
    const data = await this.call(`${INBOX_V1}/drafts?${params}`, signal);
    if (
      data.version !== 1 ||
      !Array.isArray(data.drafts) ||
      data.drafts.length > 50
    )
      throw this.invalid();
    const next = data.nextPageToken;
    if (
      next != null &&
      (typeof next !== "string" ||
        !next ||
        next.length > 4096 ||
        next === pageToken)
    )
      throw this.invalid();
    const drafts = data.drafts.map((row) => {
      const d = this.object(row);
      if (
        !Array.isArray(d.to) ||
        typeof d.subject !== "string" ||
        typeof d.snippet !== "string"
      )
        throw this.invalid();
      return {
        draftId: this.string(d.draftId),
        messageId: this.string(d.messageId),
        subject: d.subject,
        to: d.to.map((value) => this.string(value)),
        snippet: d.snippet,
        updatedAt: this.optionalString(d.updatedAt),
      };
    });
    return { drafts, nextPageToken: next == null ? null : next };
  }

  /** Exact provider draft content and its raw-MIME digest from one snapshot. */
  async gmailDraftContent(
    grantId: string,
    draftId: string,
    signal: AbortSignal,
  ): Promise<GmailDraftContent> {
    const data = await this.call(
      `${INBOX_V1}/draft?${new URLSearchParams({ grantId, draftId, content: "1" })}`,
      signal,
    );
    if (
      data.id !== draftId ||
      typeof data.providerDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(data.providerDigest)
    )
      throw this.invalid();
    const content = this.object(data.content),
      list = (value: unknown) => {
        if (!Array.isArray(value) || value.length > 50) throw this.invalid();
        return value.map((row) => this.string(row));
      };
    if (
      typeof content.subject !== "string" ||
      typeof content.bodyText !== "string" ||
      typeof content.threaded !== "boolean" ||
      !Number.isSafeInteger(content.attachmentCount) ||
      typeof content.plainText !== "boolean"
    )
      throw this.invalid();
    return {
      draftId,
      messageId: this.string(data.messageId),
      providerDigest: data.providerDigest,
      to: list(content.to),
      cc: list(content.cc),
      bcc: list(content.bcc),
      subject: content.subject,
      bodyText: content.bodyText,
      threaded: content.threaded,
      attachmentCount: content.attachmentCount as number,
      plainText: content.plainText,
    };
  }

  /** A reviewable attachment: its bytes are checked against the declared type, size and hash. */
  async gmailAttachment(
    grantId: string,
    messageId: string,
    partId: string,
    historyId: string,
    signal: AbortSignal,
  ): Promise<{
    name: string;
    mimeType: string;
    size: number;
    sha256: string;
    text?: string;
    dataBase64: string;
  }> {
    const data = await this.call(
      `${INBOX_V1}/attachment?${new URLSearchParams({ grantId, messageId, partId, historyId })}`,
      signal,
    );
    if (
      data.version !== 1 ||
      data.messageId !== messageId ||
      data.partId !== partId ||
      data.historyId !== historyId
    )
      throw this.invalid();
    const file = {
      name: this.string(data.name),
      mimeType: data.mimeType,
      dataBase64: this.string(data.dataBase64),
    } as OutgoingMailAttachment;
    const checked = await this.transport.reviewAttachment(file);
    if (checked.sha256 !== data.sha256 || checked.size !== data.size)
      throw this.invalid();
    return { ...checked, dataBase64: file.dataBase64 };
  }

  async gmailDraft(
    grantId: string,
    draftId: string,
    signal: AbortSignal,
  ): Promise<{ draftId: string; messageId: string; providerDigest: string }> {
    const data = await this.call(
      `${INBOX_V1}/draft?${new URLSearchParams({ grantId, draftId })}`,
      signal,
    );
    if (
      data.id !== draftId ||
      typeof data.providerDigest !== "string" ||
      !/[a-f0-9]{64}/.test(data.providerDigest)
    )
      throw this.invalid();
    return {
      draftId,
      messageId: this.string(data.messageId),
      providerDigest: data.providerDigest,
    };
  }

  gmailInboxReceipt(value: unknown, requestId: string): GmailInboxReceipt {
    const data = this.object(value);
    if (
      data.requestId !== requestId ||
      !OPERATION_KINDS.includes(String(data.kind)) ||
      !RECEIPT_STATES.includes(String(data.state)) ||
      typeof data.reviewDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(data.reviewDigest)
    )
      throw this.invalid();
    const providerResult =
      data.providerResult === null ? null : this.object(data.providerResult);
    if ((data.state === "succeeded") !== (providerResult !== null))
      throw this.invalid();
    return {
      requestId,
      kind: data.kind as GmailInboxReceipt["kind"],
      state: data.state as GmailInboxReceipt["state"],
      reviewDigest: data.reviewDigest,
      providerResult,
      rejectionCode:
        data.rejectionCode === null ? null : this.string(data.rejectionCode),
    };
  }

  /** An idempotent server review of one proposal. Nothing is sent or changed. */
  async gmailPrepareOperation(
    grantId: string,
    requestId: string,
    proposal: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ receipt: GmailInboxReceipt; review: ObjectValue }> {
    const data = await this.call(`${INBOX_V1}/operations`, signal, {
      body: { grantId, requestId, proposal },
    });
    if (data.version !== 1 || data.providerExactlyOnce !== false)
      throw this.invalid();
    return {
      receipt: this.gmailInboxReceipt(data.receipt, requestId),
      review: this.object(data.review),
    };
  }

  /**
   * One explicit reviewed dispatch. The caller persists its intent before
   * calling. Any lost/aborted response must use gmailOperation, never an
   * automatic send retry.
   */
  async gmailDispatchOperation(
    grantId: string,
    requestId: string,
    reviewDigest: string,
    proposal: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<GmailInboxReceipt> {
    const data = await this.call(
      `${INBOX_V1}/operations/${encodeURIComponent(requestId)}/dispatch`,
      signal,
      {
        body: { grantId, reviewDigest, proposal },
        timeoutMs: DISPATCH_TIMEOUT_MS,
      },
    );
    if (data.version !== 1 || data.providerExactlyOnce !== false)
      throw this.invalid();
    return this.gmailInboxReceipt(data.receipt, requestId);
  }

  /** Reads the canonical receipt; never dispatches. */
  async gmailOperation(
    grantId: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<GmailInboxReceipt> {
    const data = await this.call(
      `${INBOX_V1}/operations/${encodeURIComponent(requestId)}?${new URLSearchParams({ grantId })}`,
      signal,
    );
    if (data.version !== 1 || data.providerExactlyOnce !== false)
      throw this.invalid();
    return this.gmailInboxReceipt(data.receipt, requestId);
  }
}
