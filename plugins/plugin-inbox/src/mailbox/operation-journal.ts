/**
 * Durable journal for one reviewed managed-Gmail operation per owner and grant.
 *
 * Every effect is prepared (an idempotent server review) and then dispatched at
 * most once after an explicit confirmation. The `dispatching` phase is written
 * before the single network attempt, so a lost reply can never cause a second
 * dispatch: an uncertain outcome stays uncertain until the canonical receipt is
 * read back. No recovery path in this module dispatches an effect.
 *
 * The owner has three exits from an unresolved dispatch, none of which sends:
 * a dispatch Cloud refused before claiming it returns to review; a request
 * Cloud still reports as never claimed can be discarded (Cloud cancels it, so a
 * late dispatch is refused); and an outcome Cloud has settled as unknown can be
 * acknowledged, which frees the slot and keeps its request id in a short
 * history that a new request id never reuses.
 *
 * The record layout and storage keys (`inbox-operation:v1:<sha256([owner, grant])>`
 * and `inbox-operation-acknowledged:v1:<same>`) are installed-data identifiers;
 * hosts keep existing records readable.
 */
import {
  checkOutgoingAttachments,
  type MailAttachmentReviewer,
  type OutgoingMailAttachment,
  outgoingAttachmentLimits,
} from "./attachments.ts";
import { isDigest, sha256Hex } from "./digest.ts";
import { MANAGED_PROTOCOL_ERROR_NAMES } from "./failures.ts";
import type { GmailInboxReceipt } from "./types.ts";

type Bag = Record<string, unknown>;

export interface InboxOperationRecord {
  version: 1;
  owner: string;
  grantId: string;
  requestId: string;
  proposal: Bag;
  phase: "preparing" | "review" | "dispatching" | "observed";
  review: Bag | null;
  receipt: GmailInboxReceipt | null;
  /**
   * The local draft a send was started from. Local only: it is never part of
   * the proposal the provider sees. A confirmed send clears only copies of this
   * exact draft with the sent content.
   */
  source?: {
    draftId: string;
    /**
     * The revision of that draft's saved local copy when Send was reviewed. A
     * saved copy still at this revision after the send, holding other text, is
     * an earlier version of the sent email.
     */
    savedRevision?: string;
  };
  /**
   * The composer email a send or draft review was made from. Local only. The
   * review can be confirmed only while the composer holds that same email (same
   * local draft, which belongs to one From account) with exactly the reviewed
   * content.
   */
  composer?: { draftId: string };
  /** Wall-clock milliseconds when the dispatch was started. Absent on older records. */
  dispatchStartedAt?: number;
}

/** Operations reviewed from the composer. */
export const composerKind = (kind: unknown): boolean =>
  kind === "send" || kind === "draft-create" || kind === "draft-replace";

/** Everything the person reviews in a composer proposal, as one comparable text. */
export const composerContent = (proposal: Bag): string =>
  JSON.stringify(
    [
      "mode",
      "to",
      "cc",
      "bcc",
      "subject",
      "bodyText",
      "attachments",
      "forwardAttachments",
      "replyMessageId",
    ].map((field) => proposal[field] ?? null),
  );

export interface ComposerEmail {
  draftId: string;
  proposal: Bag;
}

/**
 * How an unsent composer review relates to the email now in the composer:
 * `bound` same email, same content; `edited` same email, content changed;
 * `other` another email (or a review saved without its email's identity);
 * `absent` no email is open in the composer.
 */
export type ReviewBinding = "bound" | "edited" | "other" | "absent";

export function reviewBinding(
  record: Pick<InboxOperationRecord, "proposal" | "composer">,
  current: ComposerEmail | null,
): ReviewBinding {
  if (!current) return "absent";
  if (
    !record.composer ||
    !current.draftId ||
    record.composer.draftId !== current.draftId
  )
    return "other";
  return composerContent(record.proposal) === composerContent(current.proposal)
    ? "bound"
    : "edited";
}

export const reviewBindingRefusal: Record<
  Exclude<ReviewBinding, "bound">,
  string
> = {
  edited:
    "This email was edited after this review, so the review was discarded. Nothing was sent. Review the current email before sending.",
  other:
    "This review was made for a different email than the one now in the composer, so it was discarded. Nothing was sent. Review the current email before sending.",
  absent:
    "This review is for an email that is not open in the composer, so it cannot be confirmed. Nothing was sent. Open that email and choose Send to review it again, or cancel this review.",
};

/** Compare-and-exchange storage for the journal record (encrypted on a phone). */
export interface InboxOperationStore {
  read<T>(key: string): Promise<T | null>;
  compareExchange(
    key: string,
    expected: unknown,
    value: unknown,
  ): Promise<{ status: string }>;
}

export interface InboxOperationClient {
  gmailPrepareOperation(
    grant: string,
    request: string,
    proposal: Bag,
    signal: AbortSignal,
  ): Promise<{ receipt: GmailInboxReceipt; review: Bag }>;
  gmailDispatchOperation(
    grant: string,
    request: string,
    digest: string,
    proposal: Bag,
    signal: AbortSignal,
  ): Promise<GmailInboxReceipt>;
  gmailOperation(
    grant: string,
    request: string,
    signal: AbortSignal,
  ): Promise<GmailInboxReceipt>;
  /** Discards a request Cloud never dispatched. Absent on an older host client. */
  gmailCancelOperation?(
    grant: string,
    request: string,
    signal: AbortSignal,
  ): Promise<GmailInboxReceipt>;
}

export interface InboxOperationDependencies {
  owner: string;
  grantId: string;
  active(): boolean;
  store: InboxOperationStore;
  client: InboxOperationClient;
  /** Content review of each outgoing attachment, compared with the server's review. */
  reviewAttachment: MailAttachmentReviewer;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** A send the saved receipt says succeeded, with the local draft it came from. */
const sentFromDraft = (record: InboxOperationRecord) =>
  record.phase === "observed" &&
  record.proposal.kind === "send" &&
  record.receipt?.state === "succeeded" &&
  !!record.source;

/** The provider reports the same succeeded send, with the same provider message, as the saved one. */
const sameSend = (saved: GmailInboxReceipt, receipt: GmailInboxReceipt) =>
  receipt.requestId === saved.requestId &&
  receipt.kind === saved.kind &&
  receipt.reviewDigest === saved.reviewDigest &&
  receipt.state === "succeeded" &&
  typeof receipt.providerResult?.messageId === "string" &&
  !!receipt.providerResult.messageId &&
  receipt.providerResult.messageId === saved.providerResult?.messageId;

const PHASES = ["preparing", "review", "dispatching", "observed"];

/** How long a started dispatch can still be answered: the longest dispatch timeout. */
export const INBOX_DISPATCH_SETTLE_MS = 120_000;
/** Acknowledged unknown outcomes kept per owner and grant; the oldest is dropped. */
export const INBOX_ACKNOWLEDGED_LIMIT = 20;

const UNRESOLVED =
  "Outcome is unresolved. Check the existing receipt; do not repeat this message.";

/**
 * A dispatch Cloud still reports as never claimed, after any reply to it could
 * have arrived. The owner may discard it; Cloud then refuses a late dispatch.
 */
export const discardableDispatch = (
  record: Pick<
    InboxOperationRecord,
    "phase" | "receipt" | "dispatchStartedAt"
  > | null,
  now = Date.now(),
): boolean =>
  record?.phase === "dispatching" &&
  record.receipt?.state === "prepared" &&
  (record.dispatchStartedAt === undefined ||
    now - record.dispatchStartedAt >= INBOX_DISPATCH_SETTLE_MS);

/**
 * Cloud's own answer refusing a request: a 4xx with Cloud's `{ error }` body,
 * not a bare status from a gateway or proxy on the way.
 */
function cloudRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    data?: unknown;
  };
  const data = failure.data as { error?: unknown } | null | undefined;
  return (
    typeof failure.name === "string" &&
    MANAGED_PROTOCOL_ERROR_NAMES.includes(failure.name) &&
    failure.code === "http" &&
    typeof failure.status === "number" &&
    failure.status >= 400 &&
    failure.status < 500 &&
    !!data &&
    typeof data === "object" &&
    typeof data.error === "string"
  );
}

const httpStatus = (error: unknown): unknown =>
  error && typeof error === "object"
    ? (error as { status?: unknown }).status
    : undefined;

/** A dispatch that ran out of time may still have reached Gmail. */
const timedOut = (error: unknown): boolean =>
  error instanceof Error &&
  error.name !== "AbortError" &&
  /timed out|timeout/i.test(error.message);

interface AcknowledgedHistory {
  version: 1;
  requestIds: string[];
}

/** Storage key of the journal for one owner and grant. */
export async function inboxOperationKey(
  owner: string,
  grantId: string,
): Promise<string> {
  return `inbox-operation:v1:${await sha256Hex(JSON.stringify([owner, grantId]))}`;
}

/** Storage key of the acknowledged unknown outcomes for one owner and grant. */
export async function inboxAcknowledgedKey(
  owner: string,
  grantId: string,
): Promise<string> {
  return `inbox-operation-acknowledged:v1:${await sha256Hex(JSON.stringify([owner, grantId]))}`;
}

const validHistory = (value: unknown): value is AcknowledgedHistory =>
  !!value &&
  typeof value === "object" &&
  (value as AcknowledgedHistory).version === 1 &&
  Array.isArray((value as AcknowledgedHistory).requestIds) &&
  (value as AcknowledgedHistory).requestIds.every(
    (id) => typeof id === "string" && !!id,
  );

function validRecord(
  value: InboxOperationRecord,
  owner: string,
  grantId: string,
): boolean {
  if (
    value.version !== 1 ||
    value.owner !== owner ||
    value.grantId !== grantId ||
    !value.requestId ||
    !value.proposal ||
    !PHASES.includes(value.phase)
  )
    return false;
  if (value.source !== undefined) {
    const source = value.source;
    if (
      !source ||
      typeof source.draftId !== "string" ||
      !source.draftId ||
      (source.savedRevision !== undefined &&
        (typeof source.savedRevision !== "string" || !source.savedRevision))
    )
      return false;
  }
  if (value.composer !== undefined) {
    const composer = value.composer;
    if (!composer || typeof composer.draftId !== "string" || !composer.draftId)
      return false;
  }
  if (
    value.dispatchStartedAt !== undefined &&
    !Number.isFinite(value.dispatchStartedAt)
  )
    return false;
  return true;
}

/** One durable selected-account intent. No recovery path dispatches an effect. */
export class InboxOperation {
  private record: InboxOperationRecord | null = null;
  private busy = false;
  /**
   * A confirmed send loaded from storage whose receipt the provider has not
   * reported again in this session. Its source draft is left out of snapshots,
   * so cleanup keeps every local copy.
   */
  private unconfirmedSource = false;
  private controller = new AbortController();

  private readonly deps: InboxOperationDependencies;

  constructor(deps: InboxOperationDependencies) {
    this.deps = deps;
  }

  snapshot(): InboxOperationRecord | null {
    if (!this.record) return null;
    const value = copy(this.record);
    if (this.unconfirmedSource) delete value.source;
    return value;
  }

  stop(): void {
    this.controller.abort();
  }

  private check() {
    if (!this.deps.active() || this.controller.signal.aborted)
      throw new DOMException("Inbox account changed", "AbortError");
  }

  /**
   * Removes the saved record for one owner and grant when it is an
   * undispatched review ('preparing' or 'review'). It is independent of any live
   * InboxOperation, so a withdrawn grant is honoured even when the account is
   * rebound or reset meanwhile. A dispatching or observed record is never
   * touched: its receipt stays. A write that races it is re-read a few times.
   * Returns whether a record was removed.
   */
  static async discardUnsent(
    store: InboxOperationStore,
    owner: string,
    grantId: string,
  ): Promise<boolean> {
    const key = await inboxOperationKey(owner, grantId);
    for (let attempt = 0; attempt < 4; attempt++) {
      const value = await store.read<InboxOperationRecord>(key);
      if (!value || (value.phase !== "preparing" && value.phase !== "review"))
        return false;
      if ((await store.compareExchange(key, value, null)).status === "saved")
        return true;
    }
    throw new Error(
      "The unsent review kept changing and was not discarded. Reload its receipt before continuing.",
    );
  }

  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("An Inbox operation is already pending");
    this.busy = true;
    try {
      this.check();
      return await run();
    } finally {
      this.busy = false;
    }
  }

  private async save(next: InboxOperationRecord | null) {
    this.check();
    const result = await this.deps.store.compareExchange(
      await inboxOperationKey(this.deps.owner, this.deps.grantId),
      this.record,
      next,
    );
    this.check();
    if (result.status !== "saved")
      throw new Error(
        "Inbox operation changed. Reload its receipt before continuing.",
      );
    this.record = next;
    if (!next) this.unconfirmedSource = false;
  }

  async load(): Promise<InboxOperationRecord | null> {
    return this.exclusive(async () => {
      const value = await this.deps.store.read<InboxOperationRecord>(
        await inboxOperationKey(this.deps.owner, this.deps.grantId),
      );
      this.check();
      if (value && !validRecord(value, this.deps.owner, this.deps.grantId))
        throw new Error("Invalid saved Inbox operation");
      this.record = value;
      this.unconfirmedSource = false;
      // Cleanup that resumes after a reload acts on a receipt saved earlier.
      // Local copies are removed only when the provider still reports that
      // send; no receipt read, a failed read or a different answer keeps them.
      if (value && sentFromDraft(value))
        this.unconfirmedSource = !(await this.providerAgrees(value));
      return this.snapshot();
    });
  }

  private async providerAgrees(record: InboxOperationRecord) {
    if (
      typeof this.deps.client.gmailOperation !== "function" ||
      !record.receipt
    )
      return false;
    try {
      const receipt = await this.deps.client.gmailOperation(
        record.grantId,
        record.requestId,
        this.controller.signal,
      );
      this.check();
      return sameSend(record.receipt, receipt);
    } catch {
      this.check();
      return false;
    }
  }

  async prepare(
    proposal: Bag,
    source?: { draftId: string; savedRevision?: string },
  ): Promise<InboxOperationRecord | null> {
    return this.exclusive(async () => {
      if (this.record)
        throw new Error("Review the saved operation before starting another.");
      const clean = copy(proposal);
      if (
        new TextEncoder().encode(JSON.stringify(clean)).length >
        7.5 * 1024 * 1024
      )
        throw new Error("Message exceeds the supported review size");
      const draftId =
        source && typeof source.draftId === "string" && source.draftId
          ? source.draftId
          : null;
      // An acknowledged request id is never minted again.
      const acknowledged = (await this.acknowledged()).requestIds;
      this.check();
      let requestId = crypto.randomUUID();
      while (acknowledged.includes(requestId)) requestId = crypto.randomUUID();
      await this.save({
        version: 1,
        owner: this.deps.owner,
        grantId: this.deps.grantId,
        requestId,
        proposal: clean,
        phase: "preparing",
        review: null,
        receipt: null,
        ...(draftId && proposal.kind === "send"
          ? {
              source: {
                draftId,
                ...(typeof source?.savedRevision === "string" &&
                source.savedRevision
                  ? { savedRevision: source.savedRevision }
                  : {}),
              },
            }
          : {}),
        ...(draftId && composerKind(proposal.kind)
          ? { composer: { draftId } }
          : {}),
      });
      await this.reviewCurrent();
      return this.snapshot();
    });
  }

  /** Explicit review recovery is an idempotent prepare, never provider dispatch. */
  async reloadReview(): Promise<InboxOperationRecord | null> {
    return this.exclusive(async () => {
      if (this.record?.phase !== "preparing")
        throw new Error("Review recovery is unavailable");
      await this.reviewCurrent();
      return this.snapshot();
    });
  }

  private async reviewCurrent() {
    const record = this.record as InboxOperationRecord;
    const result = await this.deps.client.gmailPrepareOperation(
      record.grantId,
      record.requestId,
      record.proposal,
      this.controller.signal,
    );
    this.check();
    if (
      result.receipt.requestId !== record.requestId ||
      result.receipt.kind !== record.proposal.kind ||
      result.receipt.reviewDigest !==
        (await sha256Hex(JSON.stringify(result.review)))
    )
      throw new Error("Server review does not match its receipt");
    const review = result.review;
    for (const field of [
      "kind",
      "mode",
      "subject",
      "bodyText",
      "replyMessageId",
      "draftId",
      "expectedDigest",
      "messageId",
      "expectedHistoryId",
    ])
      if (
        record.proposal[field] !== undefined &&
        JSON.stringify(record.proposal[field]) !== JSON.stringify(review[field])
      )
        throw new Error(`Server changed the requested ${field}`);
    for (const field of ["to", "cc", "bcc"])
      if (
        record.proposal[field] !== undefined &&
        JSON.stringify(record.proposal[field]) !== JSON.stringify(review[field])
      )
        throw new Error("Server changed the reviewed recipients");
    if (typeof review.from !== "string" || !review.from)
      throw new Error("Unsupported sender");
    const attachments = record.proposal.attachments || [];
    if (!Array.isArray(attachments)) throw new Error("Unsupported attachments");
    checkOutgoingAttachments(attachments as OutgoingMailAttachment[]);
    if (attachments.length > 1 && !Array.isArray(review.attachments))
      throw new Error("This server cannot review more than one attachment");
    const checked = await Promise.all(
      (attachments as OutgoingMailAttachment[]).map(async (file) => {
        const { text: _text, ...metadata } =
          await this.deps.reviewAttachment(file);
        return metadata;
      }),
    );
    if (JSON.stringify(checked) !== JSON.stringify(review.attachments || []))
      throw new Error("Server changed the reviewed attachments");
    // Forwarded source attachments stay bound to the selected message and its historyId.
    const forward = record.proposal.forwardAttachments as
      | { messageId?: unknown; historyId?: unknown; partIds?: unknown }
      | undefined;
    if (forward !== undefined) {
      if (
        record.proposal.mode !== "forward" ||
        !forward ||
        typeof forward.messageId !== "string" ||
        typeof forward.historyId !== "string" ||
        !Array.isArray(forward.partIds) ||
        !forward.partIds.length ||
        forward.partIds.length > outgoingAttachmentLimits.maximumFiles ||
        forward.partIds.some((id) => typeof id !== "string")
      )
        throw new Error("Unsupported forwarded attachments");
      const reviewed = review.forwardedAttachments;
      if (
        !Array.isArray(reviewed) ||
        JSON.stringify(reviewed.map((row: Bag) => row?.partId)) !==
          JSON.stringify(forward.partIds) ||
        review.forwardSource == null ||
        JSON.stringify(review.forwardSource) !==
          JSON.stringify({
            messageId: forward.messageId,
            historyId: forward.historyId,
          }) ||
        reviewed.some(
          (row: Bag) =>
            typeof row.name !== "string" ||
            typeof row.size !== "number" ||
            !isDigest(row.sha256),
        )
      )
        throw new Error("Server changed the forwarded attachments");
      const total =
        checked.reduce((sum, file) => sum + file.size, 0) +
        reviewed.reduce(
          (sum: number, row: Bag) => sum + (row.size as number),
          0,
        );
      if (
        total > outgoingAttachmentLimits.maximumTotalBytes ||
        checked.length + reviewed.length > outgoingAttachmentLimits.maximumFiles
      )
        throw new Error("Attachments exceed the reviewed total limit");
    } else if (
      review.forwardedAttachments !== undefined &&
      JSON.stringify(review.forwardedAttachments) !== "[]"
    )
      throw new Error("Server added forwarded attachments");
    await this.save({
      ...record,
      review: copy(review),
      receipt: copy(result.receipt),
      phase: result.receipt.state === "prepared" ? "review" : "observed",
    });
  }

  /**
   * `current` is the email in the composer at the moment of the tap (null when
   * none is open). When it is given, a send or draft review is dispatched only
   * for that same email with exactly the reviewed content; the check and the
   * durable `dispatching` write have no await between the caller's read of the
   * composer and this comparison.
   */
  async confirm(
    current?: ComposerEmail | null,
  ): Promise<InboxOperationRecord | null> {
    return this.exclusive(async () => {
      const record = this.record;
      if (
        record?.phase !== "review" ||
        !record.review ||
        record.receipt?.state !== "prepared"
      )
        throw new Error("A fresh exact review is required");
      if (current !== undefined && composerKind(record.proposal.kind)) {
        const binding = reviewBinding(record, current);
        if (binding !== "bound") throw new Error(reviewBindingRefusal[binding]);
      }
      // Durable before the single network attempt. A lost write reply cannot cause dispatch.
      await this.save({
        ...record,
        phase: "dispatching",
        dispatchStartedAt: Date.now(),
      });
      this.check();
      let receipt: GmailInboxReceipt;
      try {
        receipt = await this.deps.client.gmailDispatchOperation(
          record.grantId,
          record.requestId,
          record.receipt.reviewDigest,
          record.proposal,
          this.controller.signal,
        );
      } catch (error) {
        this.check();
        await this.failedDispatch(error);
        return this.snapshot();
      }
      this.check();
      await this.observe(receipt);
      return this.snapshot();
    });
  }

  /**
   * A dispatch that failed is resolved by reading its receipt once, never by
   * sending again. Cloud's own 4xx refusal with the request still unclaimed
   * returns it to review, so a later Confirm dispatches the same reviewed
   * request. Any other failure stays dispatching until the receipt settles.
   */
  private async failedDispatch(error: unknown): Promise<void> {
    const record = this.record as InboxOperationRecord;
    const unresolved = timedOut(error)
      ? new Error(
          "Gmail did not answer in time, so the outcome is not known yet. Check the saved receipt; do not repeat this.",
        )
      : error;
    let receipt: GmailInboxReceipt;
    try {
      receipt = await this.deps.client.gmailOperation(
        record.grantId,
        record.requestId,
        this.controller.signal,
      );
    } catch {
      this.check();
      throw unresolved;
    }
    this.check();
    if (receipt.state === "prepared" && cloudRefusal(error)) {
      await this.observe(receipt);
      const { dispatchStartedAt: _started, ...rest } = this
        .record as InboxOperationRecord;
      await this.save({ ...rest, phase: "review" });
      throw error;
    }
    await this.observe(receipt);
    if (receipt.state === "prepared") throw unresolved;
  }

  /**
   * Discards a dispatch Cloud never claimed. Cloud cancels the request, so a
   * dispatch still on its way is refused; the slot is freed only when Cloud
   * reports the request cancelled. Anything else keeps the record as it is.
   */
  async discard(now = Date.now()): Promise<InboxOperationRecord | null> {
    return this.exclusive(async () => {
      const record = this.record;
      if (!record || !discardableDispatch(record, now))
        throw new Error(
          "Only a request Gmail has not received can be discarded.",
        );
      const client = this.deps.client;
      if (typeof client.gmailCancelOperation !== "function")
        throw new Error(UNRESOLVED);
      let receipt: GmailInboxReceipt;
      try {
        receipt = await client.gmailCancelOperation(
          record.grantId,
          record.requestId,
          this.controller.signal,
        );
      } catch (error) {
        this.check();
        // An older Cloud has no cancel: keep the request and today's advice.
        if (httpStatus(error) === 404) throw new Error(UNRESOLVED);
        throw error;
      }
      this.check();
      await this.observe(receipt);
      if (receipt.state === "rejected" && receipt.rejectionCode === "cancelled")
        await this.save(null);
      return this.snapshot();
    });
  }

  /**
   * The owner acknowledges an outcome Cloud has settled as unknown: the
   * request may have been carried out. Its request id is kept in a capped
   * history and the slot is freed. While Cloud can still settle the request
   * (prepared or dispatched) this is refused.
   */
  async acknowledge(): Promise<void> {
    return this.exclusive(async () => {
      const record = this.record;
      if (!record) return;
      const receipt = await this.deps.client.gmailOperation(
        record.grantId,
        record.requestId,
        this.controller.signal,
      );
      this.check();
      await this.observe(receipt);
      if (receipt.state === "succeeded" || receipt.state === "rejected") return;
      if (receipt.state !== "outcome-unknown")
        throw new Error(
          "Gmail is still settling this request. Check the saved receipt again in a few minutes; do not repeat it.",
        );
      await this.remember(record.requestId);
      await this.save(null);
    });
  }

  private async acknowledged(): Promise<AcknowledgedHistory> {
    const value = await this.deps.store.read<AcknowledgedHistory>(
      await inboxAcknowledgedKey(this.deps.owner, this.deps.grantId),
    );
    return validHistory(value) ? value : { version: 1, requestIds: [] };
  }

  /** Appends one request id, newest last, dropping the oldest past the limit. */
  private async remember(requestId: string): Promise<void> {
    const key = await inboxAcknowledgedKey(this.deps.owner, this.deps.grantId);
    for (let attempt = 0; attempt < 4; attempt++) {
      const stored = await this.deps.store.read<AcknowledgedHistory>(key);
      this.check();
      const ids = validHistory(stored) ? stored.requestIds : [];
      const next: AcknowledgedHistory = {
        version: 1,
        requestIds: [...ids.filter((id) => id !== requestId), requestId].slice(
          -INBOX_ACKNOWLEDGED_LIMIT,
        ),
      };
      if (
        (await this.deps.store.compareExchange(key, stored, next)).status ===
        "saved"
      )
        return;
    }
    throw new Error(
      "The acknowledgement could not be saved. Check the saved receipt and try again.",
    );
  }

  private async observe(receipt: GmailInboxReceipt) {
    const record = this.record as InboxOperationRecord;
    if (
      receipt.requestId !== record.requestId ||
      receipt.kind !== record.proposal.kind ||
      (record.receipt && receipt.reviewDigest !== record.receipt.reviewDigest)
    )
      throw new Error(
        "Gmail answered for a different request, so nothing was confirmed. Check the saved receipt before trying again; do not send this message again.",
      );
    // A prepared response after an attempted dispatch remains uncertain locally; never re-enable Send.
    await this.save({
      ...record,
      receipt: copy(receipt),
      phase:
        receipt.state === "prepared"
          ? record.phase === "dispatching"
            ? "dispatching"
            : record.review
              ? "review"
              : "preparing"
          : "observed",
    });
  }

  async refresh(): Promise<InboxOperationRecord | null> {
    return this.exclusive(async () => {
      if (!this.record) throw new Error("No saved operation");
      const prior = this.record.receipt,
        receipt = await this.deps.client.gmailOperation(
          this.record.grantId,
          this.record.requestId,
          this.controller.signal,
        );
      this.check();
      await this.observe(receipt);
      // A held cleanup proceeds once the provider, asked again, reports the same send as the saved receipt.
      if (this.unconfirmedSource && prior && sameSend(prior, receipt))
        this.unconfirmedSource = false;
      return this.snapshot();
    });
  }

  async clear(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.record) return;
      if (
        !["review", "preparing"].includes(this.record.phase) &&
        !["succeeded", "rejected"].includes(this.record.receipt?.state || "")
      )
        throw new Error(UNRESOLVED);
      await this.save(null);
    });
  }
}
