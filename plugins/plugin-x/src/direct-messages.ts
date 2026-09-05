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

import type { MembershipScope } from "@elizaos/core";
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
import { parseTwitterInterval } from "./environment";
import { XMembershipPublisher, xMembershipPrincipal } from "./membership";
import type { TwitterClientState } from "./types";
import { resolveCloudApiKeyForXEndpoint } from "./utils/cloud-credential-boundary";
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

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().toLowerCase() === "true";
}

function parsePollIntervalMs(value: unknown): number {
  const seconds = parseTwitterInterval(
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value
        : undefined,
    60,
  );
  return Math.max(15, seconds) * 1_000;
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
  /**
   * Membership-evidence publisher (#24372): observed-only point-query proofs
   * from DM timeline events into the canonical MembershipService authority.
   * Degrade-only — a null authority never touches the message path.
   */
  private readonly membership = new XMembershipPublisher(this.runtime);
  /**
   * Conversation ids whose own-account membership was published this
   * process, with the publish time — own participation is re-proven after
   * the evidence TTL lapses (the authority expires evidence at validUntil,
   * so a lifetime marker would let own proof silently go stale) and after
   * the scope is degraded (own-leave) so regained access re-proves.
   */
  private readonly ownMembershipPublishedAt = new Map<string, number>();
  /** Evidence validity window requested per own-membership proof (6h). */
  private static readonly OWN_MEMBERSHIP_TTL_MS = 6 * 60 * 60 * 1_000;
  /**
   * True while all membership scopes are degraded after a 401/403 poll
   * failure; the next successful poll clears it and restores the scopes.
   */
  private membershipDegradedForAuth = false;

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
      resolveCloudApiKeyForXEndpoint(
        url,
        getSetting(this.runtime, "ELIZAOS_CLOUD_API_KEY"),
      );
    if (!token) {
      throw new Error(
        "X personal DM routing requires an explicit TWITTER_BROKER_TOKEN unless the router belongs to the selected Eliza Cloud target",
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
      // Membership evidence (#24372): a successful authenticated poll means
      // authorization recovered — restore degraded scopes BEFORE processing
      // new events, so recovery-poll observations publish against a restored
      // (re-registered) evidence chain instead of being rejected while
      // unavailable or erased by a post-hoc reset. The flag is only cleared
      // after restoration succeeds, so a contained restore failure is
      // retried on the next poll (R3 finding 3, R4 finding 1). With no
      // bound scopes there is nothing to restore: clear the flag so a later
      // poll cannot force-restore and reset freshly published evidence
      // (R4 finding 3 edge).
      if (this.membershipDegradedForAuth) {
        if (this.hasBoundMembershipScopes()) {
          const restored =
            await this.restoreMembershipScopes("x_auth_recovered");
          if (!restored) {
            // Restoration was attempted and failed: keep the degraded
            // marker so the next poll retries (contained per J4).
            return;
          }
          // Clear own-membership markers so restored scopes re-prove the
          // account's own participation immediately instead of waiting out
          // the marker window.
          this.ownMembershipPublishedAt.clear();
        }
        this.membershipDegradedForAuth = false;
      }
      await this.processNewMessages();
    } catch (error) {
      this.runtime.reportError("XDirectMessages.poll", error, {
        accountId: this.client.accountId,
      });
      // Membership evidence (#24372): persistent authorization failures
      // (401/403) mean the account can no longer observe ANY conversation —
      // degrade every known scope so authorization fails closed instead of
      // trusting stale evidence. Transient failures (429, 5xx, network) do
      // NOT write health: the evidence TTL (6h) is the fail-closed
      // backstop and the next successful poll simply continues renewing.
      if (isAuthorizationFailure(error)) {
        this.membershipDegradedForAuth = true;
        await this.degradeAllMembershipScopes(
          `x_auth_failed_${errorCodeOf(error) ?? "401"}`,
        );
      }
    } finally {
      this.pollInFlight = false;
      this.scheduleNextPoll();
    }
  }

  /**
   * Degrade every membership scope this client has published under (#24372).
   * Used when the account's authorization fails globally (401/403 on the DM
   * events endpoint): no conversation remains observable, so all evidence
   * must fail closed. Degrade-only and failure-contained per J4.
   */
  private hasBoundMembershipScopes(): boolean {
    return this.membership.hasBoundScopes();
  }

  private async degradeAllMembershipScopes(reason: string): Promise<void> {
    try {
      await this.membership.degradeAllScopes(reason);
    } catch (error) {
      // error-policy:J4 degrade-only side surface; never break the poll path.
      logger.debug(
        {
          src: "plugin:x",
          accountId: this.client.accountId,
          error: error instanceof Error ? error.message : String(error),
        },
        "X DM membership scope degrade-all failed",
      );
    }
  }

  /** Restore all scopes after authorization recovers. Returns false when the
   * restoration was attempted but failed, so the caller keeps the degraded
   * marker and retries on the next poll (R4 finding 1: a suppressed restore
   * failure must not read as recovery). Contained per J4. */
  private async restoreMembershipScopes(reason: string): Promise<boolean> {
    try {
      await this.membership.restoreAllScopes(reason);
      return true;
    } catch (error) {
      // error-policy:J4 degrade-only side surface; never break the poll path.
      logger.warn(
        {
          src: "plugin:x",
          accountId: this.client.accountId,
          error: error instanceof Error ? error.message : String(error),
        },
        "X DM membership scope restore-all failed; will retry on next poll",
      );
      return false;
    }
  }

  /**
   * Restore one conversation scope after the account itself rejoins it.
   * Returns false when the restoration was attempted but failed, so the
   * roster-event caller withholds the cursor advance for this event and the
   * restore is retried on the next poll (R4 finding 2: publishing past a
   * failed restore would strand the scope durably unavailable). Contained
   * per J4: never breaks the roster-event loop.
   */
  private async restoreOneMembershipScope(
    scope: MembershipScope,
    reason: string,
  ): Promise<boolean> {
    try {
      await this.membership.restoreScope({ scope, reason });
      return true;
    } catch (error) {
      // error-policy:J4 degrade-only side surface; never break the poll path.
      logger.warn(
        {
          src: "plugin:x",
          accountId: this.client.accountId,
          error: error instanceof Error ? error.message : String(error),
        },
        "X DM membership scope restore failed; withholding cursor advance for retry",
      );
      return false;
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
      // Membership evidence (#24372): join/leave events are roster-observable
      // facts in the DM timeline; without them participant departures are
      // invisible and stale active evidence would keep authorizing.
      event_types: ["MessageCreate", "ParticipantsJoin", "ParticipantsLeave"],
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
        await page.fetchNext(50);
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
      if (
        event.event_type === "ParticipantsJoin" ||
        event.event_type === "ParticipantsLeave"
      ) {
        // Membership evidence (#24372): observed-only join/leave proofs.
        // Event-anchored idempotency keys absorb redelivery; a publish
        // failure must not hold the poll cursor (degrade-only evidence), so
        // the cursor advances regardless — EXCEPT when an own-account
        // rejoin's scope restoration failed: publishing or advancing past
        // it would strand the scope durably unavailable with no retry, so
        // the cursor is withheld and the event retried next poll (R4
        // finding 2).
        const retryable = await this.publishMembershipFromRosterEvent(
          event as DirectMessageEvent & { id: string },
          ownUserId,
        );
        if (retryable === "retry") {
          break;
        }
        await this.runtime.setCache(cursorKey, event.id);
        continue;
      }
      if (event.event_type && event.event_type !== "MessageCreate") {
        await this.runtime.setCache(cursorKey, event.id);
        continue;
      }
      if (
        !event.sender_id ||
        event.sender_id === ownUserId ||
        !event.text?.trim()
      ) {
        // A self-sent message still proves the account's own participation
        // in the conversation; the sender renewal below is skipped for the
        // own account there, so publish own membership here.
        if (event.sender_id && event.dm_conversation_id) {
          await this.publishOwnMembership(event.dm_conversation_id, ownUserId);
        }
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
    // Membership evidence (#24372): the policy-accepted sender's presence in
    // this conversation is itself the observation; renew their evidence
    // before the reply loop runs so an authorization read mid-turn sees it.
    await this.renewSenderMembership(
      event,
      conversationId,
      ownUserId,
      username,
    );
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

  /**
   * Publish membership evidence for one ParticipantsJoin/ParticipantsLeave
   * event (#24372). Observed-only per-participant point queries: X's DM
   * roster events name the participants the event is about, but never prove
   * the absence of unlisted members, so `participant_ids` never becomes a
   * completeness claim. The account's own removal degrades the scope (the
   * account can no longer observe the conversation) instead of revoking its
   * own membership row. Returns "retry" when an own-rejoin scope restoration
   * failed and the event must be reprocessed on the next poll (R4 finding
   * 2); all other failures stay contained and the cursor may advance.
   */
  private async publishMembershipFromRosterEvent(
    event: DirectMessageEvent & { id: string },
    ownUserId: string,
  ): Promise<"ok" | "retry"> {
    try {
      const conversationId = event.dm_conversation_id?.trim();
      if (!conversationId) return "ok";
      const scope = await this.membership.scopeForConversation({
        conversationId,
        accountKey: this.client.accountId,
        ownUserId,
      });
      if (!scope) return "ok";
      const isJoin = event.event_type === "ParticipantsJoin";
      const participants = (event.participant_ids ?? []).filter(
        (id) => typeof id === "string" && id.trim(),
      );
      // Without participant_ids there is no principal to publish; the event
      // still advanced the poll cursor, so record the miss for diagnosis
      // rather than guessing a sender.
      if (participants.length === 0) {
        logger.debug(
          {
            src: "plugin:x",
            accountId: this.client.accountId,
            conversationId,
            eventType: event.event_type,
            eventId: event.id,
          },
          "X DM roster event carried no participant_ids; no membership evidence published",
        );
        return "ok";
      }
      const anchoredAt = event.created_at
        ? Date.parse(event.created_at)
        : undefined;
      const worldId = createUniqueUuid(this.runtime, conversationId);
      const roomId = createUniqueUuid(
        this.runtime,
        `x-dm:${this.client.accountId}:${conversationId}`,
      );
      const keyFor = (kind: "join" | "left" | "own-left", pid: string) =>
        membershipObservationKey({
          kind: kind === "own-left" ? "left" : kind,
          conversationId,
          participantId: pid,
          eventId: event.id,
        });
      for (const participantId of participants) {
        if (!isJoin && participantId === ownUserId) {
          // The account itself was removed: revoke own membership (honesty —
          // own active evidence was published, so its removal is published
          // too) AND degrade the whole scope so authorization fails closed
          // and backlogged redeliveries cannot resurrect an unobservable
          // conversation.
          const { principalId: ownPrincipal } = await xMembershipPrincipal(
            this.runtime,
            this.client.accountId,
            ownUserId,
          );
          await this.membership.publishLeave({
            scope,
            principalId: ownPrincipal,
            worldId,
            roomId,
            reason: "left",
            idempotencyKey: keyFor("own-left", ownUserId),
            eventAnchoredAt: anchoredAt,
          });
          await this.membership.degradeScope({
            scope,
            health: "unavailable",
            reason: "own_account_removed_from_conversation",
          });
          // Clear the own-membership marker so regained access (re-add) can
          // re-prove the account in this process.
          this.ownMembershipPublishedAt.delete(conversationId);
          continue;
        }
        const { principalId } = await xMembershipPrincipal(
          this.runtime,
          this.client.accountId,
          participantId,
        );
        const key = keyFor(isJoin ? "join" : "left", participantId);
        if (isJoin) {
          // An own-account ParticipantsJoin after an own-leave means the
          // account rejoined the conversation: restore the degraded scope
          // BEFORE publishing, or the rejoin evidence lands against a
          // durably `unavailable` scope and authorization stays failed
          // closed forever (R3 finding 2). Contained per J4.
          if (participantId === ownUserId) {
            const restored = await this.restoreOneMembershipScope(
              scope,
              "own_account_rejoined_conversation",
            );
            if (!restored) {
              // Withhold the cursor and reprocess this event next poll:
              // publishing past a failed restore would strand the scope
              // durably unavailable (R4 finding 2).
              return "retry";
            }
          }
          await this.publishOwnMembership(conversationId, ownUserId);
          await this.membership.publishJoin({
            scope,
            principalId,
            worldId,
            roomId,
            roles: ["participant"],
            // sender_id on a ParticipantsJoin is the INVITER (X data
            // dictionary), not the joiner — context only, never proof.
            permissionSnapshot: {
              observed: true,
              invitedBy: event.sender_id ?? null,
            },
            idempotencyKey: key,
            eventAnchoredAt: anchoredAt,
          });
        } else {
          await this.membership.publishLeave({
            scope,
            principalId,
            worldId,
            roomId,
            reason: "left",
            idempotencyKey: key,
            eventAnchoredAt: anchoredAt,
          });
        }
      }
      return "ok";
    } catch (error) {
      // error-policy:J4 Membership evidence is a degrade-only side surface of
      // the poll path; failures are logged, never propagated into the loop.
      logger.debug(
        {
          src: "plugin:x",
          accountId: this.client.accountId,
          eventId: event.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "X DM membership evidence publish failed",
      );
      return "ok";
    }
  }

  /**
   * Prove the account's own participation in a conversation once per process.
   * The account's ability to read the conversation's DM events is itself the
   * observation; a ParticipantsJoin carrying the account proves it too, but
   * 1:1 conversations have no join events, so the first observed event
   * publishes own membership directly.
   */
  private async publishOwnMembership(
    conversationId: string,
    ownUserId: string,
  ): Promise<void> {
    const publishedAt = this.ownMembershipPublishedAt.get(conversationId);
    if (
      publishedAt !== undefined &&
      Date.now() - publishedAt <
        TwitterDirectMessageClient.OWN_MEMBERSHIP_TTL_MS
    ) {
      return;
    }
    try {
      const scope = await this.membership.scopeForConversation({
        conversationId,
        accountKey: this.client.accountId,
        ownUserId,
      });
      if (!scope) return;
      const { principalId } = await xMembershipPrincipal(
        this.runtime,
        this.client.accountId,
        ownUserId,
      );
      const worldId = createUniqueUuid(this.runtime, conversationId);
      const roomId = createUniqueUuid(
        this.runtime,
        `x-dm:${this.client.accountId}:${conversationId}`,
      );
      await this.membership.publishJoin({
        scope,
        principalId,
        worldId,
        roomId,
        roles: ["participant", "self"],
        permissionSnapshot: { observed: true, self: true },
        idempotencyKey: membershipObservationKey({
          kind: "own",
          conversationId,
          participantId: ownUserId,
          // Anchor the renewal epoch so a TTL-expired re-proof gets a FRESH
          // journal key: reusing the first epoch's key would collide with
          // the original entry (different timestamps) and surface as a
          // non-benign idempotency conflict instead of a clean renewal
          // (R2 finding 2).
          eventId: `epoch-${Math.floor(Date.now() / TwitterDirectMessageClient.OWN_MEMBERSHIP_TTL_MS)}`,
        }),
        // A restart or forced restoration within the same epoch replays
        // under the same key with regenerated observedAt/validUntil: the
        // authority reports an idempotency conflict, and eventAnchoredAt
        // makes that replay BENIGN (the delta already applied). Any
        // same-epoch replay necessarily happens while the original proof
        // is still valid (published-at + 6h always outlives the epoch
        // boundary), so adopting the durable state is correct (R3 finding 1).
        eventAnchoredAt:
          Math.floor(
            Date.now() / TwitterDirectMessageClient.OWN_MEMBERSHIP_TTL_MS,
          ) * TwitterDirectMessageClient.OWN_MEMBERSHIP_TTL_MS,
      });
      this.ownMembershipPublishedAt.set(conversationId, Date.now());
    } catch (error) {
      // error-policy:J4 degrade-only side surface; never break the poll path.
      logger.debug(
        {
          src: "plugin:x",
          accountId: this.client.accountId,
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        },
        "X DM own-membership publish failed",
      );
    }
  }

  /**
   * Renew the sender's membership evidence after a policy-accepted inbound
   * message: the sender's presence in the conversation is itself the
   * observation (#24372). Event-anchored on the DM event id so cursor
   * redelivery after a crash journals as an idempotent replay.
   */
  private async renewSenderMembership(
    event: DirectMessageEvent & { id: string; sender_id: string },
    conversationId: string,
    ownUserId: string,
    username: string | undefined,
  ): Promise<void> {
    try {
      const scope = await this.membership.scopeForConversation({
        conversationId,
        accountKey: this.client.accountId,
        ownUserId,
      });
      if (!scope) return;
      const { principalId } = await xMembershipPrincipal(
        this.runtime,
        this.client.accountId,
        event.sender_id,
      );
      const worldId = createUniqueUuid(this.runtime, conversationId);
      const roomId = createUniqueUuid(
        this.runtime,
        `x-dm:${this.client.accountId}:${conversationId}`,
      );
      await this.publishOwnMembership(conversationId, ownUserId);
      await this.membership.renewSender({
        scope,
        principalId,
        worldId,
        roomId,
        roles: ["participant"],
        permissionSnapshot: { observed: true, username: username ?? null },
        idempotencyKey: membershipObservationKey({
          kind: "renew",
          conversationId,
          participantId: event.sender_id,
          eventId: event.id,
        }),
        eventAnchoredAt: event.created_at
          ? Date.parse(event.created_at)
          : undefined,
      });
    } catch (error) {
      // error-policy:J4 degrade-only side surface; never break the reply path.
      logger.debug(
        {
          src: "plugin:x",
          accountId: this.client.accountId,
          conversationId,
          senderId: event.sender_id,
          error: error instanceof Error ? error.message : String(error),
        },
        "X DM sender membership renewal failed",
      );
    }
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

/**
 * Deterministic idempotency key for one DM membership observation (#24372).
 * Event-anchored keys (join/leave/renew carry the DM event id) make cursor
 * redelivery after a crash journal as an idempotent replay; the "own" key is
 * process-stable so the once-per-conversation own-membership publish is also
 * replay-safe across restarts.
 */
function membershipObservationKey(options: {
  kind: "join" | "left" | "renew" | "own";
  conversationId: string;
  participantId: string;
  eventId?: string;
}): string {
  const parts = [
    "x",
    options.kind,
    options.conversationId,
    options.participantId,
  ];
  if (options.eventId) parts.push(options.eventId);
  const key = parts.join(":");
  return key.length > 1_000 ? key.slice(0, 1_000) : key;
}

/** HTTP status embedded in a twitter-api-v2 error shape, when present. */
function errorCodeOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
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
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

/**
 * Authorization failures (401/403) on the DM events endpoint mean the
 * account can no longer observe any conversation; 429 and 5xx are transient
 * and must not degrade scope health (evidence TTL is the backstop).
 */
function isAuthorizationFailure(error: unknown): boolean {
  const status = errorCodeOf(error);
  return status === 401 || status === 403;
}
