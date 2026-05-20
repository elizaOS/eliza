/**
 * SSE Event Broadcaster
 *
 * @description Publishes events to Redis Streams for SSE delivery. Events are
 * broadcast to channels and consumed by SSE handlers via `XREAD` per-connection.
 * Provides high-level functions for broadcasting to channels and chat rooms.
 */

import { logger, type MessageMetadata } from '@babylon/shared';
import { publishEvent, type RealtimeChannel } from '../realtime';
import type { JsonValue } from '../types';

export type Channel = RealtimeChannel;

export interface SSEClient {
  id: string;
  userId: string;
  channels: Set<Channel>;
  controller: ReadableStreamDefaultController;
  lastPing: number;
}

export interface BroadcastMessage {
  channel: Channel;
  type: string;
  data: Record<string, JsonValue>;
  timestamp: number;
}

class NoopBroadcaster {
  getStats() {
    return {
      totalClients: 0,
      clientsByChannel: {},
      redisEnabled: true,
    };
  }
  cleanup() {
    // no-op
  }
}

let broadcasterInstance: NoopBroadcaster | null = null;

export function getEventBroadcaster(): NoopBroadcaster {
  if (!broadcasterInstance) {
    broadcasterInstance = new NoopBroadcaster();
  }
  return broadcasterInstance;
}

/**
 * Broadcast a message to a channel (Stream-backed).
 */
export async function broadcastToChannel(
  channel: Channel,
  data: Record<string, JsonValue>
): Promise<void> {
  const message: BroadcastMessage = {
    channel,
    type: (data.type as string) || 'update',
    data,
    timestamp: Date.now(),
  };

  await publishEvent({
    channel,
    type: message.type,
    data,
    timestamp: message.timestamp,
  });
}

/**
 * Broadcast a chat message to a specific chat room.
 */
export async function broadcastChatMessage(
  chatId: string,
  message: {
    id: string;
    content: string;
    chatId: string;
    senderId: string;
    type?: string;
    createdAt: string;
    isGameChat?: boolean;
    isDMChat?: boolean;
    metadata?: MessageMetadata | null;
    replyToMessageId?: string | null;
    replyToMessage?: {
      id: string;
      content: string;
      senderId: string;
      senderName?: string;
    } | null;
  }
): Promise<void> {
  logger.info(
    'Broadcasting chat message',
    { chatId, messageId: message.id },
    'Realtime'
  );
  // Cast to JsonValue for type compatibility - metadata may contain complex nested types
  await broadcastToChannel(`chat:${chatId}`, {
    type: 'new_message',
    message: message as unknown as JsonValue,
  });
}

/**
 * Broadcast a chat message reaction delta to a specific chat room.
 */
export async function broadcastChatMessageReaction(
  chatId: string,
  reaction: {
    messageId: string;
    chatId: string;
    emoji: string;
    userId: string;
    action: 'added' | 'removed';
  }
): Promise<void> {
  await broadcastToChannel(`chat:${chatId}`, {
    type: 'message_reaction',
    reaction: reaction as unknown as JsonValue,
  });
}

// ============================================================================
// Agent Activity Broadcasting
// ============================================================================

/**
 * Trade activity data for agent activity events.
 */
export interface TradeActivityData {
  tradeId: string;
  marketType: 'prediction' | 'perp';
  marketId: string | null;
  ticker: string | null;
  marketQuestion?: string;
  action: 'open' | 'close';
  side: 'long' | 'short' | 'yes' | 'no' | null;
  amount: number;
  price: number;
  pnl: number | null;
  reasoning: string | null;
}

/**
 * Post activity data for agent activity events.
 */
export interface PostActivityData {
  postId: string;
  contentPreview: string;
}

/**
 * Comment activity data for agent activity events.
 */
export interface CommentActivityData {
  commentId: string;
  postId: string;
  contentPreview: string;
  parentCommentId: string | null;
}

/**
 * Message activity data for agent activity events.
 */
export interface MessageActivityData {
  messageId: string;
  chatId: string;
  recipientId: string | null;
  contentPreview: string;
}

/**
 * Unified agent activity event structure.
 */
export interface AgentActivityEvent {
  type: 'trade' | 'post' | 'comment' | 'message';
  agentId: string;
  agentName: string;
  timestamp: number;
  data:
    | TradeActivityData
    | PostActivityData
    | CommentActivityData
    | MessageActivityData;
}

/**
 * Broadcast an agent activity event to the agent's SSE channel.
 *
 * This allows real-time visibility of agent actions (trades, posts, comments)
 * to the agent owner's UI without polling.
 *
 * @param agentId - The agent user ID
 * @param agentName - Display name of the agent (for UI rendering)
 * @param activityType - Type of activity (trade, post, comment, message)
 * @param data - Activity-specific data
 */
export async function broadcastAgentActivity(
  agentId: string,
  agentName: string,
  activityType: AgentActivityEvent['type'],
  data: AgentActivityEvent['data']
): Promise<void> {
  const activity: AgentActivityEvent = {
    type: activityType,
    agentId,
    agentName,
    timestamp: Date.now(),
    data,
  };

  logger.info(
    'Broadcasting agent activity',
    { agentId, type: activityType },
    'Realtime'
  );

  // Cast to Record<string, JsonValue> for type compatibility with broadcastToChannel
  await broadcastToChannel(`agent:${agentId}`, {
    type: `agent_${activityType}`,
    activity: activity as unknown as JsonValue,
  });
}

/**
 * Broadcast chat title update to a chat room.
 * Used when LLM generates a title for a new conversation.
 */
export async function broadcastChatTitleUpdate(
  chatId: string,
  newTitle: string
): Promise<void> {
  logger.info(
    'Broadcasting chat title update',
    { chatId, newTitle },
    'Realtime'
  );
  await broadcastToChannel(`chat:${chatId}`, {
    type: 'title_updated',
    chatId,
    title: newTitle,
    timestamp: Date.now(),
  });
}

/**
 * Broadcast typing indicator to a chat room.
 */
export async function broadcastTypingIndicator(
  chatId: string,
  userId: string,
  displayName: string,
  isTyping: boolean
): Promise<void> {
  await broadcastToChannel(`chat:${chatId}`, {
    type: 'typing_indicator',
    userId,
    displayName,
    isTyping,
    timestamp: Date.now(),
  });
}

/**
 * Broadcast thinking indicator to a chat room.
 *
 * Distinct from typing indicator - shows that an agent is processing/analyzing
 * a complex query. Used for longer-running operations where the user should
 * see visual feedback that work is happening.
 *
 * @param chatId - The chat ID to broadcast to
 * @param agentId - The agent user ID
 * @param agentName - Display name of the agent
 * @param isThinking - Whether the agent is currently thinking
 * @param thinkingLabel - Optional label describing what the agent is doing (e.g., "Analyzing market data...")
 */
export async function broadcastThinkingIndicator(
  chatId: string,
  agentId: string,
  agentName: string,
  isThinking: boolean,
  thinkingLabel?: string
): Promise<void> {
  await broadcastToChannel(`chat:${chatId}`, {
    type: 'thinking_indicator',
    agentId,
    agentName,
    isThinking,
    thinkingLabel: thinkingLabel ?? null,
    timestamp: Date.now(),
  });
}
