import { createHash } from "node:crypto";
import type { GmailInboxReceipt } from "../../../../../plugins/plugin-inbox/src/mailbox/types.ts";
import {
  CloudProtocolError,
  type ManagedGoogleClient,
} from "./managed-google-client.ts";
export type AgentMailboxChange = {
  messageId: string;
  kind: "archive" | "trash" | "mark-read" | "mark-unread";
  requestId: string;
};
/** Stable caller-turn identity reaches the durable provider ledger before a mutation.
 * A lost response reads that receipt once; an uncertain state is never dispatched again. */
export async function gmailAgentMailbox(
  client: ManagedGoogleClient,
  grantId: string,
  scope: string,
  input: AgentMailboxChange,
  signal: AbortSignal,
) {
  const prefix = `alpha-gmail:${scope}:`,
    providerId = input.messageId.slice(prefix.length);
  if (
    !input.messageId.startsWith(prefix) ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(providerId) ||
    !["archive", "trash", "mark-read", "mark-unread"].includes(input.kind) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      input.requestId,
    )
  )
    throw Error(
      "Select an exact message from the current Gmail owner account.",
    );
  const outcome = (receipt: GmailInboxReceipt) => {
    if (receipt.requestId !== input.requestId || receipt.kind !== input.kind)
      throw Error("Mailbox receipt belongs to another operation.");
    if (receipt.state !== "succeeded")
      return {
        requestId: input.requestId,
        kind: input.kind,
        messageId: input.messageId,
        ok: false,
      };
    const result = receipt.providerResult,
      labels = result?.labelIds;
    if (
      result?.messageId !== providerId ||
      !Array.isArray(labels) ||
      !labels.every((x) => typeof x === "string") ||
      (input.kind === "archive" && labels.includes("INBOX")) ||
      (input.kind === "trash" && !labels.includes("TRASH")) ||
      (input.kind === "mark-read" &&
        (labels.includes("UNREAD") || result.unread !== false)) ||
      (input.kind === "mark-unread" &&
        (!labels.includes("UNREAD") || result.unread !== true))
    )
      throw Error(
        "Provider labels did not verify the requested mailbox change.",
      );
    return {
      requestId: input.requestId,
      kind: input.kind,
      messageId: input.messageId,
      ok: true,
    };
  };
  let prior: GmailInboxReceipt | undefined;
  try {
    prior = await client.gmailOperation(grantId, input.requestId, signal);
  } catch (error) {
    if (
      !(
        error instanceof CloudProtocolError &&
        error.code === "http" &&
        error.status === 404 &&
        error.data &&
        typeof error.data === "object" &&
        !Array.isArray(error.data) &&
        (error.data as Record<string, unknown>).error === "Operation not found"
      )
    )
      throw error;
  }
  if (prior) {
    if (prior.kind !== input.kind)
      throw Error("Mailbox request is bound to another operation.");
    if (prior.state !== "prepared") return outcome(prior);
  }
  const selected = await client.gmailRead(grantId, providerId, signal);
  if (!selected.historyId)
    throw Error("The current Gmail message revision is unavailable.");
  const proposal = {
    kind: input.kind,
    messageId: providerId,
    expectedHistoryId: selected.historyId,
  };
  const prepared = await client.gmailPrepareOperation(
      grantId,
      input.requestId,
      proposal,
      signal,
    ),
    review = prepared.review;
  if (
    prepared.receipt.requestId !== input.requestId ||
    prepared.receipt.kind !== input.kind ||
    prepared.receipt.state !== "prepared" ||
    review.kind !== input.kind ||
    review.messageId !== providerId ||
    review.expectedHistoryId !== selected.historyId ||
    typeof review.from !== "string" ||
    !review.from ||
    prepared.receipt.reviewDigest !==
      createHash("sha256").update(JSON.stringify(review)).digest("hex")
  )
    throw Error("The mailbox review changed. Nothing was dispatched.");
  const grants = await client.gmailAccounts(signal);
  if (
    !grants.some(
      (a) =>
        a.connectionId === grantId &&
        a.connected &&
        a.grantedCapabilities.includes("google.gmail.mailbox"),
    )
  )
    throw Error("Gmail mailbox permission changed before dispatch.");
  signal.throwIfAborted();
  try {
    return outcome(
      await client.gmailDispatchOperation(
        grantId,
        input.requestId,
        prepared.receipt.reviewDigest,
        proposal,
        signal,
      ),
    );
  } catch (error) {
    signal.throwIfAborted();
    try {
      return outcome(
        await client.gmailOperation(grantId, input.requestId, signal),
      );
    } catch {
      throw error;
    }
  }
}
