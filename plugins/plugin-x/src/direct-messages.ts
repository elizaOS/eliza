/**
 * Polls the authenticated X inbox and routes new inbound direct messages through
 * the agent message loop. A persistent event cursor plus a per-event delivery
 * marker prevent duplicate replies across overlapping polls and process restarts;
 * the first poll establishes a watermark instead of replying to historical
 * conversations. Each poll pages through the DM event timeline until it reaches
 * the durable cursor, so bursts larger than one API page are not dropped, and the
 * cursor only advances past an event once its reply was delivered, deliberately
 * skipped, or reached an indeterminate provider-egress state. X does not expose
 * an idempotency key for DM sends, so an ambiguous failure after egress starts is
 * retained as an at-most-once tombstone instead of risking a duplicate reply, and
 * only a turn's first reply-callback invocation may attempt egress at all.
 * One-on-one DMs are gated by `TWITTER_DM_POLICY` (`dm-policy.ts`, default
 * `pairing` via the core PairingService handshake) before any world state or
 * memory is created for the sender.
 */
import {
  ChannelType,
  type Content,
  createUniqueUuid,
  ElizaError,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
} from "@elizaos/core";
import type { ClientBase } from "./base";
import type { AuthenticatedTwitterSession } from "./client/auth";
import { checkTwitterDmAccess, resolveTwitterDmPolicy } from "./dm-policy";
import type { TwitterClientState } from "./types";
import { createMemorySafe, reconcileTwitterWorld } from "./utils/memory";
import { normalizeXReceiptId } from "./utils/provider-receipt";
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

/** Fail closed before an anomalous paginator can monopolize the polling loop. */
const MAX_DM_PAGES_PER_POLL = 1_000;

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

/**
 * X stopped returning `participant_ids` on MessageCreate events in June 2025.
 * Current one-to-one conversation IDs are the two participant IDs joined by a
 * hyphen; group conversation IDs are a single numeric snowflake. Retain the
 * old participant-array check for compatible API responses, but fail closed
 * to one-to-one when an identifier has an unknown shape.
 */
export function isGroupDmEvent(event: DirectMessageEvent): boolean {
  if ((event.participant_ids?.length ?? 0) > 2) return true;
  const conversationId = event.dm_conversation_id?.trim() ?? "";
  if (/^\d{1,19}-\d{1,19}$/.test(conversationId)) return false;
  return /^\d{15,19}$/.test(conversationId);
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

  private personalDmRouterUrl(): string | null {
    const value =
      this.state.TWITTER_PERSONAL_DM_ROUTER_URL ??
      getSetting(this.runtime, "TWITTER_PERSONAL_DM_ROUTER_URL");
    return value?.trim() ? value.trim() : null;
  }

  private async routePersonalDm(params: {
    recipientTwitterUserId: string;
    senderTwitterUserId: string;
    senderUsername: string;
    displayName: string;
    dmEventId: string;
    message: string;
  }): Promise<string> {
    const url = this.personalDmRouterUrl();
    if (!url) throw new Error("X personal DM router is not configured");
    const token =
      getSetting(this.runtime, "TWITTER_BROKER_TOKEN") ??
      getSetting(this.runtime, "ELIZAOS_CLOUD_API_KEY");
    if (!token) {
      throw new Error(
        "X personal DM routing requires TWITTER_BROKER_TOKEN or ELIZAOS_CLOUD_API_KEY",
      );
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(120_000),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // error-policy:J3 the Cloud router response is untrusted transport input.
      throw new Error(
        `X personal DM router returned invalid JSON (${response.status})`,
      );
    }
    const reply =
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      "data" in payload &&
      payload.data &&
      typeof payload.data === "object" &&
      !Array.isArray(payload.data) &&
      "reply" in payload.data &&
      typeof payload.data.reply === "string"
        ? payload.data.reply.trim()
        : "";
    if (!response.ok || !reply) {
      throw new Error(
        `X personal DM router rejected delivery (${response.status})`,
      );
    }
    return reply;
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
    await this.client.twitterClient.withAuthenticatedSession((session) =>
      this.processNewMessagesForSession(session),
    );
  }

  private async processNewMessagesForSession(
    session: AuthenticatedTwitterSession,
  ): Promise<void> {
    const ownUserId = session.profile.userId;
    if (!ownUserId) {
      throw new ElizaError(
        "X DM polling requires an authenticated profile identifier",
        { code: "X_ME_FETCH_FAILED" },
      );
    }

    const stateKeyPrefix = `twitter/${this.client.accountId}/${ownUserId}`;
    const cursorKey = `${stateKeyPrefix}/dm_cursor`;
    const cursor = (await this.runtime.getCache<string>(cursorKey)) ?? "";

    const page = (await session.client.v2.listDmEvents({
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
      let previousEventCount = -1;
      let fetchedPages = 1;
      while (page.done === false && typeof page.fetchNext === "function") {
        const fetched = collectEvents();
        const oldest = fetched[fetched.length - 1];
        if (oldest && compareEventIds(oldest.id, cursor) <= 0) break;
        if (fetched.length === previousEventCount) {
          throw new Error(
            "X DM paginator made no progress before reaching the durable cursor.",
          );
        }
        previousEventCount = fetched.length;
        if (fetchedPages >= MAX_DM_PAGES_PER_POLL) {
          throw new Error(
            `X DM catch-up exceeded ${MAX_DM_PAGES_PER_POLL} pages before reaching the durable cursor.`,
          );
        }
        await page.fetchNext(50);
        fetchedPages += 1;
      }
    }

    const events = collectEvents().sort((left, right) =>
      compareEventIds(left.id, right.id),
    );
    this.assertSessionCurrent(session, "while direct messages were being read");
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
        event.sender_id === ownUserId ||
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
        session,
        ownUserId,
      );
      this.assertSessionCurrent(session, "before advancing the DM cursor");
      await this.runtime.setCache(cursorKey, event.id);
    }
  }

  private async handleInboundMessage(
    event: DirectMessageEvent & { id: string; sender_id: string },
    user: { id: string; username?: string; name?: string } | undefined,
    stateKeyPrefix: string,
    session: AuthenticatedTwitterSession,
    ownUserId: string,
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
    const isGroup = isGroupDmEvent(event);

    // DM access policy gate: a one-on-one X DM from an unpaired sender must
    // not reach the agent's reply loop. The default `pairing` policy routes
    // unknown senders through the core PairingService code handshake (fail
    // closed); `TWITTER_DM_POLICY=open` restores the legacy default-open
    // behavior. Group conversations are unaffected — the account only sees
    // ones it was added to. Denied events are not ingested; the poll cursor
    // still advances past them.
    if (!isGroup) {
      const access = await checkTwitterDmAccess(this.runtime, {
        policy: resolveTwitterDmPolicy(
          this.state.TWITTER_DM_POLICY ??
            getSetting(this.runtime, "TWITTER_DM_POLICY"),
        ),
        senderId,
        username: user?.username,
      });
      if (!access.allowed) {
        logger.debug(
          { src: "plugin:x", accountId: this.client.accountId, senderId },
          "X DM blocked by TWITTER_DM_POLICY",
        );
        if (access.replyMessage) {
          try {
            if (this.isDryRun) {
              logger.info(
                { src: "plugin:x", senderId },
                "[DRY RUN] Would send X DM pairing reply",
              );
            } else {
              await session.client.v2.sendDmToParticipant(senderId, {
                text: access.replyMessage,
              });
            }
          } catch (error) {
            // error-policy:J1 The poll loop is the transport boundary: a
            // failed pairing reply is logged with context and the event stays
            // blocked; the sender can retry on their next message.
            logger.warn(
              {
                src: "plugin:x",
                accountId: this.client.accountId,
                senderId,
                error: error instanceof Error ? error.message : String(error),
              },
              "Failed to deliver X DM pairing reply",
            );
          }
        }
        return;
      }
    }

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

    // Captures a reply-send failure even if the message service swallows the
    // callback rejection, so settlement below can distinguish "delivered or
    // deliberately silent" from "send failed, retry next poll".
    let deliveryError: unknown = null;
    let egressAttempted = false;
    const callback: HandlerCallback = async (response: Content) => {
      const text =
        typeof response.text === "string" ? response.text.trim() : "";
      if (!text) return [];
      // The message pipeline may invoke this callback more than once per turn
      // (multiple replying actions, evaluator delivery), including
      // concurrently. The durable settled marker only guards across polls, so
      // the turn's first egress attempt claims the event synchronously — no
      // await sits between check and set — and every later invocation is
      // suppressed. Explicit-rejection recovery stays at the poll level.
      if (egressAttempted) {
        logger.warn(
          { src: "plugin:x", senderId, conversationId, dmEventId: event.id },
          "Suppressed duplicate X DM reply attempt for one inbound event",
        );
        return [];
      }
      egressAttempted = true;
      this.assertSessionCurrent(
        session,
        "before the direct-message reply was sent",
      );
      if (this.isDryRun) {
        logger.info(
          { src: "plugin:x", senderId, text },
          "[DRY RUN] Would reply to X DM",
        );
        return [];
      }

      let sent: unknown;
      // X's DM create endpoints do not accept an idempotency key. Persist a
      // no-replay barrier before the request so a crash, timeout, or receipt
      // persistence failure cannot cause a second externally visible reply.
      // An explicit provider rejection clears the barrier below and may retry.
      try {
        await this.runtime.setCache(settledKey, "egress_started");
      } catch (error) {
        deliveryError = error;
        throw error;
      }
      if (!this.isSessionCurrent(session)) {
        await this.runtime.deleteCache(settledKey);
        deliveryError = this.sessionRotationError(
          "before the direct-message reply was sent",
        );
        throw deliveryError;
      }
      try {
        sent = isGroup
          ? await session.client.v2.sendDmInConversation(conversationId, {
              text,
            })
          : await session.client.v2.sendDmToParticipant(senderId, { text });
      } catch (error) {
        // error-policy:J2 explicit HTTP rejection proves X did not accept the
        // send, so reopen it for a later retry. Transport failures are
        // indeterminate and retain the no-replay tombstone.
        deliveryError = error;
        if (isExplicitTwitterRejection(error)) {
          await this.runtime.deleteCache(settledKey);
        } else {
          await this.runtime.setCache(settledKey, "indeterminate");
        }
        throw error;
      }
      const sentResult = sent as {
        data?: { dm_event_id?: string };
        dm_event_id?: string;
      };
      const sentId = normalizeXReceiptId(
        sentResult.data?.dm_event_id ?? sentResult.dm_event_id,
      );
      await this.runtime.setCache(
        settledKey,
        sentId ? `delivered:${sentId}` : "delivered",
      );
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
      try {
        await createMemorySafe(this.runtime, responseMemory, "messages");
      } catch (error) {
        // error-policy:J7 X has already accepted the reply and the durable
        // delivery marker prevents replay. Report the local receipt loss while
        // preserving the successful external outcome.
        this.runtime.reportError("XDirectMessages.responseMemory", error, {
          accountId: this.client.accountId,
          conversationId,
          dmEventId: sentId,
        });
      }
      return [responseMemory];
    };

    const personalRouterUrl = this.personalDmRouterUrl();
    if (personalRouterUrl) {
      this.assertSessionCurrent(
        session,
        "before the direct message was routed",
      );
      await createMemorySafe(this.runtime, inboundMemory, "messages");
      const reply = await this.routePersonalDm({
        recipientTwitterUserId: ownUserId,
        senderTwitterUserId: senderId,
        senderUsername: username,
        displayName,
        dmEventId: event.id,
        message: event.text?.trim() ?? "",
      });
      await callback({ text: reply });
    } else {
      if (!this.runtime.messageService) {
        await createMemorySafe(this.runtime, inboundMemory, "messages");
        throw new Error("X DM auto-reply requires runtime.messageService.");
      }
      await this.runtime.messageService.handleMessage(
        this.runtime,
        inboundMemory,
        callback,
      );
    }
    if (deliveryError) {
      throw deliveryError instanceof Error
        ? deliveryError
        : new Error(String(deliveryError));
    }
    this.assertSessionCurrent(session, "before the direct message was settled");
    if (!(await this.runtime.getCache<string>(settledKey))) {
      await this.runtime.setCache(settledKey, "settled_without_reply");
    }
  }

  private isSessionCurrent(session: AuthenticatedTwitterSession): boolean {
    return this.client.twitterClient.isAuthenticatedSessionCurrent(session);
  }

  private sessionRotationError(phase: string): ElizaError {
    return new ElizaError(`X credentials rotated ${phase}`, {
      code: "X_AUTH_SESSION_ROTATED",
    });
  }

  private assertSessionCurrent(
    session: AuthenticatedTwitterSession,
    phase: string,
  ): void {
    if (!this.isSessionCurrent(session)) {
      throw this.sessionRotationError(phase);
    }
  }
}

function isExplicitTwitterRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    data?: { status?: unknown };
    response?: { status?: unknown };
  };
  const status =
    candidate.data?.status ??
    candidate.response?.status ??
    candidate.status ??
    candidate.code;
  return (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500
  );
}
