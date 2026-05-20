'use client';

import { cn, type MessageTag } from '@feed/shared';
import {
  ArrowDown,
  Brain,
  MessageCircle,
  PanelLeft,
  PanelRight,
  Radio,
  Users,
} from 'lucide-react';
import React from 'react';
import { Separator } from '@/components/shared/Separator';
import { FeedbackMessages } from './FeedbackMessages';
import type { MentionableAgent } from './MentionAutocomplete';
import { MessageInput } from './MessageInput';
import { MessageList } from './MessageList';
import {
  getDistanceFromBottom,
  shouldShowScrollToLatest,
} from './scroll-utils';
import type { ChatDetails, Message, ReplyToMessage } from './types';

/** Typing user info */
interface TypingUserInfo {
  userId: string;
  displayName: string;
}

/** Thinking agent info - for complex queries */
interface ThinkingAgentInfo {
  agentId: string;
  agentName: string;
  thinkingLabel: string | null;
}

/** Typing indicator component - shows bouncing dots for users typing */
function TypingIndicator({
  typingUsers,
  density,
}: {
  typingUsers: TypingUserInfo[];
  density: 'default' | 'compact';
}) {
  const first = typingUsers[0];
  const second = typingUsers[1];

  if (!first) return null;

  const text =
    typingUsers.length === 1
      ? `${first.displayName} is typing...`
      : typingUsers.length === 2 && second
        ? `${first.displayName} and ${second.displayName} are typing...`
        : `${first.displayName} and ${typingUsers.length - 1} others are typing...`;

  return (
    <div
      className={cn(
        'flex items-center gap-2 text-muted-foreground',
        density === 'compact'
          ? 'px-3 py-1.5 text-sm md:text-xs'
          : 'px-4 py-2 text-sm'
      )}
    >
      <span className="flex gap-1">
        <span className="animate-bounce" style={{ animationDelay: '0ms' }}>
          •
        </span>
        <span className="animate-bounce" style={{ animationDelay: '150ms' }}>
          •
        </span>
        <span className="animate-bounce" style={{ animationDelay: '300ms' }}>
          •
        </span>
      </span>
      <span>{text}</span>
    </div>
  );
}

/**
 * Thinking indicator component - shows pulsing brain icon for agents processing complex queries.
 * Distinct from typing indicator to show that more substantial work is happening.
 */
function ThinkingIndicator({
  thinkingAgents,
  density,
}: {
  thinkingAgents: ThinkingAgentInfo[];
  density: 'default' | 'compact';
}) {
  if (thinkingAgents.length === 0) return null;

  return (
    <div
      className={cn(
        'space-y-1',
        density === 'compact' ? 'px-3 py-1.5' : 'px-4 py-2'
      )}
    >
      {thinkingAgents.map((agent) => (
        <div
          key={agent.agentId}
          className={cn(
            'flex items-center gap-2 text-blue-500',
            density === 'compact' ? 'text-sm md:text-xs' : 'text-sm'
          )}
        >
          <Brain className="h-4 w-4 animate-pulse" />
          <span className="font-medium">{agent.agentName}</span>
          <span className="text-muted-foreground">
            {agent.thinkingLabel ?? 'Thinking...'}
          </span>
        </div>
      ))}
    </div>
  );
}

interface TeamChatViewProps {
  chatDetails: ChatDetails | null;
  currentUserId: string | undefined;
  authenticated: boolean;
  sseConnected: boolean;
  /** When embedding in another container that already has a header (e.g. terminal tabs). */
  hideHeader?: boolean;
  density?: 'default' | 'compact';
  loading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  messageInput: string;
  sending: boolean;
  sendError: string | null;
  topSentinelRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  onMessageChange: (value: string) => void;
  onSendMessage: () => void;
  /** Agents available for @mention */
  agents: MentionableAgent[];
  /** Users currently typing */
  typingUsers?: TypingUserInfo[];
  /** Agents currently thinking (processing complex queries) */
  thinkingAgents?: ThinkingAgentInfo[];
  /** Callback to open member list drawer (mobile only) */
  onShowMembers?: () => void;
  /** Callback when messages container is scrolled (for auto-scroll tracking) */
  onScroll?: (container: HTMLDivElement) => void;
  /** Left sidebar collapsed state */
  leftSidebarCollapsed?: boolean;
  /** Callback to toggle left sidebar */
  onToggleLeftSidebar?: () => void;
  /** Right sidebar open state */
  rightSidebarOpen?: boolean;
  /** Callback to toggle right sidebar */
  onToggleRightSidebar?: () => void;
  /** Callback when a message tag is clicked */
  onTagClick?: (tag: MessageTag, messageId: string) => void;
  /** Toggle a reaction emoji on a message (current user). */
  onToggleReaction?: (
    messageId: string,
    emoji: string,
    currentlyReactedByMe: boolean
  ) => void;
  /** Set of agent user IDs — for settings icon on latest agent message */
  agentIds?: ReadonlySet<string>;
  /** Callback to open agent settings modal */
  onViewSettings?: (agentId: string) => void;
  /** Called when the message input is focused (e.g. to scroll to bottom on mobile keyboard open) */
  onInputFocus?: () => void;
  /** Message being replied to */
  replyToMessage?: ReplyToMessage | null;
  /** Called when user initiates reply to a message */
  onReply?: (message: Message) => void;
  /** Called when user dismisses the reply */
  onDismissReply?: () => void;
}

/**
 * Chat view component for Team Chat (Agents)
 *
 * Similar to ChatView but with typing/thinking indicators and custom header
 */
export function TeamChatView({
  chatDetails,
  currentUserId,
  authenticated,
  sseConnected,
  hideHeader = false,
  density = 'default',
  loading,
  isLoadingMore,
  hasMore,
  messageInput,
  sending,
  sendError,
  topSentinelRef,
  messagesEndRef,
  onMessageChange,
  onSendMessage,
  agents,
  typingUsers = [],
  thinkingAgents = [],
  onShowMembers,
  onScroll,
  leftSidebarCollapsed = false,
  onToggleLeftSidebar,
  rightSidebarOpen = false,
  onToggleRightSidebar,
  onTagClick,
  onToggleReaction,
  agentIds,
  onViewSettings,
  onInputFocus,
  replyToMessage,
  onReply,
  onDismissReply,
}: TeamChatViewProps) {
  const compact = density === 'compact';
  const messagesContainerRef = React.useRef<HTMLDivElement | null>(null);
  const [showScrollToLatest, setShowScrollToLatest] = React.useState(false);

  const updateScrollToLatestVisibility = React.useCallback(
    (container: HTMLDivElement) => {
      const distanceFromBottom = getDistanceFromBottom(
        container.scrollTop,
        container.scrollHeight,
        container.clientHeight
      );
      setShowScrollToLatest(shouldShowScrollToLatest(distanceFromBottom));
    },
    []
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: chatDetails?.chat?.id, chatDetails?.messages?.length, and loading are intentional trigger deps — they re-run the effect on conversation switch / new message arrival even though they aren't referenced inside the callback body.
  React.useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) {
      setShowScrollToLatest(false);
      return;
    }
    updateScrollToLatestVisibility(container);
  }, [
    chatDetails?.chat?.id,
    chatDetails?.messages?.length,
    loading,
    updateScrollToLatestVisibility,
  ]);

  const handleScrollToLatest = React.useCallback(() => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth',
      });
      setShowScrollToLatest(false);
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    setShowScrollToLatest(false);
  }, [messagesEndRef]);

  // Empty state when no chat selected
  if (!chatDetails) {
    return (
      <div className="flex h-full flex-1 items-center justify-center">
        <div className="max-w-md p-8 text-center text-muted-foreground">
          <MessageCircle className="mx-auto mb-4 h-16 w-16 opacity-50" />
          <h3 className="mb-2 font-bold text-foreground text-xl">Chat</h3>
          <p className="text-sm">Loading your team chat...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Chat Header - Fixed */}
      {!hideHeader && (
        <div className="shrink-0">
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {/* Left sidebar toggle - desktop only */}
              {onToggleLeftSidebar && (
                <button
                  onClick={onToggleLeftSidebar}
                  className="hidden shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:block"
                  aria-label={
                    leftSidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'
                  }
                >
                  <PanelLeft className="h-4 w-4" strokeWidth={1.5} />
                </button>
              )}
              <div className="min-w-0">
                <h2 className="truncate font-semibold text-foreground text-lg">
                  {chatDetails.chat.name || 'Agents'}
                </h2>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {/* Mobile members button */}
              {onShowMembers && (
                <button
                  onClick={onShowMembers}
                  className="rounded-lg p-2 transition-colors hover:bg-muted lg:hidden"
                  aria-label="Show team members"
                >
                  <Users className="h-5 w-5 text-muted-foreground" />
                </button>
              )}
              {/* Connection status */}
              <div className="flex items-center gap-2">
                <Radio
                  className={
                    sseConnected
                      ? 'h-4 w-4 text-green-500'
                      : 'h-4 w-4 text-muted-foreground'
                  }
                />
                <span className="text-muted-foreground text-sm">
                  {sseConnected ? 'Live' : 'Connecting...'}
                </span>
              </div>
              {/* Right sidebar toggle */}
              {onToggleRightSidebar && (
                <button
                  onClick={onToggleRightSidebar}
                  className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={rightSidebarOpen ? 'Close panel' : 'Open panel'}
                >
                  <PanelRight className="h-4 w-4" strokeWidth={1.5} />
                </button>
              )}
            </div>
          </div>

          {/* Header Separator */}
          <div className="px-4">
            <Separator />
          </div>
        </div>
      )}

      {/* Messages - Scrollable + jump-to-latest overlay */}
      {/*
       * The outer div is `relative` so the jump button can be absolutely
       * positioned against the VISIBLE viewport of the chat area, not the
       * scroll content area.  The inner div owns overflow-y-auto; absolute
       * children of a scrolling container are anchored to the full content
       * height, so the button would be invisible when scrolled up.
       */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          data-chat-messages-container
          ref={messagesContainerRef}
          className={cn(
            'flex-1 overflow-y-auto overflow-x-hidden',
            compact ? 'space-y-2 px-3 py-2' : 'space-y-4 px-4 py-3'
          )}
          onScroll={(e) => {
            onScroll?.(e.currentTarget);
            updateScrollToLatestVisibility(e.currentTarget);
          }}
        >
          <MessageList
            messages={chatDetails.messages || []}
            participants={chatDetails.participants || []}
            currentUserId={currentUserId}
            loading={loading}
            isLoadingMore={isLoadingMore}
            hasMore={hasMore}
            authenticated={authenticated}
            topSentinelRef={topSentinelRef}
            messagesEndRef={messagesEndRef}
            density={density}
            onTagClick={onTagClick}
            onToggleReaction={onToggleReaction}
            compactActions
            agentIds={agentIds}
            onViewSettings={onViewSettings}
            onReply={onReply}
          />
        </div>

        {showScrollToLatest && (
          <button
            type="button"
            onClick={handleScrollToLatest}
            className="absolute right-4 bottom-4 z-20 rounded-full border border-border bg-background/95 p-2 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
            aria-label="Jump to latest message"
            title="Jump to latest message"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Footer - Fixed */}
      <div className="shrink-0 pb-safe lg:pb-0">
        {/* Thinking Indicator - shown when agents are processing complex queries */}
        {thinkingAgents.length > 0 && (
          <ThinkingIndicator
            thinkingAgents={thinkingAgents}
            density={density}
          />
        )}

        {/* Typing Indicator - shown when users/agents are typing simple responses */}
        {typingUsers.length > 0 && (
          <TypingIndicator typingUsers={typingUsers} density={density} />
        )}

        {/* Feedback Messages */}
        {authenticated && (
          <FeedbackMessages error={sendError} warning={null} success={false} />
        )}

        {/* Message Input with @mention support */}
        <MessageInput
          value={messageInput}
          onChange={onMessageChange}
          onSend={onSendMessage}
          sending={sending}
          authenticated={authenticated}
          density={density}
          placeholder="Message your team — @ to mention agents"
          mentionableMembers={agents}
          onInputFocus={onInputFocus}
          replyToMessage={replyToMessage}
          onDismissReply={onDismissReply}
        />
      </div>
    </div>
  );
}
