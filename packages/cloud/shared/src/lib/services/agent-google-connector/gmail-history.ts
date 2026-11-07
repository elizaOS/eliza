import { boundedProviderFetch } from "../../utils/bounded-provider-fetch";
import { fail, getGoogleAccessToken, getManagedGoogleConnectorStatus } from "./shared";

const root = "https://gmail.googleapis.com/gmail/v1/users/me";
const decimal = /^[1-9][0-9]{0,19}$/;
const opaque = /^[A-Za-z0-9_-]{1,256}$/;
const readScopes = new Set([
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.metadata",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://mail.google.com/",
]);
export interface GmailHistoryInput {
  organizationId: string;
  userId: string;
  grantId: string;
  /** Preserve this original watermark for every pageToken until the final checkpoint. */
  startHistoryId?: string;
  pageToken?: string;
  maxResults?: number;
}
export interface GmailHistoryEvent {
  id: string;
  historyId: string;
  type: "message-added" | "message-deleted" | "labels-added" | "labels-removed";
  messageId: string;
  threadId: string;
  labelIds: string[];
  /** Added messages are hydrated at read time; false means Gmail returned message 404. */
  messageAvailable?: boolean;
}
export interface GmailHistoryPage {
  version: 1;
  grantId: string;
  status: "baseline-required" | "reset-required" | "page";
  startHistoryId: string | null;
  historyId: string | null;
  checkpoint: string | null;
  nextPageToken: string | null;
  events: GmailHistoryEvent[];
  backfillRequired: boolean;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(502, "Invalid Gmail history payload.");
  return value as Record<string, unknown>;
}
function historyId(value: unknown): string {
  if (typeof value !== "string" || !decimal.test(value))
    fail(502, "Invalid Gmail history revision.");
  return value;
}
/** Owner-only metadata read. No Google grant creation, mailbox mutation, or server checkpoint write.
 * Consumers persist events before committing checkpoint, which exists only on the final page.
 * Profile baselines and expired history explicitly require full reconciliation, never imply it ran.
 */
export async function fetchManagedGoogleGmailHistory(
  input: GmailHistoryInput,
): Promise<GmailHistoryPage> {
  if (!input.grantId || input.grantId.length > 128 || !opaque.test(input.grantId))
    fail(400, "Explicit Google grant required.");
  if (input.startHistoryId !== undefined && !decimal.test(input.startHistoryId))
    fail(400, "Invalid startHistoryId.");
  if (
    input.pageToken !== undefined &&
    (!input.startHistoryId || !input.pageToken || input.pageToken.length > 4096)
  )
    fail(400, "Invalid Gmail history page token.");
  const maxResults = input.maxResults ?? 50;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100)
    fail(400, "maxResults must be between 1 and 100.");
  const scope = {
    organizationId: input.organizationId,
    userId: input.userId,
    grantId: input.grantId,
    side: "owner" as const,
  };
  const deadline = Date.now() + 25_000;
  const remainingBudget = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail(502, "Gmail history request deadline exceeded.");
    return remaining;
  };
  const authorize = async () => {
    const status = await getManagedGoogleConnectorStatus(scope);
    remainingBudget();
    if (
      !status.connected ||
      status.connectionId !== input.grantId ||
      !status.grantedScopes.some((value) => readScopes.has(value))
    )
      fail(409, "Selected Google account needs Gmail read access.");
  };
  await authorize();
  const credential = await getGoogleAccessToken(scope);
  await authorize(); // Token refresh can await; recheck the grant before provider dispatch.
  const base: GmailHistoryPage = {
    version: 1,
    grantId: input.grantId,
    status: "reset-required",
    startHistoryId: input.startHistoryId ?? null,
    historyId: null,
    checkpoint: null,
    nextPageToken: null,
    events: [],
    backfillRequired: true,
  };
  const params = new URLSearchParams({
    maxResults: String(maxResults),
    startHistoryId: input.startHistoryId ?? "",
  });
  if (input.pageToken) params.set("pageToken", input.pageToken);
  let response: Response;
  try {
    response = await boundedProviderFetch(
      input.startHistoryId ? `${root}/history?${params}` : `${root}/profile?fields=historyId`,
      { method: "GET", headers: { Authorization: `Bearer ${credential.accessToken}` } },
      {
        provider: "google-gmail-history",
        timeoutMs: remainingBudget(),
        maxResponseBytes: 1024 * 1024,
      },
    );
  } catch {
    // error-policy:J1 provider transport/bounds failures are explicit, never empty history.
    fail(502, "Gmail history request failed.");
  }
  // Only an actual provider history 404 is a reset. Missing/revoked grants fail authorization.
  if (input.startHistoryId && response.status === 404) {
    await authorize();
    return base;
  }
  if (!response.ok) fail(502, "Gmail history request failed.");
  let data: Record<string, unknown>;
  try {
    data = object(await response.json());
  } catch {
    fail(502, "Invalid Gmail history JSON.");
  }
  await authorize(); // Revocation/account removal during provider I/O exposes no old-owner metadata.
  const current = historyId(data.historyId);
  if (!input.startHistoryId) return { ...base, status: "baseline-required", historyId: current };
  if (BigInt(current) < BigInt(input.startHistoryId))
    fail(502, "Gmail history revision moved backwards.");
  const next = data.nextPageToken;
  if (
    next !== undefined &&
    (typeof next !== "string" || !next || next.length > 4096 || next === input.pageToken)
  )
    fail(502, "Invalid Gmail history continuation.");
  const rows = data.history ?? [];
  if (!Array.isArray(rows) || rows.length > maxResults) fail(502, "Invalid Gmail history page.");
  const events: GmailHistoryEvent[] = [];
  let previous = BigInt(input.startHistoryId);
  const fields = {
    messagesAdded: "message-added",
    messagesDeleted: "message-deleted",
    labelsAdded: "labels-added",
    labelsRemoved: "labels-removed",
  } as const;
  for (const entry of rows) {
    const row = object(entry),
      revision = historyId(row.id);
    if (BigInt(revision) <= previous || BigInt(revision) > BigInt(current))
      fail(502, "Unordered Gmail history page.");
    previous = BigInt(revision);
    const seen = new Set<string>();
    for (const [field, type] of Object.entries(fields)) {
      const changes = row[field] ?? [];
      if (!Array.isArray(changes)) fail(502, "Invalid Gmail history changes.");
      for (const change of changes) {
        const detail = object(change),
          message = object(detail.message);
        if (
          typeof message.id !== "string" ||
          !opaque.test(message.id) ||
          typeof message.threadId !== "string" ||
          !opaque.test(message.threadId)
        )
          fail(502, "Invalid Gmail history message identity.");
        const labels = detail.labelIds ?? message.labelIds ?? [];
        if (
          !Array.isArray(labels) ||
          labels.length > 100 ||
          labels.some((value) => typeof value !== "string" || !opaque.test(value))
        )
          fail(502, "Invalid Gmail history labels.");
        const id = `${revision}:${type}:${message.id}`;
        if (seen.has(id)) fail(502, "Duplicate Gmail history event.");
        seen.add(id);
        events.push({
          id,
          historyId: revision,
          type,
          messageId: message.id,
          threadId: message.threadId,
          labelIds: [...new Set(labels)] as string[],
        });
        if (events.length > 2000) fail(502, "Gmail history page exceeds the event limit.");
      }
    }
    if (!seen.size && Array.isArray(row.messages) && row.messages.length)
      fail(502, "Gmail history contains an unclassified change.");
  }
  // History normally contains only message identity. Read current labels before consumers
  // classify inbox/unread additions; never mistake missing labels for an empty mailbox state.
  const additions = events.filter((event) => event.type === "message-added");
  const identities = new Map(additions.map((event) => [event.messageId, event.threadId]));
  if (additions.some((event) => identities.get(event.messageId) !== event.threadId))
    fail(502, "Inconsistent Gmail history message identity.");
  if (identities.size > 100) fail(502, "Gmail history page exceeds the metadata read limit.");
  const metadata = new Map<string, { labelIds: string[]; messageAvailable: boolean }>();
  for (const [id, threadId] of identities) {
    await authorize();
    const remaining = remainingBudget();
    let messageResponse: Response;
    try {
      messageResponse = await boundedProviderFetch(
        `${root}/messages/${encodeURIComponent(id)}?format=minimal&fields=id,threadId,labelIds`,
        { method: "GET", headers: { Authorization: `Bearer ${credential.accessToken}` } },
        {
          provider: "google-gmail-history-metadata",
          timeoutMs: remaining,
          maxResponseBytes: 16_384,
        },
      );
    } catch {
      fail(502, "Gmail history metadata request failed.");
    }
    await authorize();
    if (messageResponse.status === 404) {
      // It disappeared after its history addition. Retain its stable event, but never notify it.
      metadata.set(id, { labelIds: [], messageAvailable: false });
      continue;
    }
    if (!messageResponse.ok) fail(502, "Gmail history metadata request failed.");
    let message: Record<string, unknown>;
    try {
      message = object(await messageResponse.json());
    } catch {
      fail(502, "Invalid Gmail history metadata JSON.");
    }
    const labels = message.labelIds ?? [];
    if (
      message.id !== id ||
      message.threadId !== threadId ||
      !Array.isArray(labels) ||
      labels.length > 100 ||
      labels.some((value) => typeof value !== "string" || !opaque.test(value))
    )
      fail(502, "Invalid Gmail history metadata.");
    metadata.set(id, { labelIds: [...new Set(labels)] as string[], messageAvailable: true });
  }
  await authorize();
  for (const event of additions) Object.assign(event, metadata.get(event.messageId));
  return {
    ...base,
    status: "page",
    historyId: current,
    checkpoint: next ? null : current,
    nextPageToken: typeof next === "string" ? next : null,
    events,
    backfillRequired: false,
  };
}
