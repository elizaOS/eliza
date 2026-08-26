/**
 * Delivery-binding resolution and delivery-failure classification for
 * prompt-kind triggers. A prompt trigger's fire is only useful when its reply
 * can reach a conversation; a trigger persisted without a resolvable delivery
 * room fires forever with every delivery failing (live QA 2026-08-26:
 * "autonomy-service send failed: no conversation available to deliver
 * message"). This module gives every create surface one binding contract —
 * chat-created triggers keep their creating room, API creates may name a room
 * explicitly, and roomless creates fall back to the owner's most recently
 * active dashboard conversation — and rejects with a typed ElizaError when no
 * binding exists, so a trigger that can never deliver is never accepted.
 *
 * The fire path (executeTriggerTask) uses the classifier and threshold here to
 * recognize the no-conversation failure shape and auto-disable a trigger after
 * MAX_CONSECUTIVE_DELIVERY_FAILURES identical delivery failures instead of
 * letting it nag the error log forever.
 */
import {
  ElizaError,
  type IAgentRuntime,
  type Room,
  type TriggerRunRecord,
  type UUID,
} from "@elizaos/core";
import {
  WEB_CONVERSATION_CHANNEL_PREFIX,
  webChatWorldId,
} from "../api/conversation-restore.ts";

/** Stable code stamped onto run records/lastError for no-conversation delivery failures. */
export const TRIGGER_DELIVERY_FAILURE_CODE = "TRIGGER_DELIVERY_NO_CONVERSATION";
/** Typed-rejection code for a create that names no resolvable delivery binding. */
export const TRIGGER_DELIVERY_UNBOUND_CODE = "TRIGGER_DELIVERY_UNBOUND";
/** Runtime event emitted when a trigger is auto-disabled by the fire path. */
export const TRIGGER_AUTO_DISABLED_EVENT = "trigger_auto_disabled";
/**
 * Consecutive no-conversation delivery failures tolerated before the fire path
 * auto-disables the trigger. Small on purpose: the failure is configuration,
 * not transience, so each extra fire only re-proves the same broken binding.
 */
export const MAX_CONSECUTIVE_DELIVERY_FAILURES = 3;

/** The exact throw shape client-chat-sender raises when no conversation can receive a send. */
const NO_CONVERSATION_ERROR_FRAGMENT =
  "no conversation available to deliver message";

/**
 * True when a trigger-run error string is the no-conversation delivery
 * failure — either the raw send-handler throw or a run record already stamped
 * with {@link TRIGGER_DELIVERY_FAILURE_CODE}.
 */
export function isNoConversationDeliveryError(
  error: string | null | undefined,
): boolean {
  return (
    typeof error === "string" &&
    (error.includes(NO_CONVERSATION_ERROR_FRAGMENT) ||
      error.includes(TRIGGER_DELIVERY_FAILURE_CODE))
  );
}

/** Trailing run of no-conversation delivery failures at the end of a run history. */
export function countTrailingDeliveryFailures(
  runs: readonly TriggerRunRecord[],
): number {
  let count = 0;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run.status === "error" && isNoConversationDeliveryError(run.error)) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

export interface TriggerDeliveryBindingOptions {
  /** Room of the conversation the trigger is being created in (chat path). */
  creatingRoomId?: UUID;
  /** Caller-supplied delivery room (API `roomId`), already validated as a UUID. */
  explicitRoomId?: UUID;
}

export interface TriggerDeliveryBinding {
  roomId: UUID;
  origin: "creating-room" | "explicit-room" | "default-conversation";
}

/**
 * Resolve the delivery room a prompt trigger will be bound to, up front at
 * create time. Resolution order: the creating conversation's room (chat
 * creates keep their room), an explicitly supplied room (verified to exist),
 * then the owner's default conversation — the most recently active dashboard
 * (web-chat) conversation room, the same per-agent world
 * `conversation-restore.ts` rebuilds the conversation list from. Throws a
 * typed {@link ElizaError} (`TRIGGER_DELIVERY_UNBOUND`) when no binding can be
 * resolved, so callers reject the create instead of persisting a trigger that
 * can never deliver.
 */
export async function resolveTriggerDeliveryBinding(
  runtime: IAgentRuntime,
  options: TriggerDeliveryBindingOptions = {},
): Promise<TriggerDeliveryBinding> {
  if (options.creatingRoomId) {
    return { roomId: options.creatingRoomId, origin: "creating-room" };
  }

  if (options.explicitRoomId) {
    const room = await runtime.getRoom(options.explicitRoomId);
    if (!room) {
      throw new ElizaError(
        `roomId ${options.explicitRoomId} does not name an existing room; a prompt trigger must be bound to a conversation that can receive its messages`,
        {
          code: TRIGGER_DELIVERY_UNBOUND_CODE,
          context: { roomId: options.explicitRoomId },
        },
      );
    }
    return { roomId: options.explicitRoomId, origin: "explicit-room" };
  }

  const worldId = webChatWorldId(runtime.character.name ?? "Eliza");
  const rooms = await runtime.getRoomsByWorlds([worldId]);
  const conversationRooms = rooms.filter(
    (room) =>
      typeof room.channelId === "string" &&
      room.channelId.startsWith(WEB_CONVERSATION_CHANNEL_PREFIX),
  );

  let bestRoom: Room | undefined;
  let bestActivityAt = -1;
  for (const room of conversationRooms) {
    const latest = await runtime.getMemories({
      roomId: room.id,
      tableName: "messages",
      limit: 1,
    });
    const activityAt = latest[0]?.createdAt ?? 0;
    if (activityAt > bestActivityAt) {
      bestActivityAt = activityAt;
      bestRoom = room;
    }
  }

  if (!bestRoom) {
    throw new ElizaError(
      "no delivery conversation available: the trigger was created without a conversation binding (no creating chat room and no roomId), and this agent has no dashboard conversation to fall back to. Create the trigger from a chat, or pass a roomId naming the conversation it should deliver into.",
      { code: TRIGGER_DELIVERY_UNBOUND_CODE, context: { worldId } },
    );
  }
  return { roomId: bestRoom.id, origin: "default-conversation" };
}
