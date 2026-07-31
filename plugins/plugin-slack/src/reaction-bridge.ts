/**
 * Reaction bridge for the Slack plugin.
 *
 * Slack `reaction_added` / `reaction_removed` events used to dead-end: the
 * service emitted the plugin-local `SLACK_REACTION_*` events with a payload
 * that carried no reaction data at all (the handler took `_event` and dropped
 * it), and nothing in core consumed those names. Downstream consumers that
 * want emoji signal — the Convent house agent's chore-verification voting is
 * the driving case — had to poll `reactions.get`.
 *
 * This module maps a Slack reaction event onto the same core contract Discord
 * already emits (`EventType.REACTION_RECEIVED` with a `MessagePayload`), so a
 * consumer can count 👍/👎 without knowing which platform produced them.
 *
 * ## Core-event asymmetry (deliberate, matches plugin-discord)
 *
 * Core declares exactly one reaction event: `EventType.REACTION_RECEIVED`
 * (`packages/core/src/types/events.ts`). There is no `REACTION_REMOVED`.
 * `plugin-discord`'s `handleReaction` resolves this by emitting
 * `[DiscordEventTypes.REACTION_RECEIVED, EventType.REACTION_RECEIVED]` on add
 * but only `[DiscordEventTypes.REACTION_REMOVED]` on remove — removal never
 * reaches core.
 *
 * We match that exactly rather than "improving" on it. Emitting
 * `REACTION_RECEIVED` for a Slack removal would make a platform-agnostic vote
 * counter double-count on Slack and not on Discord, which is a worse bug than
 * the missing event. Removals still get the full enriched payload on
 * `SLACK_REACTION_REMOVED` (including the reaction `Memory`), so a Slack-aware
 * consumer can unvote today. Closing the asymmetry properly means adding
 * `EventType.REACTION_REMOVED` to core and updating both plugins together;
 * that is a core-types change and is deliberately out of scope for this slice.
 *
 * Note also that core's `reactionReceivedHandler` is what persists the
 * reaction memory (`runtime.createMemories`). This module therefore does not
 * call `createMemory` itself — again matching Discord — so an add is stored
 * once and a removal is not stored at all.
 */
import {
  type Content,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { SlackEventTypes, type SlackReactionPayload } from "./types";

/** Whether the reaction was added or removed. */
export type SlackReactionAction = "added" | "removed";

/**
 * The shape Slack delivers for `reaction_added` / `reaction_removed`.
 * `item.type` is `"message"` for message reactions (also `"file"` /
 * `"file_comment"` historically, which we ignore).
 */
export interface SlackReactionEvent {
  user: string;
  reaction: string;
  item: { type: string; channel: string; ts: string };
  item_user?: string;
  event_ts?: string;
}

/**
 * Everything the bridge needs from `SlackService`, injected explicitly so the
 * bridge stays independently testable and the service touch-point stays small.
 *
 * All ID helpers are the service's own, so reaction events land on exactly the
 * same room/entity UUIDs as messages (`createUniqueUuid` over the account-
 * scoped `slack-room` / `slack-user` / `slack` keys).
 */
export interface SlackReactionBridgeHost {
  runtime: IAgentRuntime;
  /** Account-scoped room UUID, thread-aware (`slack-room` key). */
  getRoomId(
    channelId: string,
    threadTs: string | undefined,
    accountId: string,
  ): Promise<UUID>;
  /** Creates the room if it does not exist yet, returning it. */
  ensureRoomExists(
    channelId: string,
    threadTs: string | undefined,
    accountId: string,
  ): Promise<{ id: UUID } | null>;
  /** Account-scoped entity UUID for a Slack user id (`slack-user` key). */
  getEntityId(userId: string, accountId: string): UUID;
  /**
   * Memory UUID the service assigns to an inbound Slack message
   * (`createUniqueUuid` over the `slack-<ts>` key). Used to resolve the
   * reacted-to message and, through it, the room the message actually
   * lives in (which is the thread room for a threaded message).
   */
  getMessageMemoryId(messageTs: string, accountId: string): UUID;
  /** Stable UUID for the reaction memory itself. */
  getReactionMemoryId(key: string, accountId: string): UUID;
  /** Slack `1234567890.123456` → epoch ms. */
  parseSlackTimestamp(ts: string): number;
  /** Inbound allowlist gate, so reactions honour the same channel policy. */
  isChannelAllowed(channelId: string, accountId: string): boolean;
  /** Display name + handle for a Slack user id. */
  resolveUserNames(
    userId: string,
    accountId: string,
  ): Promise<{ name: string; userName: string }>;
  /** Ensures the reacting user exists as an Entity before the event fires. */
  ensureEntityExists(
    entityId: UUID,
    slackUserId: string,
    accountId: string,
  ): Promise<void>;
  /** Outbound reply used for the payload callback. */
  sendReply(
    channelId: string,
    text: string,
    threadTs: string | undefined,
    accountId: string,
  ): Promise<void>;
  teamId(accountId: string): string | undefined;
}

/** Slack caps display of the reacted-to message in the reaction text. */
const REACTED_TEXT_PREVIEW_LIMIT = 50;

/**
 * Resolves the room the reaction belongs to.
 *
 * A Slack reaction event carries only `channel` + `ts` — never `thread_ts` —
 * so a naive mapping drops every threaded reaction into the parent channel
 * room, away from the message it reacted to. We recover the thread by looking
 * up the target message's memory (its id is deterministic from `ts`) and
 * reusing its `roomId`. If the agent never saw the message, we fall back to
 * the channel room.
 */
async function resolveReactionRoom(
  host: SlackReactionBridgeHost,
  event: SlackReactionEvent,
  accountId: string,
): Promise<{
  roomId: UUID;
  threadTs: string | undefined;
  targetMemory: Memory | null;
}> {
  const targetMemoryId = host.getMessageMemoryId(event.item.ts, accountId);

  let targetMemory: Memory | null = null;
  try {
    targetMemory = await host.runtime.getMemoryById(targetMemoryId);
  } catch (error) {
    host.runtime.logger.debug(
      {
        src: "plugin:slack",
        agentId: host.runtime.agentId,
        accountId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Reaction bridge could not load target message memory",
    );
  }

  if (targetMemory?.roomId) {
    const metadata = targetMemory.metadata as
      | { slackThreadTs?: string; slackMessageTs?: string }
      | undefined;
    // A threaded message stores its parent `thread_ts`; a thread parent
    // stores none, in which case its own ts is the thread root for replies.
    const threadTs = metadata?.slackThreadTs;
    return { roomId: targetMemory.roomId, threadTs, targetMemory };
  }

  // Unknown message: land the reaction on the channel room.
  const room = await host.ensureRoomExists(
    event.item.channel,
    undefined,
    accountId,
  );
  const roomId =
    room?.id ??
    (await host.getRoomId(event.item.channel, undefined, accountId));
  return { roomId, threadTs: undefined, targetMemory: null };
}

/**
 * Builds the reaction `Memory` that rides on both the core and the
 * plugin-local event.
 */
function buildReactionMemory(params: {
  host: SlackReactionBridgeHost;
  event: SlackReactionEvent;
  action: SlackReactionAction;
  accountId: string;
  roomId: UUID;
  threadTs: string | undefined;
  entityId: UUID;
  targetMemory: Memory | null;
  targetMemoryId: UUID;
  names: { name: string; userName: string };
  timestamp: number;
}): Memory {
  const {
    host,
    event,
    action,
    accountId,
    roomId,
    threadTs,
    entityId,
    targetMemory,
    targetMemoryId,
    names,
    timestamp,
  } = params;

  const actionText = action === "added" ? "Added" : "Removed";
  const preposition = action === "added" ? "to" : "from";
  const emoji = `:${event.reaction}:`;

  const reactedText =
    typeof targetMemory?.content?.text === "string"
      ? targetMemory.content.text
      : "";
  const preview =
    reactedText.length > REACTED_TEXT_PREVIEW_LIMIT
      ? `${reactedText.substring(0, REACTED_TEXT_PREVIEW_LIMIT)}...`
      : reactedText;

  const content: Content = {
    text: `*${actionText} ${emoji} ${preposition}: "${preview}"*`,
    source: "slack",
    name: names.name,
    // Point at the reacted-to message so context assembly can thread the
    // reaction onto its target the same way Discord does.
    inReplyTo: targetMemoryId,
    metadata: { accountId },
    // `text` truncates the reacted-to message to a display stub; preserve
    // the full original so context building sees the whole statement
    // rather than a fragment (mirrors plugin-discord).
    ...(reactedText ? { reactedMessageText: reactedText } : {}),
  };

  return {
    id: host.getReactionMemoryId(
      `${event.item.ts}-${event.user}-${event.reaction}-${action}-${timestamp}`,
      accountId,
    ),
    agentId: host.runtime.agentId,
    roomId,
    entityId,
    content,
    metadata: {
      type: "message",
      source: "slack",
      provider: "slack",
      accountId,
      timestamp,
      entityName: names.name,
      entityUserName: names.userName,
      fromBot: false,
      fromId: event.user,
      sourceId: entityId,
      slackReaction: {
        action,
        emoji: event.reaction,
        channelId: event.item.channel,
        targetMessageTs: event.item.ts,
        targetMessageId: targetMemoryId,
        targetMessageResolved: targetMemory !== null,
        itemUser: event.item_user,
      },
      slack: {
        accountId,
        teamId: host.teamId(accountId),
        channelId: event.item.channel,
        userId: event.user,
        messageId: event.item.ts,
        threadTs,
      },
      slackChannelId: event.item.channel,
      slackMessageTs: event.item.ts,
      slackThreadTs: threadTs,
    } as Memory["metadata"],
    createdAt: timestamp,
  };
}

/**
 * Bridges one Slack reaction event onto the core event bus.
 *
 * Emits `[SLACK_REACTION_ADDED, EventType.REACTION_RECEIVED]` for an add and
 * `[SLACK_REACTION_REMOVED]` for a removal (see the module note on the core
 * asymmetry). The plugin-local event names are preserved for back-compat; the
 * payload on them is now populated to match the `SlackReactionPayload` type
 * the plugin already declared but never actually filled in.
 *
 * Failures are logged and swallowed: a bad reaction must never take down the
 * socket handler.
 */
export async function bridgeSlackReaction(
  host: SlackReactionBridgeHost,
  event: SlackReactionEvent,
  action: SlackReactionAction,
  accountId: string,
): Promise<void> {
  try {
    if (!event?.user || !event?.reaction || !event.item?.ts) {
      return;
    }

    // Only message reactions map onto a message memory. File reactions have
    // no room/message anchor in this plugin's model.
    if (event.item.type && event.item.type !== "message") {
      return;
    }

    const channelId = event.item.channel;
    if (!channelId) return;

    // Reactions honour the same inbound channel policy as messages.
    if (!host.isChannelAllowed(channelId, accountId)) {
      return;
    }

    const { roomId, threadTs, targetMemory } = await resolveReactionRoom(
      host,
      event,
      accountId,
    );
    const targetMemoryId = host.getMessageMemoryId(event.item.ts, accountId);
    const entityId = host.getEntityId(event.user, accountId);

    if (!roomId || !entityId) {
      host.runtime.logger.warn(
        { src: "plugin:slack", agentId: host.runtime.agentId, accountId },
        "Reaction bridge could not resolve room or entity",
      );
      return;
    }

    await host.ensureEntityExists(entityId, event.user, accountId);

    const names = await host.resolveUserNames(event.user, accountId);
    const timestamp = event.event_ts
      ? host.parseSlackTimestamp(event.event_ts)
      : Date.now();

    const memory = buildReactionMemory({
      host,
      event,
      action,
      accountId,
      roomId,
      threadTs,
      entityId,
      targetMemory,
      targetMemoryId,
      names,
      timestamp,
    });

    const callback: HandlerCallback = async (
      responseContent,
    ): Promise<Memory[]> => {
      const text = responseContent?.text?.trim();
      if (!text) return [];
      await host.sendReply(channelId, text, threadTs, accountId);
      return [];
    };

    const payload: SlackReactionPayload = {
      runtime: host.runtime,
      source: "slack",
      message: memory,
      callback,
      reaction: event.reaction,
      userId: event.user,
      channelId,
      messageTs: event.item.ts,
      itemUser: event.item_user,
      accountId,
      metadata: { accountId },
    } as SlackReactionPayload;

    const events: string[] =
      action === "added"
        ? [
            SlackEventTypes.REACTION_ADDED as string,
            EventType.REACTION_RECEIVED,
          ]
        : [SlackEventTypes.REACTION_REMOVED as string];

    await host.runtime.emitEvent(events, payload);
  } catch (error) {
    host.runtime.logger.error(
      {
        src: "plugin:slack",
        agentId: host.runtime.agentId,
        accountId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Error bridging Slack reaction",
    );
  }
}
