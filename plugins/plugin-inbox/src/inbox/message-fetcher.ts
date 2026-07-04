/**
 * Message-source fetchers and per-source health projection for the aggregation
 * domain. Pulls inbound messages from chat rooms (memories), Gmail, and X DMs
 * behind the `GmailInboxSource` / `XDmInboxSource` seams, and derives the
 * `LifeOpsInboxSourceStatus` each read carries so a degraded connector surfaces
 * as an unhealthy source rather than a healthy-empty inbox. `aggregate.ts` uses
 * the fetchers on pull paths and the status probes on cache paths.
 */
import type { IAgentRuntime, Memory, Room, UUID, World } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  expandConnectorSourceFilter,
  type GetLifeOpsGmailTriageRequest,
  type LifeOpsConnectorDegradation,
  type LifeOpsGmailTriageFeed,
  type LifeOpsGoogleConnectorStatus,
  type LifeOpsInboxSourceStatus,
  type LifeOpsXConnectorStatus,
  type LifeOpsXDm,
  normalizeConnectorSource,
} from "@elizaos/shared";
import { buildDeepLink, resolveChannelName } from "./channel-deep-links.js";
import type { InboundMessage } from "./types.js";

/**
 * Discord public channels are typically larger than DMs / threads. We use this
 * threshold to treat sufficiently-large groups as broadcast channels.
 */
const PUBLIC_CHANNEL_PARTICIPANT_THRESHOLD = 15;

const MAX_ROOMS_SCANNED = 200;
const THREAD_CONTEXT_LIMIT = 5;
const SNIPPET_MAX_LENGTH = 200;
const INTERNAL_URL = new URL("http://127.0.0.1/");

const PHONE_BACKED_SOURCES = new Set([
  "imessage",
  "sms",
  "bluebubbles",
  "blooio",
  "twilio",
  "whatsapp",
]);

export interface GmailInboxSource {
  getGoogleConnectorStatus(
    requestUrl: URL,
  ): Promise<LifeOpsGoogleConnectorStatus>;
  getGmailTriage(
    requestUrl: URL,
    request?: GetLifeOpsGmailTriageRequest,
  ): Promise<LifeOpsGmailTriageFeed>;
}

export interface XDmInboxSource {
  getXConnectorStatus(): Promise<LifeOpsXConnectorStatus>;
  syncXDms(opts?: { limit?: number }): Promise<{ synced: number }>;
  getXDms(opts?: { limit?: number }): Promise<LifeOpsXDm[]>;
}

/** Messages from one connector-backed source plus that source's health. */
export interface InboxSourceFetchResult {
  messages: InboundMessage[];
  status: LifeOpsInboxSourceStatus;
}

function degradation(
  axis: LifeOpsConnectorDegradation["axis"],
  code: string,
  message: string,
  retryable: boolean,
): LifeOpsConnectorDegradation {
  return { axis, code, message, retryable };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Project a Google connector status onto the inbox source-health surface.
 * Returns `ok` only when the connector is connected, holds the Gmail triage
 * capability, and reports no degradations of its own.
 */
export function gmailSourceStatusFromConnector(
  status: LifeOpsGoogleConnectorStatus,
): LifeOpsInboxSourceStatus {
  const reported = status.degradations ?? [];
  if (!status.connected) {
    const authExpired =
      status.reason === "needs_reauth" || status.reason === "token_missing";
    if (authExpired) {
      return {
        source: "gmail",
        state: "degraded",
        degradations: [
          ...reported,
          degradation(
            "auth-expired",
            `gmail_${status.reason}`,
            "Gmail authorization has expired — reconnect Google to resume inbox sync.",
            false,
          ),
        ],
      };
    }
    return {
      source: "gmail",
      state: "disconnected",
      degradations: [
        ...reported,
        degradation(
          "disconnected",
          `gmail_${status.reason}`,
          "Gmail is not connected.",
          false,
        ),
      ],
    };
  }
  if (!status.grantedCapabilities.includes("google.gmail.triage")) {
    return {
      source: "gmail",
      state: "degraded",
      degradations: [
        ...reported,
        degradation(
          "missing-scope",
          "gmail_triage_scope_missing",
          "Gmail is connected but the triage capability was not granted — reconnect Google with Gmail access.",
          false,
        ),
      ],
    };
  }
  return {
    source: "gmail",
    state: reported.length > 0 ? "degraded" : "ok",
    degradations: reported,
  };
}

/**
 * Project an X connector status onto the inbox source-health surface.
 * Returns `ok` only when connected with DM read and no reported degradations.
 */
export function xDmSourceStatusFromConnector(
  status: LifeOpsXConnectorStatus,
): LifeOpsInboxSourceStatus {
  const reported = status.degradations ?? [];
  if (!status.connected) {
    if (status.reason === "needs_reauth") {
      return {
        source: "x_dm",
        state: "degraded",
        degradations: [
          ...reported,
          degradation(
            "auth-expired",
            "x_dm_needs_reauth",
            "X authorization has expired — reconnect X to resume DM sync.",
            false,
          ),
        ],
      };
    }
    return {
      source: "x_dm",
      state: "disconnected",
      degradations: [
        ...reported,
        degradation(
          "disconnected",
          `x_dm_${status.reason ?? "disconnected"}`,
          "X is not connected.",
          false,
        ),
      ],
    };
  }
  if (!status.dmRead) {
    return {
      source: "x_dm",
      state: "degraded",
      degradations: [
        ...reported,
        degradation(
          "missing-scope",
          "x_dm_read_scope_missing",
          "X is connected but DM read access was not granted — reconnect X with DM permissions.",
          false,
        ),
      ],
    };
  }
  return {
    source: "x_dm",
    state: reported.length > 0 ? "degraded" : "ok",
    degradations: reported,
  };
}

function fetchFailedStatus(
  source: LifeOpsInboxSourceStatus["source"],
  error: unknown,
): LifeOpsInboxSourceStatus {
  return {
    source,
    state: "degraded",
    degradations: [
      degradation(
        "transport-offline",
        `${source === "chat" ? "chat" : source}_inbox_fetch_failed`,
        errorMessage(error),
        true,
      ),
    ],
  };
}

/**
 * Probe connector health without pulling messages. Used by the cached inbox
 * read paths so a response served from cache still reports real source health
 * (an expired Gmail token must surface even on a cache hit).
 */
export async function probeSourceStatuses(opts: {
  includeChat: boolean;
  gmailSource?: GmailInboxSource;
  includeGmail: boolean;
  xDmSource?: XDmInboxSource;
  includeXDm: boolean;
}): Promise<LifeOpsInboxSourceStatus[]> {
  const statuses: LifeOpsInboxSourceStatus[] = [];
  if (opts.includeChat) {
    statuses.push({ source: "chat", state: "ok", degradations: [] });
  }
  if (opts.includeGmail) {
    if (!opts.gmailSource) {
      statuses.push(sourceNotWiredStatus("gmail"));
    } else {
      try {
        statuses.push(
          gmailSourceStatusFromConnector(
            await opts.gmailSource.getGoogleConnectorStatus(INTERNAL_URL),
          ),
        );
      } catch (error) {
        logger.warn(
          `[InboxMessageFetcher] gmail status probe failed: ${errorMessage(error)}`,
        );
        statuses.push(fetchFailedStatus("gmail", error));
      }
    }
  }
  if (opts.includeXDm) {
    if (!opts.xDmSource) {
      statuses.push(sourceNotWiredStatus("x_dm"));
    } else {
      try {
        statuses.push(
          xDmSourceStatusFromConnector(
            await opts.xDmSource.getXConnectorStatus(),
          ),
        );
      } catch (error) {
        logger.warn(
          `[InboxMessageFetcher] x_dm status probe failed: ${errorMessage(error)}`,
        );
        statuses.push(fetchFailedStatus("x_dm", error));
      }
    }
  }
  return statuses;
}

function sourceNotWiredStatus(
  source: "gmail" | "x_dm",
): LifeOpsInboxSourceStatus {
  return {
    source,
    state: "disconnected",
    degradations: [
      degradation(
        "disconnected",
        `${source}_source_unavailable`,
        `The ${source === "gmail" ? "Gmail" : "X DM"} inbox source is not wired into this host.`,
        false,
      ),
    ],
  };
}

export async function fetchChatMessages(
  runtime: IAgentRuntime,
  opts: {
    /** Only scan these sources. Defaults to all connector-tagged chat rooms. */
    sources?: string[];
    /** Only return messages newer than this ISO timestamp. */
    sinceIso?: string;
    /** Max messages to return. */
    limit?: number;
  },
): Promise<InboundMessage[]> {
  const limit = opts.limit ?? 200;
  const sourceTags = buildSourceFilter(opts.sources);
  const sinceMs = parseOptionalTimestamp(opts.sinceIso, "sinceIso");

  const allRoomIds = await runtime.getRoomsForParticipant(runtime.agentId);
  if (allRoomIds.length === 0) return [];

  const roomIds = allRoomIds.slice(0, MAX_ROOMS_SCANNED) as UUID[];
  const rooms = await Promise.all(roomIds.map((id) => runtime.getRoom(id)));
  const sourceRooms: Room[] = [];
  for (const room of rooms) {
    if (!room) continue;
    const roomSource = extractRoomSource(room);
    if (sourceMatchesFilter(roomSource, sourceTags)) {
      sourceRooms.push(room);
    }
  }

  if (sourceRooms.length === 0) return [];

  const sourceRoomIds = sourceRooms.map((r) => r.id) as UUID[];
  const memories = await runtime.getMemoriesByRoomIds({
    roomIds: sourceRoomIds,
    tableName: "messages",
    limit: limit * 3, // over-fetch for filtering
  });

  const filtered = memories.filter((m) => {
    if (m.entityId === runtime.agentId) return false;
    const src = extractMemorySource(m);
    if (!sourceMatchesFilter(src, sourceTags)) return false;
    const createdAt = parseRequiredTimestamp(
      m.createdAt,
      "chat memory createdAt",
    );
    if (sinceMs > 0 && createdAt < sinceMs) return false;
    return true;
  });

  filtered.sort(
    (a, b) =>
      parseRequiredTimestamp(b.createdAt, "chat memory createdAt") -
      parseRequiredTimestamp(a.createdAt, "chat memory createdAt"),
  );

  const roomMap = new Map<string, Room>();
  for (const room of sourceRooms) {
    roomMap.set(room.id, room);
  }

  const worldIds = [
    ...new Set(
      sourceRooms
        .map((room) => room.worldId)
        .filter((worldId): worldId is UUID => Boolean(worldId)),
    ),
  ];
  const worlds = await Promise.all(worldIds.map((id) => runtime.getWorld(id)));
  const worldMap = new Map<string, World>();
  for (const world of worlds) {
    if (world) {
      worldMap.set(world.id, world);
    }
  }

  const messagesByRoom = new Map<string, typeof filtered>();
  for (const m of filtered) {
    const roomId = requireNonEmptyString(m.roomId, "chat memory roomId");
    const arr = messagesByRoom.get(roomId) ?? [];
    arr.push(m);
    messagesByRoom.set(roomId, arr);
  }

  // Fetch participant counts per room exactly once. Used to classify DMs,
  // group DMs, and public channels without letting unknown rooms default to DM.
  const participantCountByRoom = new Map<string, number>();
  await Promise.all(
    sourceRooms.map(async (room) => {
      const ids = await runtime.getParticipantsForRoom(room.id);
      participantCountByRoom.set(room.id, ids.length);
    }),
  );

  const results: InboundMessage[] = [];
  for (const memory of filtered.slice(0, limit)) {
    const memoryId = requireNonEmptyString(memory.id, "chat memory id");
    const roomId = requireNonEmptyString(memory.roomId, "chat memory roomId");
    const createdAt = parseRequiredTimestamp(
      memory.createdAt,
      "chat memory createdAt",
    );
    const room = roomMap.get(roomId);
    const source = normalizeConnectorSource(extractMemorySource(memory) ?? "");
    if (!source) continue;
    const text = extractText(memory);
    if (!text) continue;
    const phoneIdentity = extractPhoneIdentity(memory, source);

    const senderName = extractSenderName(memory) ?? "Unknown";
    const participantCount = participantCountByRoom.get(roomId);
    const chatType = classifyChatType(room, participantCount);
    const channelType = chatType === "dm" ? "dm" : "group";
    const channelName = resolveChannelName(source, room?.name, senderName);
    const world = room?.worldId ? worldMap.get(room.worldId) : undefined;
    const deepLink = buildDeepLink(source, {
      messageId: memoryId,
      roomMeta: metadataForRoom(room),
      worldMeta: metadataForWorld(world),
    });

    const roomMessages = messagesByRoom.get(roomId) ?? [];
    const threadMessages = roomMessages
      .filter(
        (m) =>
          m.id !== memoryId &&
          parseRequiredTimestamp(m.createdAt, "chat memory createdAt") <=
            createdAt,
      )
      .slice(0, THREAD_CONTEXT_LIMIT)
      .map((m) => {
        const name = extractSenderName(m) ?? "Unknown";
        return `${name}: ${extractText(m).slice(0, 100)}`;
      });

    results.push({
      id: memoryId,
      source,
      roomId,
      entityId: memory.entityId,
      senderName,
      channelName,
      channelType,
      text,
      snippet: text.slice(0, SNIPPET_MAX_LENGTH),
      timestamp: createdAt,
      deepLink: deepLink ?? undefined,
      threadMessages: threadMessages.length > 0 ? threadMessages : undefined,
      threadId: roomId,
      chatType,
      participantCount,
      ...phoneIdentity,
    });
  }

  return results;
}

function extractPhoneIdentity(
  memory: Memory,
  source: string,
): Pick<
  InboundMessage,
  "phoneAccountId" | "phoneAccountLabel" | "phoneNumber"
> {
  if (!PHONE_BACKED_SOURCES.has(source)) {
    return {};
  }
  const metadata = asRecord(memory.metadata) ?? {};
  const content = asRecord(memory.content) ?? {};
  const nested =
    asRecord(metadata.imessage) ??
    asRecord(metadata.bluebubbles) ??
    asRecord(metadata.blooio) ??
    asRecord(metadata.twilio) ??
    asRecord(metadata.whatsapp);

  const phoneNumber = firstString(
    metadata.localPhoneNumber,
    metadata.phoneNumber,
    metadata.recipientPhoneNumber,
    metadata.toPhoneNumber,
    metadata.destinationCallerId,
    content.localPhoneNumber,
    content.phoneNumber,
    nested?.localPhoneNumber,
    nested?.phoneNumber,
    nested?.recipientPhoneNumber,
    nested?.toPhoneNumber,
    nested?.destinationCallerId,
  );
  const phoneAccountId = firstString(
    metadata.phoneAccountId,
    metadata.localPhoneAccountId,
    nested?.phoneAccountId,
    nested?.localPhoneAccountId,
    phoneNumber,
    metadata.accountId,
  );
  const phoneAccountLabel = firstString(
    metadata.phoneAccountLabel,
    metadata.localPhoneAccountLabel,
    nested?.phoneAccountLabel,
    nested?.localPhoneAccountLabel,
    phoneNumber,
    phoneAccountId,
  );

  return {
    ...(phoneAccountId ? { phoneAccountId } : {}),
    ...(phoneAccountLabel ? { phoneAccountLabel } : {}),
    ...(phoneNumber ? { phoneNumber } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

export async function fetchGmailMessages(
  source: GmailInboxSource,
  opts: {
    sinceIso?: string;
    limit?: number;
    /** Filter to a single Gmail account by Google grant id. */
    grantId?: string;
  },
): Promise<InboxSourceFetchResult> {
  let connectorStatus: LifeOpsGoogleConnectorStatus;
  try {
    connectorStatus = await source.getGoogleConnectorStatus(INTERNAL_URL);
  } catch (error) {
    logger.warn(
      `[InboxMessageFetcher] gmail status probe failed: ${errorMessage(error)}`,
    );
    return { messages: [], status: fetchFailedStatus("gmail", error) };
  }
  const sourceStatus = gmailSourceStatusFromConnector(connectorStatus);
  // Only pull when the connector can actually serve triage. A connector that
  // merely *reports* degradations is still worth pulling from — the degraded
  // status rides along with whatever messages come back.
  if (
    !connectorStatus.connected ||
    !connectorStatus.grantedCapabilities.includes("google.gmail.triage")
  ) {
    return { messages: [], status: sourceStatus };
  }

  const limit = opts.limit ?? 50;

  // When no grantId is supplied, the service-side getGmailTriage already
  // aggregates across every Google grant and tags each summary with grantId
  // and accountEmail. We forward those onto the InboundMessage so the inbox
  // mixin can group by account and render account chips.
  let triageFeed: LifeOpsGmailTriageFeed;
  try {
    triageFeed = await source.getGmailTriage(
      INTERNAL_URL,
      opts.grantId
        ? { grantId: opts.grantId, maxResults: limit }
        : { maxResults: limit },
    );
  } catch (error) {
    logger.warn(
      `[InboxMessageFetcher] gmail triage fetch failed: ${errorMessage(error)}`,
    );
    return { messages: [], status: fetchFailedStatus("gmail", error) };
  }

  const sinceMs = parseOptionalTimestamp(opts.sinceIso, "sinceIso");

  const results: InboundMessage[] = [];
  for (const msg of triageFeed.messages.slice(0, limit)) {
    const messageId = requireNonEmptyString(msg.id, "Gmail message id");
    const externalId = requireNonEmptyString(
      msg.externalId,
      "Gmail external message id",
    );
    const receivedMs = parseRequiredTimestamp(
      msg.receivedAt,
      "Gmail receivedAt",
    );
    if (sinceMs > 0 && receivedMs < sinceMs) continue;

    const from = msg.from || msg.fromEmail || "Unknown sender";
    const gmailAccountSegment = encodeURIComponent(msg.accountEmail ?? "0");
    const gmailLink =
      msg.htmlLink ??
      `https://mail.google.com/mail/u/${gmailAccountSegment}/#inbox/${externalId}`;

    results.push({
      id: messageId,
      source: "gmail",
      senderName: from,
      senderEmail: msg.fromEmail ?? undefined,
      channelName: `Email from ${from}`,
      channelType: "dm",
      text: msg.snippet || msg.subject || "",
      snippet: (msg.snippet || msg.subject || "").slice(0, SNIPPET_MAX_LENGTH),
      timestamp: receivedMs,
      deepLink: gmailLink,
      gmailMessageId: externalId,
      gmailIsImportant: msg.isImportant,
      gmailLikelyReplyNeeded: msg.likelyReplyNeeded,
      threadId: msg.threadId,
      chatType: "dm",
      gmailAccountId: msg.grantId,
      gmailAccountEmail: msg.accountEmail ?? undefined,
    });
  }

  return { messages: results, status: sourceStatus };
}

export async function fetchXDmMessages(
  source: XDmInboxSource,
  opts: {
    sinceIso?: string;
    limit?: number;
  },
): Promise<InboxSourceFetchResult> {
  let connectorStatus: LifeOpsXConnectorStatus;
  try {
    connectorStatus = await source.getXConnectorStatus();
  } catch (error) {
    logger.warn(
      `[InboxMessageFetcher] x_dm status probe failed: ${errorMessage(error)}`,
    );
    return { messages: [], status: fetchFailedStatus("x_dm", error) };
  }
  const sourceStatus = xDmSourceStatusFromConnector(connectorStatus);
  if (!connectorStatus.connected || !connectorStatus.dmRead) {
    return { messages: [], status: sourceStatus };
  }

  const limit = opts.limit ?? 50;
  let dms: LifeOpsXDm[];
  try {
    await source.syncXDms({ limit });
    dms = await source.getXDms({ limit });
  } catch (error) {
    logger.warn(
      `[InboxMessageFetcher] x_dm sync/read failed: ${errorMessage(error)}`,
    );
    return { messages: [], status: fetchFailedStatus("x_dm", error) };
  }
  const sinceMs = parseOptionalTimestamp(opts.sinceIso, "sinceIso");
  const results: InboundMessage[] = [];

  for (const dm of dms) {
    if (!dm.isInbound) continue;
    const receivedMs = parseRequiredTimestamp(dm.receivedAt, "X DM receivedAt");
    if (sinceMs > 0 && receivedMs < sinceMs) continue;
    const sender = dm.senderHandle ? `@${dm.senderHandle}` : dm.senderId;
    const metadata = dm.metadata;
    const participantIds = Array.isArray(metadata.participantIds)
      ? metadata.participantIds.filter(
          (participantId): participantId is string =>
            typeof participantId === "string",
        )
      : [];
    const participantId =
      typeof metadata.participantId === "string" &&
      metadata.participantId.trim()
        ? metadata.participantId.trim()
        : dm.senderId;
    const isGroup = participantIds.length > 2;
    const xParticipantCount =
      participantIds.length || (isGroup ? undefined : 2);
    results.push({
      id: dm.id,
      source: "x_dm",
      entityId: participantId,
      xConversationId: dm.conversationId,
      xParticipantId: participantId,
      senderName: sender || "X user",
      channelName: isGroup ? "X group DM" : `X DM from ${sender || "unknown"}`,
      channelType: isGroup ? "group" : "dm",
      text: dm.text,
      snippet: dm.text.slice(0, SNIPPET_MAX_LENGTH),
      timestamp: receivedMs,
      threadId: dm.conversationId,
      chatType: isGroup ? "group" : "dm",
      participantCount: xParticipantCount,
      lastSeenAt: dm.readAt ?? undefined,
      repliedAt: dm.repliedAt ?? undefined,
    });
  }

  return { messages: results, status: sourceStatus };
}

/** The merged cross-source pull plus per-source health for that pull. */
export interface InboxFetchResult {
  messages: InboundMessage[];
  /** Health of every source the request selected, in chat/gmail/x_dm order. */
  sources: LifeOpsInboxSourceStatus[];
}

export async function fetchAllMessages(
  runtime: IAgentRuntime,
  opts: {
    sources?: string[];
    sinceIso?: string;
    limit?: number;
    includeGmail?: boolean;
    gmailSource?: GmailInboxSource;
    xDmSource?: XDmInboxSource;
    /** Filter Gmail to a single account by Google grant id. */
    gmailGrantId?: string;
  },
): Promise<InboxFetchResult> {
  const requestedSources = opts.sources
    ? buildSourceFilter(opts.sources)
    : null;
  const includeGmail =
    opts.includeGmail !== false &&
    sourceMatchesFilter("gmail", requestedSources);
  if (includeGmail && !opts.gmailSource) {
    throw new Error(
      "fetchAllMessages requires gmailSource when Gmail is included",
    );
  }
  const includeXDm = sourceMatchesFilter("x_dm", requestedSources);
  const gmailResultPromise =
    includeGmail && opts.gmailSource
      ? fetchGmailMessages(opts.gmailSource, {
          sinceIso: opts.sinceIso,
          limit: opts.limit,
          grantId: opts.gmailGrantId,
        })
      : Promise.resolve<InboxSourceFetchResult | null>(null);
  const xDmResultPromise = includeXDm
    ? opts.xDmSource
      ? fetchXDmMessages(opts.xDmSource, {
          sinceIso: opts.sinceIso,
          limit: opts.limit,
        })
      : Promise.resolve<InboxSourceFetchResult>({
          messages: [],
          status: sourceNotWiredStatus("x_dm"),
        })
    : Promise.resolve<InboxSourceFetchResult | null>(null);
  const chatSources = opts.sources?.filter((source) => {
    const normalized = normalizeConnectorSource(source);
    return normalized !== "gmail" && normalized !== "x_dm";
  });
  const includeChat = !chatSources || chatSources.length > 0;
  const chatResultPromise: Promise<InboxSourceFetchResult | null> = includeChat
    ? fetchChatMessages(runtime, {
        sources: chatSources,
        sinceIso: opts.sinceIso,
        limit: opts.limit,
      }).then(
        (messages): InboxSourceFetchResult => ({
          messages,
          status: { source: "chat", state: "ok", degradations: [] },
        }),
        (error): InboxSourceFetchResult => {
          logger.warn(
            `[InboxMessageFetcher] chat fetch failed: ${errorMessage(error)}`,
          );
          return { messages: [], status: fetchFailedStatus("chat", error) };
        },
      )
    : Promise.resolve(null);

  const [chatResult, gmailResult, xDmResult] = await Promise.all([
    chatResultPromise,
    gmailResultPromise,
    xDmResultPromise,
  ]);

  const results = [chatResult, gmailResult, xDmResult].filter(
    (result): result is InboxSourceFetchResult => result !== null,
  );
  const combined = results.flatMap((result) => result.messages);
  combined.sort((a, b) => b.timestamp - a.timestamp);
  return {
    messages: opts.limit ? combined.slice(0, opts.limit) : combined,
    sources: results.map((result) => result.status),
  };
}

function parseOptionalTimestamp(
  value: string | undefined,
  label: string,
): number {
  if (!value) return 0;
  return parseRequiredTimestamp(value, label);
}

function parseRequiredTimestamp(value: unknown, label: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  throw new Error(`[InboxMessageFetcher] invalid ${label}`);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new Error(`[InboxMessageFetcher] missing ${label}`);
}

function extractMemorySource(memory: Memory): string | null {
  const content = memory.content as { source?: unknown } | undefined;
  const source = content?.source;
  if (typeof source !== "string") return null;
  const trimmed = source.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildSourceFilter(
  sources: readonly string[] | undefined,
): Set<string> | null {
  if (!sources) return null;
  const expanded = expandConnectorSourceFilter(sources);
  for (const source of sources) {
    const raw = source.trim().toLowerCase();
    if (!raw) continue;
    expanded.add(raw);
    const normalized = normalizeConnectorSource(raw);
    if (normalized) {
      expanded.add(normalized);
    }
  }
  return expanded;
}

function sourceMatchesFilter(
  source: string | null,
  sourceTags: ReadonlySet<string> | null,
): source is string {
  if (!source) return false;
  if (!sourceTags) return true;
  const raw = source.trim().toLowerCase();
  if (!raw) return false;
  const normalized = normalizeConnectorSource(raw);
  return sourceTags.has(raw) || (!!normalized && sourceTags.has(normalized));
}

function extractText(memory: Memory): string {
  const content = memory.content as { text?: unknown } | undefined;
  const text = content?.text;
  return typeof text === "string" ? text : "";
}

function extractSenderName(memory: Memory): string | null {
  const meta = memory.metadata as Record<string, unknown> | undefined;
  const entityName = meta?.entityName;
  if (typeof entityName === "string" && entityName.length > 0) {
    return entityName;
  }
  return null;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function metadataForRoom(room: Room | undefined): Record<string, unknown> {
  if (!room) return {};
  return {
    ...metadataRecord(room.metadata),
    roomId: room.id,
    roomName: room.name,
    serverId: room.serverId,
  };
}

function metadataForWorld(world: World | undefined): Record<string, unknown> {
  return world ? metadataRecord(world.metadata) : {};
}

function extractRoomSource(room: Room): string | null {
  const source = (room as Room & { source?: unknown }).source;
  if (typeof source === "string" && source.trim().length > 0) {
    return normalizeConnectorSource(source.trim());
  }
  return null;
}

type ChatClassification = "dm" | "group" | "channel";

const DIRECT_ROOM_TYPES = new Set(["dm", "direct", "private", "voice_dm"]);
const GROUP_ROOM_TYPES = new Set(["group", "voice_group"]);
const PUBLIC_ROOM_TYPES = new Set([
  "announcement_thread",
  "broadcast",
  "channel",
  "feed",
  "forum",
  "guild",
  "guild_forum",
  "guild_news",
  "guild_stage_voice",
  "guild_text",
  "guild_voice",
  "news",
  "private_thread",
  "public",
  "public_thread",
  "stage",
  "supergroup",
  "text",
  "thread",
  "voice",
  "world",
]);

function normalizeRoomType(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function classifyRoomTypeValue(
  value: string | null,
): ChatClassification | null {
  if (!value) return null;
  const normalized = normalizeRoomType(value);
  if (DIRECT_ROOM_TYPES.has(normalized)) return "dm";
  if (GROUP_ROOM_TYPES.has(normalized)) return "group";
  if (PUBLIC_ROOM_TYPES.has(normalized)) return "channel";
  return null;
}

function readRoomMetadataString(
  room: Room | undefined,
  key: string,
): string | null {
  const metadata = metadataRecord(room?.metadata);
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Classify a room as DM, small group, or public channel/broadcast.
 * Discord text channels (`GUILD_TEXT`, `voice`, etc.) are treated as channels.
 * Anything with more than {@link PUBLIC_CHANNEL_PARTICIPANT_THRESHOLD}
 * participants is also treated as a channel so the inbox can hide it.
 */
function classifyChatType(
  room: Room | undefined,
  participantCount: number | undefined,
): ChatClassification {
  const roomType = typeof room?.type === "string" ? room.type.trim() : null;
  const explicit =
    classifyRoomTypeValue(roomType) ??
    classifyRoomTypeValue(readRoomMetadataString(room, "chatType")) ??
    classifyRoomTypeValue(readRoomMetadataString(room, "roomType"));

  if (explicit === "dm") {
    return typeof participantCount === "number" && participantCount > 2
      ? "group"
      : "dm";
  }
  if (explicit) return explicit;

  if (
    typeof participantCount === "number" &&
    participantCount > PUBLIC_CHANNEL_PARTICIPANT_THRESHOLD
  ) {
    return "channel";
  }
  if (typeof participantCount === "number" && participantCount > 2) {
    return "group";
  }
  return "channel";
}
