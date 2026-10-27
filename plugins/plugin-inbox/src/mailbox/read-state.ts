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
