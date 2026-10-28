/** Optional private host transport for owner-only Inbox Gmail reads.
 * The host retains provider credentials. This source never sends or changes mail. */
import { ElizaError } from "@elizaos/core";
import type { InboxFetcher, InboxItem } from "../actions/inbox.ts";
import { managedGmailHostTransport } from "./managed-gmail-transport.ts";

const failure = (message: string) =>
  new ElizaError(message, { code: "MANAGED_GMAIL_READ_UNAVAILABLE" });
export function managedGmailReadFetcher(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): InboxFetcher | undefined {
  const call = managedGmailHostTransport(
    env.ELIZA_MANAGED_GMAIL_READ_BROKER,
    env.ELIZA_API_TOKEN,
    request,
  );
  if (!call) return undefined;
  return async ({ limit = 25, query, since }) => {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 51 ||
      (query !== undefined &&
        (typeof query !== "string" || query.length > 4096)) ||
      (since !== undefined &&
        (typeof since !== "string" || !Number.isFinite(Date.parse(since))))
    )
      throw failure(
        "Choose a valid Gmail read range of at most 50 messages plus one overflow probe.",
      );
    const data = await call({
      limit,
      ...(query === undefined ? {} : { query }),
      ...(since === undefined ? {} : { since }),
    });
    if (!Array.isArray(data.items) || data.items.length > limit)
      throw failure("The Gmail host returned an invalid message list.");
    const ids = new Set<string>();
    return data.items.map((value: unknown): InboxItem => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw failure("Invalid Gmail message.");
      const row = value as Record<string, unknown>;
      for (const key of [
        "id",
        "channel",
        "senderName",
        "snippet",
        "receivedAt",
      ])
        if (typeof row[key] !== "string")
          throw failure("Invalid Gmail message fields.");
      if (
        row.platform !== "gmail" ||
        typeof row.id !== "string" ||
        !row.id ||
        ids.has(row.id) ||
        !Number.isFinite(Date.parse(row.receivedAt as string)) ||
        (row.threadTopic !== undefined &&
          typeof row.threadTopic !== "string") ||
        (row.unread !== undefined && typeof row.unread !== "boolean") ||
        (row.senderIdentifier !== undefined &&
          typeof row.senderIdentifier !== "string")
      )
        throw failure("Invalid Gmail message identity.");
      ids.add(row.id);
      return {
        id: row.id,
        platform: "gmail",
        channel: row.channel as string,
        senderName: row.senderName as string,
        ...(row.senderIdentifier === undefined
          ? {}
          : { senderIdentifier: row.senderIdentifier as string }),
        snippet: row.snippet as string,
        receivedAt: row.receivedAt as string,
        ...(row.threadTopic === undefined
          ? {}
          : { threadTopic: row.threadTopic as string }),
        ...(row.unread === undefined ? {} : { unread: row.unread as boolean }),
      };
    });
  };
}
export function managedGmailMessageReader(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
) {
  const call = managedGmailHostTransport(
    env.ELIZA_MANAGED_GMAIL_READ_BROKER,
    env.ELIZA_API_TOKEN,
    request,
  );
  if (!call) return undefined;
  return async (messageId: string) => {
    if (!/^alpha-gmail:[a-f0-9]{64}:[A-Za-z0-9_-]{1,160}$/.test(messageId))
      throw failure(
        "Select an exact message from the current Gmail list or search.",
      );
    const data = await call({ messageId });
    if (
      !data.message ||
      typeof data.message !== "object" ||
      Array.isArray(data.message)
    )
      throw failure("The Gmail host returned an invalid message.");
    const row = data.message as Record<string, unknown>;
    if (
      row.id !== messageId ||
      typeof row.from !== "string" ||
      typeof row.subject !== "string" ||
      typeof row.bodyText !== "string" ||
      typeof row.receivedAt !== "string" ||
      !Number.isFinite(Date.parse(row.receivedAt)) ||
      typeof row.hasAttachments !== "boolean" ||
      typeof row.unread !== "boolean"
    )
      throw failure("The Gmail message did not match the selected source.");
    return {
      id: messageId,
      from: row.from,
      subject: row.subject,
      bodyText: row.bodyText,
      receivedAt: row.receivedAt,
      hasAttachments: row.hasAttachments,
      unread: row.unread,
    };
  };
}
