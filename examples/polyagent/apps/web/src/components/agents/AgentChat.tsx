"use client";

import { logger } from "@polyagent/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChatViewHeader } from "@/components/chats/ChatViewHeader";
import { MessageInput } from "@/components/chats/MessageInput";
import { MessageList } from "@/components/chats/MessageList";
import type {
  ChatDetails,
  Message as ChatMessage,
  ChatParticipant,
} from "@/components/chats/types";
import { Separator } from "@/components/shared/Separator";
import { useAuth } from "@/hooks/useAuth";
import { CHAT_PAGE_SIZE } from "@/lib/constants";

/**
 * Chat message structure for agent chat.
 */
interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  modelUsed?: string;
  pointsCost: number;
  createdAt: string;
}

/**
 * Agent chat component for chatting with agents.
 *
 * Provides a chat interface for interacting with agents. Supports both
 * free and pro model tiers. Displays message history with infinite scroll,
 * and handles message sending with loading states.
 *
 * Features:
 * - Message history display with infinite scroll
 * - Message sending
 * - Auto-scroll to bottom
 * - Loading states
 * - Error handling
 *
 * @param props - AgentChat component props
 * @returns Agent chat element
 *
 * @example
 * ```tsx
 * <AgentChat
 *   agent={agentData}
 *   onBalanceUpdate={(newBalance) => setAgent(prev => ({ ...prev, virtualBalance: newBalance }))}
 * />
 * ```
 */
interface AgentChatProps {
  agent: {
    id: string;
    name: string;
    profileImageUrl?: string;
    virtualBalance?: number;
    modelTier: "free" | "pro";
  };
  onBalanceUpdate?: (newBalance: number) => void;
  /** Callback when a message is sent or received (to refresh chat list) */
  onMessageSent?: () => void;
  /** Show back button (for mobile view in Chats page) */
  showBackButton?: boolean;
  /** Callback when back button is clicked */
  onBack?: () => void;
}

export function AgentChat({
  agent,
  onBalanceUpdate,
  onMessageSent,
  showBackButton = false,
  onBack,
}: AgentChatProps) {
  const { user, getAccessToken } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);

  // Pagination state
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  // Refs for infinite scroll
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollAdjustRef = useRef<{
    previousHeight: number;
    previousTop: number;
  } | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const previousAgentIdRef = useRef<string | null>(null);

  // Use pro mode based on agent's model tier
  const usePro = agent.modelTier === "pro";

  // Scroll to newest messages (scrollTop = 0 due to flex-col-reverse)
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = chatContainerRef.current;
    if (container) {
      container.scrollTo({ top: 0, behavior });
    }
  }, []);

  // Create ChatDetails for the header component
  const chatDetails: ChatDetails = useMemo(
    () => ({
      chat: {
        id: agent.id,
        name: agent.name,
        isGroup: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        otherUser: {
          id: agent.id,
          displayName: agent.name,
          username: null,
          profileImageUrl: agent.profileImageUrl || null,
          isAgent: true,
          managedBy: user?.id || null,
        },
      },
      messages: [],
      participants: [],
    }),
    [agent.id, agent.name, agent.profileImageUrl, user?.id],
  );

  // Create participants array for MessageList
  const participants: ChatParticipant[] = useMemo(() => {
    const list: ChatParticipant[] = [
      {
        id: agent.id,
        displayName: agent.name,
        username: undefined,
        profileImageUrl: agent.profileImageUrl || undefined,
      },
    ];
    if (user) {
      list.push({
        id: user.id,
        displayName: user.displayName || user.email || "You",
        username: user.username || undefined,
        profileImageUrl: user.profileImageUrl || undefined,
      });
    }
    return list;
  }, [agent.id, agent.name, agent.profileImageUrl, user]);

  // Convert agent messages to ChatMessage format for MessageList
  const chatMessages: ChatMessage[] = useMemo(() => {
    return messages.map((msg) => ({
      id: msg.id,
      content: msg.content,
      senderId: msg.role === "user" ? user?.id || "" : agent.id,
      createdAt: msg.createdAt,
    }));
  }, [messages, user?.id, agent.id]);

  const fetchMessages = useCallback(async () => {
    setLoading(true);
    const token = await getAccessToken();
    if (!token) {
      setLoading(false);
      return;
    }

    const res = await fetch(
      `/api/agents/${agent.id}/chat?limit=${CHAT_PAGE_SIZE}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (res.ok) {
      const data = (await res.json()) as {
        success: boolean;
        messages: Message[];
        pagination?: { hasMore: boolean; nextCursor: string | null };
      };
      if (data.success && data.messages) {
        // Messages come newest first, reverse for display (oldest first)
        setMessages(data.messages.reverse());
        setHasMore(data.pagination?.hasMore || false);
        setNextCursor(data.pagination?.nextCursor || null);
      }
    } else {
      logger.error("Failed to fetch messages", undefined, "AgentChat");
    }
    setLoading(false);
  }, [agent.id, getAccessToken]);

  // Load more messages (pagination)
  const loadMore = useCallback(async () => {
    if (!nextCursor || isLoadingMore || !hasMore) return;

    setIsLoadingMore(true);
    const token = await getAccessToken();
    if (!token) {
      setIsLoadingMore(false);
      return;
    }

    const res = await fetch(
      `/api/agents/${agent.id}/chat?limit=${CHAT_PAGE_SIZE}&cursor=${nextCursor}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (res.ok) {
      const data = (await res.json()) as {
        success: boolean;
        messages: Message[];
        pagination?: { hasMore: boolean; nextCursor: string | null };
      };
      if (data.success && data.messages && data.messages.length > 0) {
        // Prepend older messages (they come newest first, so reverse them)
        const olderMessages = data.messages.reverse();
        setMessages((prev) => [...olderMessages, ...prev]);
        setHasMore(data.pagination?.hasMore || false);
        setNextCursor(data.pagination?.nextCursor || null);
      }
    }
    setIsLoadingMore(false);
  }, [agent.id, getAccessToken, nextCursor, isLoadingMore, hasMore]);

  // Reset state when agent changes
  useEffect(() => {
    if (previousAgentIdRef.current !== agent.id) {
      lastMessageIdRef.current = null;
      previousAgentIdRef.current = agent.id;
    }
  }, [agent.id]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  // Track last message for change detection
  useEffect(() => {
    const lastId =
      messages.length > 0 ? messages[messages.length - 1]?.id : null;
    if (!lastId || loading) return;
    lastMessageIdRef.current = lastId;
  }, [messages, loading]);

  // Load older messages when scrolling up
  useEffect(() => {
    const container = chatContainerRef.current;
    const sentinel = topSentinelRef.current;

    if (!container || !sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        const maxScrollTop = container.scrollHeight - container.clientHeight;
        const nearTop = container.scrollTop >= maxScrollTop - 200;
        if (entry.isIntersecting && nearTop && hasMore && !isLoadingMore) {
          pendingScrollAdjustRef.current = {
            previousHeight: container.scrollHeight,
            previousTop: container.scrollTop,
          };
          loadMore();
        }
      },
      { root: container, rootMargin: "0px 0px 0px 0px", threshold: 0.1 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, loadMore]);

  // Maintain scroll position after loading older messages
  useEffect(() => {
    if (isLoadingMore || !pendingScrollAdjustRef.current) return;
    const container = chatContainerRef.current;
    if (!container) return;

    const { previousHeight, previousTop } = pendingScrollAdjustRef.current;
    const newHeight = container.scrollHeight;
    const delta = newHeight - previousHeight;
    container.scrollTop = previousTop + delta;
    pendingScrollAdjustRef.current = null;
  }, [isLoadingMore]);

  const sendMessage = async () => {
    if (!input.trim() || sending) return;

    const userMessage = input;
    setInput("");
    setSending(true);

    // Optimistically add user message
    const optimisticMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: userMessage,
      pointsCost: 0,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMessage]);

    // Scroll to bottom after adding message
    setTimeout(() => scrollToBottom("smooth"), 50);

    const token = await getAccessToken();
    if (!token) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticMessage.id));
      toast.error("Authentication required");
      setSending(false);
      return;
    }

    const res = await fetch(`/api/agents/${agent.id}/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: userMessage,
        usePro,
      }),
    });

    if (!res.ok) {
      const error = (await res.json()) as { error: string };
      setMessages((prev) => prev.filter((m) => m.id !== optimisticMessage.id));
      toast.error(error.error || "Failed to send message");
      setSending(false);
      return;
    }

    const data = (await res.json()) as {
      success: boolean;
      messageId: string;
      response: string;
      modelUsed: string;
      pointsCost: number;
      balanceAfter: number;
    };

    if (!data.response || !data.messageId) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticMessage.id));
      toast.error("Invalid response from agent");
      setSending(false);
      return;
    }

    // Add assistant message
    const assistantMessage: Message = {
      id: data.messageId,
      role: "assistant",
      content: data.response,
      modelUsed: data.modelUsed,
      pointsCost: data.pointsCost,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, assistantMessage]);

    // Scroll to bottom after response
    setTimeout(() => scrollToBottom("smooth"), 50);

    // Update agent balance without full page refresh
    onBalanceUpdate?.(data.balanceAfter);
    if (data.pointsCost > 0) {
      toast.success(`Message sent (-${data.pointsCost} points)`);
    }

    // Notify parent to refresh chat list (updates sidebar with latest message)
    onMessageSent?.();
    setSending(false);
  };

  // Check if sending should be disabled due to insufficient points
  const insufficientPoints = usePro && (agent.virtualBalance ?? 0) < 1;

  return (
    <div className="flex h-full flex-col">
      {/* Header - Using shared ChatViewHeader component */}
      <div className="shrink-0">
        <ChatViewHeader
          chatDetails={chatDetails}
          sseConnected={true}
          showBackButton={showBackButton}
          onBack={onBack}
          onManageGroup={() => {}}
          onLeaveChat={() => {}}
        />

        {/* Header Separator */}
        <div className="px-4">
          <Separator />
        </div>
      </div>

      {/* Messages - Scrollable, starts at bottom via flex-col-reverse */}
      <div
        ref={chatContainerRef}
        className="relative flex min-h-0 flex-1 flex-col-reverse overflow-y-auto px-4 py-3"
      >
        <div className="flex flex-col space-y-4">
          <MessageList
            messages={chatMessages}
            participants={participants}
            currentUserId={user?.id}
            loading={loading}
            isLoadingMore={isLoadingMore}
            hasMore={hasMore}
            pullDistance={0}
            authenticated={!!user}
            topSentinelRef={topSentinelRef}
            messagesEndRef={messagesEndRef}
          />
        </div>
      </div>

      {/* Footer - Fixed */}
      <div className="shrink-0">
        {/* Insufficient points warning */}
        {insufficientPoints && (
          <div className="px-4 py-2 text-center text-red-500 text-sm">
            Insufficient points for Pro mode. Switch to Free mode or deposit
            points.
          </div>
        )}

        {/* Typing indicator */}
        {sending && (
          <div className="px-4 py-1.5">
            <span className="text-muted-foreground text-xs italic">
              {agent.name} is typing...
            </span>
          </div>
        )}

        {/* Input Separator */}
        <div className="px-4">
          <Separator />
        </div>

        {/* Message Input - using shared component */}
        <MessageInput
          value={input}
          onChange={setInput}
          onSend={sendMessage}
          sending={sending}
          authenticated={!!user}
          disabled={insufficientPoints}
        />
      </div>
    </div>
  );
}
