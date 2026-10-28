/** Reviewed read/unread state through the managed inbox-v1 operation routes. */
import { sha256Hex } from "./digest.ts";
import type { GmailInboxReceipt } from "./types.ts";

export interface GmailReadStateClient {
  gmailPrepareOperation(
    grant: string,
    request: string,
    proposal: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ receipt: GmailInboxReceipt; review: Record<string, unknown> }>;
  gmailDispatchOperation(
    grant: string,
    request: string,
    digest: string,
    proposal: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<GmailInboxReceipt>;
}

/**
 * Marks one loaded message read or unread through the reviewed inbox-v1
 * operation. The label change is idempotent, so it does not use the durable
 * send/draft review slot, but it is still dispatched exactly once: an uncertain
 * outcome returns null and is never repeated here.
 */
export async function setGmailReadState(
  client: GmailReadStateClient,
  grantId: string,
  input: { messageId: string; expectedHistoryId: string; unread: boolean },
  signal: AbortSignal,
): Promise<{ unread: boolean; historyId: string | null } | null> {
  const requestId = crypto.randomUUID(),
    kind = input.unread ? "mark-unread" : "mark-read";
  const proposal = {
    kind,
    messageId: input.messageId,
    expectedHistoryId: input.expectedHistoryId,
  };
  const prepared = await client.gmailPrepareOperation(
    grantId,
    requestId,
    proposal,
    signal,
  );
  const review = prepared.review;
  if (
    prepared.receipt.requestId !== requestId ||
    prepared.receipt.kind !== kind ||
    prepared.receipt.state !== "prepared" ||
    review.kind !== kind ||
    review.messageId !== input.messageId ||
    review.expectedHistoryId !== input.expectedHistoryId ||
    prepared.receipt.reviewDigest !== (await sha256Hex(JSON.stringify(review)))
  )
    throw new Error("Server review does not match the requested read state");
  signal.throwIfAborted();
  const receipt = await client.gmailDispatchOperation(
    grantId,
    requestId,
    prepared.receipt.reviewDigest,
    proposal,
    signal,
  );
  if (receipt.requestId !== requestId || receipt.kind !== kind)
    throw new Error("Unexpected read-state receipt");
  if (receipt.state !== "succeeded") return null;
  const result = receipt.providerResult;
  if (
    !result ||
    result.messageId !== input.messageId ||
    result.unread !== input.unread
  )
    return null;
  return {
    unread: input.unread,
    historyId: typeof result.historyId === "string" ? result.historyId : null,
  };
}

export type MailReadStateOutcome =
  /** A change for this message is already in flight; nothing was sent. */
  | { status: "busy" }
  /** An automatic mark-read whose earlier outcome was not confirmed; nothing was sent. */
  | { status: "skipped" }
  /** Sent once, but Gmail's result was not confirmed. */
  | { status: "unconfirmed" }
  /** Sent and failed or was interrupted; it may still have reached Gmail. */
  | { status: "failed"; error: unknown }
  | { status: "changed"; unread: boolean; historyId: string | null };

/**
 * Read-state changes for one mailbox view. One change per message may be in
 * flight, and an automatic mark-read (opening a message) whose outcome was not
 * confirmed is never sent again for that message; only the owner's explicit
 * change may try again, after a refresh shows the current state.
 */
export class MailReadStateGuard {
  private readonly inFlight = new Set<string>();
  private readonly unconfirmed = new Set<string>();

  async set(
    client: GmailReadStateClient,
    grantId: string,
    input: { messageId: string; expectedHistoryId: string; unread: boolean },
    explicit: boolean,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<MailReadStateOutcome> {
    const key = JSON.stringify([grantId, input.messageId]);
    if (this.inFlight.has(key)) return { status: "busy" };
    if (!explicit && this.unconfirmed.has(key)) return { status: "skipped" };
    this.inFlight.add(key);
    try {
      const result = await setGmailReadState(client, grantId, input, signal);
      if (!result) {
        this.unconfirmed.add(key);
        return { status: "unconfirmed" };
      }
      this.unconfirmed.delete(key);
      return { status: "changed", ...result };
    } catch (error) {
      // Any failure may have reached Gmail.
      this.unconfirmed.add(key);
      return { status: "failed", error };
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Forgets every message, for example after the account or Cloud session changed. */
  clear(): void {
    this.inFlight.clear();
    this.unconfirmed.clear();
  }
}

/**
 * What to tell the owner after an explicit change. `failure` classifies a
 * failed request (for example `classifyGmailFailure(error, "operation")`).
 * Automatic changes stay silent.
 */
export function mailReadStateMessage(
  outcome: MailReadStateOutcome,
  unread: boolean,
  failure: (error: unknown) => string,
): string | null {
  switch (outcome.status) {
    case "busy":
      return "A read-state change for this message is still in progress.";
    case "skipped":
      return null;
    case "unconfirmed":
      return "Read state was not confirmed. Refresh to check it before trying again.";
    case "failed":
      return failure(outcome.error);
    case "changed":
      return unread ? "Marked unread in Gmail" : "Marked read in Gmail";
  }
}
