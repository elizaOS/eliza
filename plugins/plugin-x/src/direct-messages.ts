/**
 * Polls the authenticated X inbox and routes new inbound direct messages through
 * the agent message loop. A persistent event cursor plus a per-event delivery
 * marker prevent duplicate replies across overlapping polls and process restarts;
 * the first poll establishes a watermark instead of replying to historical
 * conversations. Each poll pages through the DM event timeline until it reaches
 * the durable cursor, so bursts larger than one API page are not dropped, and the
 * cursor only advances past an event once its reply was actually delivered (or
 * deliberately skipped), so a transient send failure is retried on the next poll.
 */
import {
  ChannelType,
  type Content,
  createUniqueUuid,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
} from "@elizaos/core";
import type { ClientBase } from "./base";
import type { TwitterClientState } from "./types";
import { createMemorySafe, reconcileTwitterWorld } from "./utils/memory";
import { getSetting } from "./utils/settings";

interface DirectMessageEvent {
  id?: string;
  sender_id?: string;
  dm_conversation_id?: string;
  participant_ids?: string[];
  text?: string;
  created_at?: string;
  event_type?: string;
}

/**
 * Structural view of the twitter-api-v2 DM timeline paginator: `events` and
 * `includes.users` accumulate as pages are fetched, `done` reports whether a
 * next page exists, and `fetchNext` pulls it into the same paginator.
 */
interface DirectMessagePage {
  events?: DirectMessageEvent[];
  includes?: {
    users?: Array<{ id: string; username?: string; name?: string }>;
  };
  done?: boolean;
  fetchNext?: (maxResults?: number) => Promise<unknown>;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().toLowerCase() === "true";
}

function parsePollIntervalMs(value: unknown): number {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Math.max(15, Number.isFinite(seconds) ? seconds : 60) * 1_000;
}

function compareEventIds(left: string, right: string): number {
  try {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  } catch {
    // error-policy:J3 a non-numeric event id cannot be ordered numerically;
    // fall back to explicit lexicographic ordering instead of guessing.
    return left.localeCompare(right);
  }
}

/** A received Twitter API error proves rejection; transport failures do not. */
function rejectedByTwitterStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    data?: { status?: unknown };
  };
  const status = candidate.data?.status ?? candidate.status ?? candidate.code;
  return typeof status === "number" && status >= 400 && status <= 599
    ? status
    : null;
}

export class TwitterDirectMessageClient {
  private isRunning = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollInFlight = false;
  private readonly isDryRun: boolean;

  constructor(
    private readonly client: ClientBase,
    private readonly runtime: IAgentRuntime,
    private readonly state: TwitterClientState,
  ) {
    this.isDryRun = parseBoolean(
      state.TWITTER_DRY_RUN ?? getSetting(runtime, "TWITTER_DRY_RUN"),
      false,
    );
  }

  async start(): Promise<void> {
    this.isRunning = true;
    await this.poll();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleNextPoll(): void {
    if (!this.isRunning) return;
    const intervalMs = parsePollIntervalMs(
      this.state.TWITTER_DM_POLL_INTERVAL_SECONDS ??
        getSetting(this.runtime, "TWITTER_DM_POLL_INTERVAL_SECONDS"),
    );
    this.pollTimer = setTimeout(() => void this.poll(), intervalMs);
  }

  private async poll(): Promise<void> {
    if (!this.isRunning || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      await this.processNewMessages();
    } catch (error) {
      this.runtime.reportError("XDirectMessages.poll", error, {
        accountId: this.client.accountId,
      });
    } finally {
      this.pollInFlight = false;
      this.scheduleNextPoll();
    }
  }

  private async processNewMessages(): Promise<void> {
    const profile = this.client.profile;
    if (!profile?.id) {
      throw new Error("X DM polling requires an authenticated profile.");
    }

    const stateKeyPrefix = `twitter/${this.client.accountId}/${profile.id}`;
    const cursorKey = `${stateKeyPrefix}/dm_cursor`;
    const cursor = (await this.runtime.getCache<string>(cursorKey)) ?? "";

    const api = await this.client.twitterClient.getV2Client();
    const page = (await api.v2.listDmEvents({
      max_results: 50,
      "dm_event.fields": [
        "id",
        "created_at",
        "dm_conversation_id",
        "sender_id",
        "text",
        "event_type",
        "participant_ids",
      ],
      "user.fields": ["id", "username", "name"],
      expansions: ["sender_id"],
      event_types: ["MessageCreate"],
    })) as DirectMessagePage;

    const collectEvents = () =>
      (page.events ?? []).filter(
        (event): event is DirectMessageEvent & { id: string } =>
          Boolean(event.id),
      );

    // The timeline is newest-first. With an established cursor, keep paging
    // until the oldest fetched event is at or behind the cursor so a burst
    // larger than one page is never silently dropped; the paginator
    // accumulates events across fetches. The first (watermark) poll only
    // needs the newest event, so it never paginates.
    if (cursor) {
      while (page.done === false && typeof page.fetchNext === "function") {
        const fetched = collectEvents();
        const oldest = fetched[fetched.length - 1];
        if (oldest && compareEventIds(oldest.id, cursor) <= 0) break;
        const priorCount = fetched.length;
        const priorOldestId = oldest?.id;
        await page.fetchNext(50);
        const nextFetched = collectEvents();
        const nextOldest = nextFetched[nextFetched.length - 1];
        if (
          page.done === false &&
          nextFetched.length <= priorCount &&
          nextOldest?.id === priorOldestId
        ) {
          throw new Error(
            "X DM paginator made no progress before reaching the durable cursor.",
          );
        }
      }
    }

    const events = collectEvents().sort((left, right) =>
      compareEventIds(left.id, right.id),
    );
    if (events.length === 0) return;

    const newestId = events[events.length - 1]?.id;
    if (!cursor) {
      if (newestId) await this.runtime.setCache(cursorKey, newestId);
      logger.info(
        { src: "plugin:x", accountId: this.client.accountId },
        "Initialized X DM cursor without replaying historical messages",
      );
      return;
    }

    const users = new Map(
      (page.includes?.users ?? []).map((user) => [user.id, user] as const),
    );
    for (const event of events) {
      if (compareEventIds(event.id, cursor) <= 0) continue;
      if (event.event_type && event.event_type !== "MessageCreate") {
        await this.runtime.setCache(cursorKey, event.id);
        continue;
      }
      if (
        !event.sender_id ||
        event.sender_id === profile.id ||
        !event.text?.trim()
      ) {
        await this.runtime.setCache(cursorKey, event.id);
        continue;
      }

      // A throw here (including a failed reply send) propagates to poll()
      // without advancing the cursor, so the event is retried next poll.
      await this.handleInboundMessage(
        event as DirectMessageEvent & { id: string; sender_id: string },
        users.get(event.sender_id),
        stateKeyPrefix,
      );
      await this.runtime.setCache(cursorKey, event.id);
    }
  }

  private async handleInboundMessage(
    event: DirectMessageEvent & { id: string; sender_id: string },
    user: { id: string; username?: string; name?: string } | undefined,
    stateKeyPrefix: string,
  ): Promise<void> {
    // Delivery settlement is tracked separately from inbound-memory existence:
    // the marker is written only after the reply round-trip finished, so a
    // crash or transient send failure after the inbound memory was stored is
    // retried on the next poll instead of being permanently deduplicated.
    const settledKey = `${stateKeyPrefix}/dm_settled/${event.id}`;
    if (await this.runtime.getCache<string>(settledKey)) return;

    const memoryId = createUniqueUuid(this.runtime, `x-dm:${event.id}`);

    const senderId = event.sender_id;
    const username = user?.username ?? senderId;
    const displayName = user?.name ?? username;
    const conversationId = event.dm_conversation_id ?? senderId;
    // DMs and public interactions share the sender's canonical X world. Older
    // connector builds already attached DM rooms to this world, so reusing it
    // also repairs their raw platform-id ownership metadata on the next poll.
    const worldId = createUniqueUuid(this.runtime, senderId);
    const roomId = createUniqueUuid(
      this.runtime,
      `x-dm:${this.client.accountId}:${conversationId}`,
    );
    const entityId = createUniqueUuid(this.runtime, senderId);

    await reconcileTwitterWorld(this.runtime, {
      id: worldId,
      name: `${displayName}'s X messages`,
      agentId: this.runtime.agentId,
      metadata: {
        ownership: { ownerId: entityId },
        accountId: this.client.accountId,
        twitter: { accountId: this.client.accountId, id: senderId, username },
      },
    });
    await this.runtime.ensureRoomExists({
      id: roomId,
      name: `X DM with @${username}`,
      source: "x",
      type: ChannelType.DM,
      channelId: conversationId,
      serverId: senderId,
      worldId,
    });
    await this.runtime.ensureConnection({
      entityId,
      roomId,
      userId: entityId,
      userName: username,
      name: displayName,
      source: "x",
      type: ChannelType.DM,
      worldId,
    });

    const createdAt = event.created_at
      ? Date.parse(event.created_at)
      : Date.now();
    const inboundMemory: Memory = {
      id: memoryId,
      agentId: this.runtime.agentId,
      entityId,
      roomId,
      content: { text: event.text?.trim() ?? "", source: "x" },
      metadata: {
        type: "message",
        source: "x",
        provider: "twitter",
        accountId: this.client.accountId,
        timestamp: createdAt,
        entityName: displayName,
        entityUserName: username,
        fromBot: false,
        fromId: senderId,
        sourceId: entityId,
        chatType: ChannelType.DM,
        messageIdFull: event.id,
        twitter: {
          accountId: this.client.accountId,
          userId: senderId,
          username,
          conversationId,
          dmEventId: event.id,
        },
      } satisfies Memory["metadata"],
      createdAt,
    };

    if (!this.runtime.messageService) {
      await createMemorySafe(this.runtime, inboundMemory, "messages");
      throw new Error("X DM auto-reply requires runtime.messageService.");
    }

    // Captures a reply-send failure even if the message service swallows the
    // callback rejection, so settlement below can distinguish "delivered or
    // deliberately silent" from "send failed, retry next poll".
    const delivery: {
      failure: { error: unknown; acceptance: "rejected" | "unknown" } | null;
    } = { failure: null };
    let settled = false;
    const callback: HandlerCallback = async (response: Content) => {
      const text =
        typeof response.text === "string" ? response.text.trim() : "";
      if (!text) return [];
      if (this.isDryRun) {
        logger.info(
          { src: "plugin:x", senderId, text },
          "[DRY RUN] Would reply to X DM",
        );
        return [];
      }

      const api = await this.client.twitterClient.getV2Client();
      const isGroup = (event.participant_ids?.length ?? 0) > 2;
      let sent: unknown;
      try {
        sent = isGroup
          ? await api.v2.sendDmInConversation(conversationId, { text })
          : await api.v2.sendDmToParticipant(senderId, { text });
      } catch (error) {
        // error-policy:J2 preserve the provider error for the settlement gate.
        // An HTTP rejection is safe to retry; a transport failure has unknown
        // acceptance and must be terminal to avoid duplicating a delivered DM.
        delivery.failure = {
          error,
          acceptance:
            rejectedByTwitterStatus(error) === null ? "unknown" : "rejected",
        };
        if (delivery.failure.acceptance === "unknown") {
          await this.runtime.setCache(settledKey, "unknown_acceptance");
          settled = true;
        }
        throw error;
      }
      // Persist delivery settlement before the response memory: a database
      // failure after X accepted the DM must never turn into a duplicate send.
      await this.runtime.setCache(settledKey, "delivered");
      settled = true;
      const sentResult = sent as {
        data?: { dm_event_id?: string };
        dm_event_id?: string;
      };
      const sentId = sentResult.data?.dm_event_id ?? sentResult.dm_event_id;
      if (!sentId) {
        // The reply was accepted by X but no event id came back, so there is
        // no stable identity for a response memory. Do not fail (that would
        // trigger a duplicate send on retry); record the anomaly instead.
        logger.warn(
          { src: "plugin:x", senderId, conversationId },
          "X DM send returned no event id; skipping response memory",
        );
        return [];
      }

      const responseMemory: Memory = {
        id: createUniqueUuid(this.runtime, `x-dm:${sentId}`),
        agentId: this.runtime.agentId,
        entityId: this.runtime.agentId,
        roomId,
        content: { ...response, text, source: "x", inReplyTo: memoryId },
        metadata: {
          type: "message",
          source: "x",
          provider: "twitter",
          accountId: this.client.accountId,
          fromBot: true,
          fromId: this.runtime.agentId,
          sourceId: this.runtime.agentId,
          chatType: ChannelType.DM,
          messageIdFull: sentId,
          twitter: {
            accountId: this.client.accountId,
            conversationId,
            dmEventId: sentId,
          },
        } satisfies Memory["metadata"],
        createdAt: Date.now(),
      };
      await createMemorySafe(this.runtime, responseMemory, "messages");
      return [responseMemory];
    };

    let messageLoopError: unknown = null;
    try {
      await this.runtime.messageService.handleMessage(
        this.runtime,
        inboundMemory,
        callback,
      );
    } catch (error) {
      // error-policy:J2 the settlement state below determines whether this
      // failure is safe to retry; otherwise preserve it for the poll boundary.
      messageLoopError = error;
    }
    if (delivery.failure?.acceptance === "rejected") {
      throw delivery.failure.error instanceof Error
        ? delivery.failure.error
        : new Error(String(delivery.failure.error));
    }
    if (delivery.failure?.acceptance === "unknown") {
      // error-policy:J7 an acceptance-unknown send is deliberately not retried;
      // surface it through diagnostics while allowing the cursor to advance.
      this.runtime.reportError(
        "XDirectMessages.deliveryAcceptanceUnknown",
        delivery.failure.error,
        { accountId: this.client.accountId, eventId: event.id, conversationId },
      );
      return;
    }
    if (messageLoopError) {
      if (settled) {
        // error-policy:J7 X already accepted the reply, so persistence or
        // post-callback diagnostics cannot be allowed to trigger a resend.
        this.runtime.reportError(
          "XDirectMessages.postDelivery",
          messageLoopError,
          {
            accountId: this.client.accountId,
            eventId: event.id,
            conversationId,
          },
        );
        return;
      }
      throw messageLoopError instanceof Error
        ? messageLoopError
        : new Error(String(messageLoopError));
    }
    if (!settled) await this.runtime.setCache(settledKey, "silent");
  }
}
