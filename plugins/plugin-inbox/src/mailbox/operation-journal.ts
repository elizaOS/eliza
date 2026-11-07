/**
 * Durable journal for one reviewed managed-Gmail operation per owner and grant.
 *
 * Every effect is prepared (an idempotent server review) and then dispatched at
 * most once after an explicit confirmation. The `dispatching` phase is written
 * before the single network attempt, so a lost reply can never cause a second
 * dispatch: an uncertain outcome stays uncertain until the canonical receipt is
 * read back. No recovery path in this module dispatches an effect.
 *
 * The record layout and storage key (`inbox-operation:v1:<sha256([owner, grant])>`)
 * are installed-data identifiers; hosts keep existing records readable.
 */
import {
  checkOutgoingAttachments,
  type MailAttachmentReviewer,
  type OutgoingMailAttachment,
  outgoingAttachmentLimits,
} from "./attachments.ts";
import { sha256Hex } from "./digest.ts";
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

/** Storage key of the journal for one owner and grant. */
export async function inboxOperationKey(
  owner: string,
  grantId: string,
): Promise<string> {
  return `inbox-operation:v1:${await sha256Hex(JSON.stringify([owner, grantId]))}`;
}

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
      await this.save({
        version: 1,
        owner: this.deps.owner,
        grantId: this.deps.grantId,
        requestId: crypto.randomUUID(),
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
            typeof row.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(row.sha256),
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
      await this.save({ ...record, phase: "dispatching" });
      this.check();
      const receipt = await this.deps.client.gmailDispatchOperation(
        record.grantId,
        record.requestId,
        record.receipt.reviewDigest,
        record.proposal,
        this.controller.signal,
      );
      this.check();
      await this.observe(receipt);
      return this.snapshot();
    });
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
        throw new Error(
          "Outcome is unresolved. Check the existing receipt; do not repeat this message.",
        );
      await this.save(null);
    });
  }
}
