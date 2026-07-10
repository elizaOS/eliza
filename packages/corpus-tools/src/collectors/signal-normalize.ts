/**
 * Signal `messages` row → canonical `CorpusMessage` normalization. Signal keeps
 * the authoritative message content in the row's `json` column (an object with
 * `body`, `sent_at`, `type`, `source`, `conversationId`, …); the top-level SQL
 * columns are a partial denormalization that is often null. This module reads
 * the JSON first and falls back to the columns, so the mapping is faithful to
 * how Signal Desktop actually stores a message rather than to the subset SQLite
 * happens to project.
 *
 * Direction, sender identity, and thread id are derived structurally. Rows with
 * no readable body (reactions, attachment-only, group-membership events) are not
 * fabricated into empty-text messages — the schema requires non-empty text, so
 * the caller drops them and counts them as skipped. Attachment bytes are out of
 * scope for this collector.
 */
import {
  CORPUS_CUTOFF_MS,
  type CorpusDirection,
  type CorpusMessage,
} from "../schema.ts";
import type { SignalMessageRow } from "./signal-db.ts";

interface SignalMessageJson {
  body?: unknown;
  sent_at?: unknown;
  received_at?: unknown;
  timestamp?: unknown;
  type?: unknown;
  source?: unknown;
  sourceServiceId?: unknown;
  conversationId?: unknown;
}

export interface NormalizeSignalOptions {
  /** Stable label for the owner's linked account, e.g. "primary". */
  accountId: string;
  /** Owner's own sender id used for outgoing messages. */
  ownerId: string;
  /** Owner's display name used for outgoing messages. */
  ownerDisplay: string;
}

export type SkipReason = "empty-body" | "before-cutoff" | "no-timestamp";

export interface NormalizedSignalMessage {
  message?: CorpusMessage;
  skipped?: SkipReason;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseJson(raw: string | null): SignalMessageJson {
  if (!raw) return {};
  // error-policy:J3 the json column is untrusted export content; a parse
  // failure degrades to the SQL columns rather than throwing away the row.
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as SignalMessageJson)
      : {};
  } catch {
    return {};
  }
}

function directionFromType(type: string | undefined): CorpusDirection | null {
  if (type === "outgoing") return "out";
  if (type === "incoming") return "in";
  return null;
}

/**
 * Normalize a single Signal row. Returns either a `CorpusMessage` or a skip
 * reason; it never returns a message with fabricated empty text or a timestamp
 * before the corpus cutoff. The `id` is prefixed with the account so ids stay
 * unique across a multi-account merge.
 */
export function normalizeSignalRow(
  row: SignalMessageRow,
  options: NormalizeSignalOptions,
): NormalizedSignalMessage {
  const json = parseJson(row.json);

  const direction = directionFromType(
    asString(row.type) ?? asString(json.type),
  );
  if (!direction) return { skipped: "empty-body" };

  const body = asString(row.body) ?? asString(json.body);
  if (!body) return { skipped: "empty-body" };

  const ts =
    asNumber(row.received_at) ??
    asNumber(json.received_at) ??
    asNumber(row.sent_at) ??
    asNumber(json.sent_at) ??
    asNumber(json.timestamp);
  if (ts === undefined) return { skipped: "no-timestamp" };
  if (ts < CORPUS_CUTOFF_MS) return { skipped: "before-cutoff" };

  const threadId =
    asString(row.conversationId) ??
    asString(json.conversationId) ??
    `signal-unknown-thread`;

  const peerDisplay =
    asString(row.conversationName) ??
    asString(row.conversationE164) ??
    asString(row.conversationServiceId) ??
    threadId;
  const peerId =
    asString(row.source) ??
    asString(json.source) ??
    asString(row.sourceServiceId) ??
    asString(json.sourceServiceId) ??
    asString(row.conversationServiceId) ??
    threadId;

  // The peer is always the other party in the thread; the owner is the local
  // account. Direction only decides which of the two is sender vs. recipient,
  // so identity stays symmetric between an inbound and its outbound reply.
  const senderId = direction === "out" ? options.ownerId : peerId;
  const senderDisplay =
    direction === "out" ? options.ownerDisplay : peerDisplay;
  const recipientId = direction === "out" ? peerId : options.ownerId;
  const recipientDisplay =
    direction === "out" ? peerDisplay : options.ownerDisplay;

  const message: CorpusMessage = {
    id: `signal:${options.accountId}:${row.id}`,
    platform: "signal",
    accountId: options.accountId,
    threadId: `signal:${options.accountId}:${threadId}`,
    ts,
    direction,
    senderId,
    senderDisplay,
    recipients: [{ id: recipientId, display: recipientDisplay }],
    text: body,
    labels: [],
    attachments: [],
    scrubState: "raw",
  };

  return { message };
}
