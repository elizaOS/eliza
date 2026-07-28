/**
 * Wave-1 cross-surface fixtures: the four ingestion seams (Discord, Telegram,
 * email, calendar) reduced to the smallest thing that still exercises real
 * product code, plus synthetic fixture data that contains no personal content.
 *
 * Two deliberately different classes of seam live here, and the difference is
 * the point:
 *
 * **Bot/event ingestion (Discord, Telegram).** These drive the connectors'
 * REAL `MessageManager.handleMessage` — the same entrypoint the gateway and the
 * long-poll bot call. The inbound→Memory mapping, `ensureConnection`, and
 * metadata stamping are the product's own. Only the platform SDK objects
 * (discord.js `Message`/`Channel`, a Telegraf `Context`) are synthetic, because
 * those are the network boundary.
 *
 * **Domain-source ingestion (email, calendar).** Gmail sync and Google Calendar
 * reads land in LifeOps/domain tables today; neither calls `runtime.createMemory`,
 * so there is no product path that makes them canonical conversation memory.
 * {@link ingestDomainRecord} is the narrow adapter that stamps a domain record
 * with the SAME metadata envelope the connectors stamp, so one provenance reader
 * serves all four surfaces. It lives here, in test scope, on purpose: whether
 * production should index email bodies into semantic memory is a product/privacy
 * decision (default-off per the Wave-1 audit), and this harness must not
 * pre-empt it. What it proves is that the envelope is connector-agnostic.
 *
 * **Not supported, and not faked here:** personal-history backfill. The Telegram
 * Bot API cannot read a human's pre-existing DMs, and the WhatsApp Business
 * Cloud API cannot read a personal account's history. Those are
 * `missing-needs-build`, and {@link UNSUPPORTED_BACKFILL} records that as data
 * so a test can assert the harness never quietly pretends otherwise.
 *
 * All fixture content is invented (`@example.test` addresses, synthetic
 * snowflakes). No live personal data.
 */
import {
  ChannelType,
  createUniqueUuid,
  type IAgentRuntime,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";

/**
 * Surfaces whose *personal history* cannot be imported through the connector
 * we actually have. Live/bot ingestion works; backfill does not exist.
 */
export const UNSUPPORTED_BACKFILL = [
  {
    surface: "telegram",
    capability: "personal-account-history-backfill",
    reason:
      "Bot API cannot read a human's pre-existing DMs; the GramJS account service logs in but attaches no message handlers or history pagination. History starts at bot installation.",
  },
  {
    surface: "whatsapp",
    capability: "personal-account-history-backfill",
    reason:
      "plugin-whatsapp is the Meta Business Cloud API. It receives live webhooks only and cannot import a personal account's prior chats or groups.",
  },
] as const;

/** A synthetic connector account, so two accounts on one surface stay distinct. */
export interface FixtureAccount {
  accountId: string;
  label: string;
}

export const DISCORD_ACCOUNT_PRIMARY: FixtureAccount = {
  accountId: "discord-acct-primary",
  label: "Primary Discord bot",
};
export const DISCORD_ACCOUNT_SECONDARY: FixtureAccount = {
  accountId: "discord-acct-secondary",
  label: "Secondary Discord bot",
};
export const TELEGRAM_ACCOUNT: FixtureAccount = {
  accountId: "telegram-acct-primary",
  label: "Primary Telegram bot",
};
export const EMAIL_ACCOUNT: FixtureAccount = {
  accountId: "gmail-acct-primary",
  label: "Primary Gmail",
};
export const CALENDAR_ACCOUNT: FixtureAccount = {
  accountId: "gcal-acct-primary",
  label: "Primary Google Calendar",
};

/**
 * A domain record (an email or a calendar event) being promoted into canonical
 * memory. Mirrors the fields `GoogleGmailMessageSummary` / `GoogleCalendarEvent`
 * already expose, narrowed to what provenance needs.
 */
export interface DomainRecord {
  /** Canonical connector source, e.g. `gmail` or `google-calendar`. */
  source: string;
  /** Connector account the record was fetched under. */
  account: FixtureAccount;
  /** Platform-native id — the idempotency anchor. */
  platformRecordId: string;
  /** Stable room the surface's records live in (e.g. one room per mailbox). */
  roomId: UUID;
  /** Entity id of the sender/organizer. */
  senderEntityId: UUID;
  /** Stable platform id of the sender (an email address, an organizer id). */
  senderPlatformId: string;
  /** Sender display name. */
  senderDisplayName: string;
  /** Record body, already reduced to the text the agent would recall. */
  text: string;
  /** Epoch ms the record is dated. */
  timestampMs: number;
  /** Memory scope. Domain sources default to owner-private. */
  scope?: "owner-private" | "private" | "room" | "shared" | "global";
  /** Chat type recorded for the surface. */
  chatType?: string;
  worldId?: UUID;
}

/**
 * Promote a domain record into canonical agent memory with the same metadata
 * envelope the message connectors stamp: `provider`, `accountId`, `chatType`,
 * the nested `metadata[source]` identity object carrying `userId`/`id`, and a
 * platform message id.
 *
 * The nested identity object is what makes provenance report
 * `connector-verified` rather than `unverified` — the same evidence role
 * resolution trusts. Stamping it here (rather than inventing a domain-only
 * trust tier) is what keeps one reader working across all four surfaces.
 */
export async function ingestDomainRecord(
  runtime: IAgentRuntime,
  record: DomainRecord,
): Promise<UUID> {
  const scope = record.scope ?? "owner-private";

  // A domain source has no guild/server, so the connector ACCOUNT is the
  // natural world: one mailbox / one calendar is one tenant scope. Deriving it
  // (rather than leaving it unset) keeps role resolution and world-scoped
  // retrieval working the same way they do for a message connector.
  const worldId =
    record.worldId ??
    (stringToUuid(`${record.source}:${record.account.accountId}`) as UUID);

  await runtime.ensureConnection({
    entityId: record.senderEntityId,
    roomId: record.roomId,
    worldId,
    userName: record.senderDisplayName,
    source: record.source,
    channelId: record.roomId,
    type: ChannelType.DM,
  });

  const memory: Memory = {
    id: createUniqueUuid(
      runtime,
      `${record.source}:${record.account.accountId}:${record.platformRecordId}`,
    ),
    entityId: record.senderEntityId,
    agentId: runtime.agentId,
    roomId: record.roomId,
    worldId,
    createdAt: record.timestampMs,
    content: {
      text: record.text,
      source: record.source,
    },
    metadata: {
      type: "message",
      source: record.source,
      scope,
      timestamp: record.timestampMs,
      provider: record.source,
      accountId: record.account.accountId,
      chatType: record.chatType ?? "dm",
      messageIdFull: record.platformRecordId,
      sender: {
        id: record.senderPlatformId,
        name: record.senderDisplayName,
      },
      // The nested connector-identity object, keyed by source — the shape
      // `deriveCanonicalProvenance` and `roles.ts` both read.
      [record.source]: {
        userId: record.senderPlatformId,
        id: record.senderPlatformId,
        name: record.senderDisplayName,
        accountId: record.account.accountId,
        messageId: record.platformRecordId,
      },
    },
  };

  await runtime.createMemory(memory, "messages");
  return memory.id as UUID;
}

/** Synthetic Gmail message summary — invented addresses only. */
export function emailFixture(options: {
  roomId: UUID;
  platformRecordId?: string;
  timestampMs: number;
  subject?: string;
  body: string;
  fromEmail?: string;
  fromName?: string;
  account?: FixtureAccount;
}): DomainRecord {
  const fromEmail = options.fromEmail ?? "ops@vendor.example.test";
  return {
    source: "gmail",
    account: options.account ?? EMAIL_ACCOUNT,
    platformRecordId: options.platformRecordId ?? "gmail-msg-0001",
    roomId: options.roomId,
    senderEntityId: stringToUuid(`gmail-sender:${fromEmail}`) as UUID,
    senderPlatformId: fromEmail,
    senderDisplayName: options.fromName ?? "Vendor Ops",
    text: options.subject
      ? `${options.subject}\n\n${options.body}`
      : options.body,
    timestampMs: options.timestampMs,
    scope: "owner-private",
    chatType: "dm",
  };
}

/** Synthetic Google Calendar event — invented attendees only. */
export function calendarFixture(options: {
  roomId: UUID;
  platformRecordId?: string;
  startMs: number;
  title: string;
  location?: string;
  organizerEmail?: string;
  account?: FixtureAccount;
}): DomainRecord {
  const organizer = options.organizerEmail ?? "scheduler@team.example.test";
  const startIso = new Date(options.startMs).toISOString();
  return {
    source: "google-calendar",
    account: options.account ?? CALENDAR_ACCOUNT,
    platformRecordId: options.platformRecordId ?? "gcal-evt-0001",
    roomId: options.roomId,
    senderEntityId: stringToUuid(`gcal-organizer:${organizer}`) as UUID,
    senderPlatformId: organizer,
    senderDisplayName: "Team Scheduler",
    text: options.location
      ? `${options.title} at ${options.location}, starting ${startIso}`
      : `${options.title}, starting ${startIso}`,
    timestampMs: options.startMs,
    scope: "owner-private",
    chatType: "dm",
  };
}
