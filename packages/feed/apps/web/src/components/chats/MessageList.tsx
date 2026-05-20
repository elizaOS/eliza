'use client';

import { type MessageTag } from '@feed/shared';
import { Loader2, MessageCircle } from 'lucide-react';
import React, { useMemo } from 'react';
import { Skeleton } from '@/components/shared/Skeleton';
import { MessageBubble } from './MessageBubble';
import { MessageContextMenu } from './MessageContextMenu';
import { SystemMessage } from './SystemMessage';
import type {
  ChatParticipant,
  Message,
  MessageType,
  ReplyToMessage,
} from './types';
import { MessageTypeEnum } from './types';

/**
 * Determines the message type for rendering.
 * Checks senderId first (for coordinator detection), then falls back to type field.
 *
 * Note: Coordinator messages are stored with type='user' in DB (no coordinator enum),
 * so we must check senderId first to properly identify them.
 */
function getMessageType(message: Message): MessageType {
  // Use explicit type field if available
  if (message.type) {
    return message.type;
  }
  return MessageTypeEnum.USER;
}

interface MessageListProps {
  messages: Message[];
  participants: ChatParticipant[];
  currentUserId: string | undefined;
  loading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  authenticated: boolean;
  topSentinelRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  density?: 'default' | 'compact';
  /** Callback when a message tag is clicked */
  onTagClick?: (tag: MessageTag, messageId: string) => void;
  /** Toggle a reaction emoji on a message (current user) */
  onToggleReaction?: (
    messageId: string,
    emoji: string,
    currentlyReactedByMe: boolean
  ) => void;
  /** Compact action row: merge reactions + tags into one row, hide on own messages */
  compactActions?: boolean;
  /** Set of agent user IDs — used to show settings icon on latest agent message */
  agentIds?: ReadonlySet<string>;
  /** Callback to open agent settings modal */
  onViewSettings?: (agentId: string) => void;
  /** Callback when user wants to reply to a message */
  onReply?: (message: Message) => void;
}

export function MessageList({
  messages,
  participants,
  currentUserId,
  loading,
  isLoadingMore,
  hasMore,
  authenticated,
  topSentinelRef,
  messagesEndRef,
  density = 'default',
  onTagClick,
  onToggleReaction,
  compactActions = false,
  agentIds,
  onViewSettings,
  onReply,
}: MessageListProps) {
  // Extract usernames from participants for @mention formatting
  // Only usernames that exist in the chat will be formatted as mentions
  const validMentions = useMemo(() => {
    return participants
      .map((p) => p.username)
      .filter((username): username is string => !!username);
  }, [participants]);

  // Compute latest message ID per agent (for settings icon placement)
  const latestAgentMessageIds = useMemo(() => {
    if (!agentIds?.size || !onViewSettings) return new Set<string>();
    const latest = new Map<string, string>();
    // Messages are in chronological order; last one per agent wins
    for (const msg of messages) {
      if (agentIds.has(msg.senderId)) {
        latest.set(msg.senderId, msg.id);
      }
    }
    return new Set(latest.values());
  }, [messages, agentIds, onViewSettings]);

  // Build lookup map for resolving replyToMessage from local messages.
  // Used as fallback when SSE messages arrive without the full reply snippet.
  const replyLookup = useMemo(() => {
    const map = new Map<string, ReplyToMessage>();
    const participantMap = new Map(participants.map((p) => [p.id, p]));
    for (const msg of messages) {
      map.set(msg.id, {
        id: msg.id,
        content: msg.content,
        senderId: msg.senderId,
        senderName: participantMap.get(msg.senderId)?.displayName,
      });
    }
    return map;
  }, [messages, participants]);

  /** Resolve the replyToMessage for a given message */
  function resolveReplyTo(msg: Message): ReplyToMessage | null {
    // Already has full reply data from API
    if (msg.replyToMessage) return msg.replyToMessage;
    // Try local lookup (for SSE messages or messages where the API didn't include the data)
    if (msg.replyToMessageId)
      return replyLookup.get(msg.replyToMessageId) ?? null;
    return null;
  }

  if (loading) {
    return (
      <>
        <div className="flex flex-1 flex-col justify-end p-4">
          <div className="space-y-4">
            {/* Other user message skeleton */}
            <div className="flex items-start gap-3">
              <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
              <div className="space-y-1">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-14 w-48 rounded-2xl rounded-tl-sm" />
              </div>
            </div>
            {/* Current user message skeleton */}
            <div className="flex justify-end">
              <Skeleton className="h-10 w-40 rounded-2xl rounded-tr-sm" />
            </div>
            {/* Other user message skeleton */}
            <div className="flex items-start gap-3">
              <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
              <div className="space-y-1">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-20 w-64 rounded-2xl rounded-tl-sm" />
              </div>
            </div>
            {/* Current user message skeleton */}
            <div className="flex justify-end">
              <Skeleton className="h-10 w-56 rounded-2xl rounded-tr-sm" />
            </div>
          </div>
        </div>
        <div ref={messagesEndRef} />
      </>
    );
  }

  /** Wraps a message bubble with context menu if onReply is provided */
  function wrapWithContextMenu(msg: Message, bubble: React.ReactElement) {
    if (!onReply || !authenticated) return bubble;
    return (
      <MessageContextMenu message={msg} onReply={onReply}>
        {bubble}
      </MessageContextMenu>
    );
  }

  return (
    <>
      {/* Gradient overlay to hint more messages */}
      {hasMore && (
        <div className="pointer-events-none absolute top-0 right-0 left-0 z-10 h-8 bg-gradient-to-b from-background via-background/90 to-transparent" />
      )}

      {/* Sentinel for infinite scroll - only rendered when there are messages */}
      {messages.length > 0 && (
        <div ref={topSentinelRef} className="h-1 w-full" />
      )}

      {/* Loading more messages indicator */}
      {isLoadingMore && (
        <div className="sticky top-2 z-20 flex justify-center">
          <div className="flex items-center gap-2 rounded-full bg-background/85 px-3 py-1 font-medium text-muted-foreground text-xs shadow-sm backdrop-blur">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span>Loading previous messages…</span>
          </div>
        </div>
      )}

      {/* Messages */}
      {messages.map((msg) => {
        const messageType = getMessageType(msg);
        // Use stableKey if available to prevent flash when optimistic messages are confirmed
        const key = msg.stableKey || msg.id;
        // Resolve reply data (from API or local lookup)
        const resolvedReplyTo = resolveReplyTo(msg);
        const enrichedMsg = resolvedReplyTo
          ? { ...msg, replyToMessage: resolvedReplyTo }
          : msg;

        switch (messageType) {
          case MessageTypeEnum.SYSTEM:
            return <SystemMessage key={key} message={msg} />;

          case MessageTypeEnum.USER:
          default: {
            const sender = participants.find((p) => p.id === msg.senderId);
            const isCurrentUser = currentUserId
              ? msg.senderId === currentUserId
              : false;
            const showSettings =
              onViewSettings && latestAgentMessageIds.has(msg.id)
                ? onViewSettings
                : undefined;

            return (
              <React.Fragment key={key}>
                {wrapWithContextMenu(
                  enrichedMsg,
                  <MessageBubble
                    message={enrichedMsg}
                    sender={sender}
                    isCurrentUser={isCurrentUser}
                    validMentions={validMentions}
                    isThinking={msg.isThinking}
                    density={density}
                    onTagClick={onTagClick}
                    onToggleReaction={
                      authenticated ? onToggleReaction : undefined
                    }
                    compactActions={compactActions}
                    onViewSettings={showSettings}
                  />
                )}
              </React.Fragment>
            );
          }
        }
      })}

      {/* Empty state */}
      {messages.length === 0 && (
        <div className="flex h-full items-center justify-center">
          <div className="max-w-md p-8 text-center text-muted-foreground">
            <MessageCircle className="mx-auto mb-4 h-12 w-12 opacity-50" />
            <p className="mb-2 text-foreground">No messages yet</p>
            {authenticated && (
              <p className="text-muted-foreground text-xs">
                Be the first to send a message!
              </p>
            )}
          </div>
        </div>
      )}

      {/* Scroll anchor - always rendered for scroll-to-bottom functionality */}
      <div ref={messagesEndRef} />
    </>
  );
}
