/**
 * Polls the authenticated X inbox and routes new inbound direct messages through
 * the agent message loop. A persistent event cursor and memory-id check prevent
 * duplicate replies across overlapping polls and process restarts; the first poll
 * establishes a watermark instead of replying to historical conversations.
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

interface DirectMessagePage {
  events?: DirectMessageEvent[];
  includes?: {
    users?: Array<{ id: string; username?: string; name?: string }>;
  };
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
    return left.localeCompare(right);
  }
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

    const events = (page.events ?? [])
      .filter((event): event is DirectMessageEvent & { id: string } =>
        Boolean(event.id),
      )
      .sort((left, right) => compareEventIds(left.id, right.id));
    if (events.length === 0) return;

    const cursorKey = `twitter/${this.client.accountId}/${profile.id}/dm_cursor`;
    const cursor = (await this.runtime.getCache<string>(cursorKey)) ?? "";
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

      await this.handleInboundMessage(
        event as DirectMessageEvent & { id: string; sender_id: string },
        users.get(event.sender_id),
      );
      await this.runtime.setCache(cursorKey, event.id);
    }
  }

  private async handleInboundMessage(
    event: DirectMessageEvent & { id: string; sender_id: string },
    user?: { id: string; username?: string; name?: string },
  ): Promise<void> {
    const memoryId = createUniqueUuid(this.runtime, `x-dm:${event.id}`);
    if (await this.runtime.getMemoryById(memoryId)) return;

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
      const sent = isGroup
        ? await api.v2.sendDmInConversation(conversationId, { text })
        : await api.v2.sendDmToParticipant(senderId, { text });
      const sentResult = sent as unknown as {
        data?: { dm_event_id?: string };
        dm_event_id?: string;
      };
      const sentId = sentResult.data?.dm_event_id ?? sentResult.dm_event_id;
      if (!sentId) throw new Error("X DM send returned no event id.");

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

    await this.runtime.messageService.handleMessage(
      this.runtime,
      inboundMemory,
      callback,
    );
  }
}
