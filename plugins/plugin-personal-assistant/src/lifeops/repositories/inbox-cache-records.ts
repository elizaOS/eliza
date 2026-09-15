/** Defines and parses inbox cache records for the host persistence adapter, preserving canonical domain contracts. */
import {
  LIFEOPS_INBOX_CHANNELS,
  type LifeOpsInboxChannel,
  type LifeOpsInboxMessage,
} from "../../contracts/index.js";
import {
  parseJsonArray,
  parseJsonRecord,
  toBoolean,
  toNumber,
  toText,
} from "../sql.js";

export interface LifeOpsCachedInboxMessage extends LifeOpsInboxMessage {
  cachedAt: string;
  updatedAt: string;
  priorityFlags: string[];
}

export type LifeOpsInboxCacheWriteMessage = LifeOpsInboxMessage & {
  priorityFlags?: readonly string[];
};

// Finance tables were carved out of plugin-personal-assistant into
// @elizaos/plugin-finances and now live under the `app_finances` PostgreSQL
// schema. The raw SQL against those tables moved with them into
// `FinancesRepository`; the finance methods below delegate to a shared
// FinancesRepository instance so the subscriptions mixin keeps reaching them
// through `this.repository`.

export const LIFEOPS_INBOX_CHANNEL_SET = new Set<LifeOpsInboxChannel>(
  LIFEOPS_INBOX_CHANNELS,
);

export const LIFEOPS_INBOX_CHAT_TYPES = new Set<
  NonNullable<LifeOpsInboxMessage["chatType"]>
>(["dm", "group", "channel"]);

export const LIFEOPS_INBOX_PRIORITY_CATEGORIES = new Set<
  NonNullable<LifeOpsInboxMessage["priorityCategory"]>
>(["important", "planning", "casual"]);

export function normalizeInboxChatType(
  channel: LifeOpsInboxChannel,
  value: unknown,
  participantCount: number | undefined,
): NonNullable<LifeOpsInboxMessage["chatType"]> {
  if (typeof value === "string" && value.trim().length > 0) {
    const normalized = value.trim().toLowerCase();
    if (
      LIFEOPS_INBOX_CHAT_TYPES.has(
        normalized as NonNullable<LifeOpsInboxMessage["chatType"]>,
      )
    ) {
      return normalized as NonNullable<LifeOpsInboxMessage["chatType"]>;
    }
    throw new Error(`[LifeOpsRepository] invalid inbox chat type: ${value}`);
  }
  if (channel === "gmail") return "dm";
  if (typeof participantCount === "number") {
    return participantCount > 2 ? "group" : "dm";
  }
  return "channel";
}

export function normalizeInboxChannelValue(
  value: unknown,
  label = "inbox channel",
): LifeOpsInboxChannel {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (LIFEOPS_INBOX_CHANNEL_SET.has(normalized as LifeOpsInboxChannel)) {
      return normalized as LifeOpsInboxChannel;
    }
  }
  throw new Error(`[LifeOpsRepository] invalid ${label}: ${String(value)}`);
}

export function requireInboxExternalId(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new Error(`[LifeOpsRepository] missing ${label}`);
}

export function parseCachedInboxSourceRef(
  value: unknown,
  channel: LifeOpsInboxChannel,
  externalId: string,
): LifeOpsInboxMessage["sourceRef"] {
  const sourceRef = parseJsonRecord(value);
  const sourceRefChannel =
    sourceRef.channel === undefined || sourceRef.channel === null
      ? channel
      : normalizeInboxChannelValue(
          sourceRef.channel,
          "inbox sourceRef channel",
        );
  if (sourceRefChannel !== channel) {
    throw new Error(
      `[LifeOpsRepository] inbox sourceRef channel ${sourceRefChannel} does not match row channel ${channel}`,
    );
  }
  return {
    channel: sourceRefChannel,
    externalId:
      sourceRef.externalId === undefined || sourceRef.externalId === null
        ? externalId
        : requireInboxExternalId(
            sourceRef.externalId,
            "inbox sourceRef externalId",
          ),
    ...(typeof sourceRef.phoneAccountId === "string" &&
    sourceRef.phoneAccountId.trim().length > 0
      ? { phoneAccountId: sourceRef.phoneAccountId.trim() }
      : {}),
    ...(typeof sourceRef.phoneAccountLabel === "string" &&
    sourceRef.phoneAccountLabel.trim().length > 0
      ? { phoneAccountLabel: sourceRef.phoneAccountLabel.trim() }
      : {}),
    ...(typeof sourceRef.phoneNumber === "string" &&
    sourceRef.phoneNumber.trim().length > 0
      ? { phoneNumber: sourceRef.phoneNumber.trim() }
      : {}),
  };
}

export function normalizeInboxWriteSourceRef(
  sourceRef: LifeOpsInboxMessage["sourceRef"],
  channel: LifeOpsInboxChannel,
): LifeOpsInboxMessage["sourceRef"] {
  const sourceRefChannel = normalizeInboxChannelValue(
    sourceRef.channel,
    "inbox sourceRef channel",
  );
  if (sourceRefChannel !== channel) {
    throw new Error(
      `[LifeOpsRepository] inbox sourceRef channel ${sourceRefChannel} does not match message channel ${channel}`,
    );
  }
  return {
    channel: sourceRefChannel,
    externalId: requireInboxExternalId(
      sourceRef.externalId,
      "inbox sourceRef externalId",
    ),
    ...(typeof sourceRef.phoneAccountId === "string" &&
    sourceRef.phoneAccountId.trim().length > 0
      ? { phoneAccountId: sourceRef.phoneAccountId.trim() }
      : {}),
    ...(typeof sourceRef.phoneAccountLabel === "string" &&
    sourceRef.phoneAccountLabel.trim().length > 0
      ? { phoneAccountLabel: sourceRef.phoneAccountLabel.trim() }
      : {}),
    ...(typeof sourceRef.phoneNumber === "string" &&
    sourceRef.phoneNumber.trim().length > 0
      ? { phoneNumber: sourceRef.phoneNumber.trim() }
      : {}),
  };
}

export function normalizeInboxPriorityCategory(
  value: unknown,
): LifeOpsInboxMessage["priorityCategory"] {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("[LifeOpsRepository] invalid inbox priority category");
  }
  const normalized = value.trim().toLowerCase();
  if (
    LIFEOPS_INBOX_PRIORITY_CATEGORIES.has(
      normalized as NonNullable<LifeOpsInboxMessage["priorityCategory"]>,
    )
  ) {
    return normalized as NonNullable<LifeOpsInboxMessage["priorityCategory"]>;
  }
  throw new Error(
    `[LifeOpsRepository] invalid inbox priority category: ${value}`,
  );
}

export function normalizeInboxPriorityFlags(
  flags: readonly string[] | undefined,
): string[] {
  if (!flags) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const flag of flags) {
    const normalized = flag.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function hasOwnPriorityFlags(
  message: LifeOpsInboxCacheWriteMessage,
): boolean {
  return Object.hasOwn(message, "priorityFlags");
}

export function parseCachedInboxMessage(
  row: Record<string, unknown>,
): LifeOpsCachedInboxMessage {
  const channel = normalizeInboxChannelValue(row.channel);
  const externalId = requireInboxExternalId(
    row.external_id,
    "inbox external_id",
  );
  const priorityScore =
    row.priority_score === null || row.priority_score === undefined
      ? undefined
      : toNumber(row.priority_score);
  const priorityCategory =
    row.priority_category === null || row.priority_category === undefined
      ? undefined
      : toText(row.priority_category);
  const participantCount =
    row.participant_count === null || row.participant_count === undefined
      ? undefined
      : toNumber(row.participant_count);
  const chatType = normalizeInboxChatType(
    channel,
    row.chat_type,
    participantCount,
  );
  const sourceRef = parseCachedInboxSourceRef(
    row.source_ref_json,
    channel,
    externalId,
  );
  const flags = parseJsonArray<string>(row.priority_flags_json).filter(
    (flag): flag is string => typeof flag === "string",
  );
  return {
    id: toText(row.id),
    channel,
    sender: {
      id: toText(row.sender_id),
      displayName: toText(row.sender_display),
      email: row.sender_email ? toText(row.sender_email) : null,
      avatarUrl: null,
    },
    subject: row.subject ? toText(row.subject) : null,
    snippet: toText(row.snippet),
    receivedAt: toText(row.received_at),
    unread: toBoolean(row.is_unread),
    deepLink: row.deep_link ? toText(row.deep_link) : null,
    sourceRef,
    threadId: row.thread_id ? toText(row.thread_id) : undefined,
    chatType,
    participantCount,
    gmailAccountId: row.gmail_account_id
      ? toText(row.gmail_account_id)
      : undefined,
    connectorAccountId: row.connector_account_id
      ? toText(row.connector_account_id)
      : undefined,
    gmailAccountEmail: row.gmail_account_email
      ? toText(row.gmail_account_email)
      : undefined,
    phoneAccountId: sourceRef.phoneAccountId,
    phoneAccountLabel: sourceRef.phoneAccountLabel,
    phoneNumber: sourceRef.phoneNumber,
    lastSeenAt: row.last_seen_at ? toText(row.last_seen_at) : undefined,
    repliedAt: row.replied_at ? toText(row.replied_at) : undefined,
    priorityScore,
    priorityCategory: normalizeInboxPriorityCategory(priorityCategory),
    cachedAt: toText(row.cached_at),
    updatedAt: toText(row.updated_at),
    priorityFlags: flags,
  };
}
