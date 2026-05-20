'use client';

import { logger } from '@feed/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useChatMessages } from '@/hooks/useChatMessages';
import { useToggleReaction } from '@/hooks/useToggleReaction';
import { useAuthStore } from '@/stores/authStore';
import type {
  Chat,
  ChatDetails,
  ChatFilter,
  Message,
  ReplyToMessage,
} from '../types';

const chatListQueryKey = (userId: string | null) =>
  userId ? (['chat-list', userId] as const) : (['chat-list'] as const);
const CHAT_LIST_STALE_TIME = 30_000; // 30s — chat list changes when new messages arrive
const CHAT_LIST_GC_TIME = 10 * 60_000; // 10 min

export function useChatPage() {
  const router = useRouter();
  const { ready, authenticated, getAccessToken } = useAuth();
  const { user } = useAuthStore();
  const queryClient = useQueryClient();

  // UI state
  const [activeFilter, setActiveFilter] = useState<ChatFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);

  // Data state
  const [allChats, setAllChats] = useState<Chat[]>([]);
  const [chatDetails, setChatDetails] = useState<ChatDetails | null>(null);

  // Loading/sending state
  const [loading, setLoading] = useState(true);
  const [loadingChat, setLoadingChat] = useState(false);
  const [sending, setSending] = useState(false);

  // Message input state
  const [messageInput, setMessageInput] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendWarning, setSendWarning] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState(false);

  // Reply state
  const [replyToMessage, setReplyToMessage] = useState<ReplyToMessage | null>(
    null
  );

  // Leave chat state
  const [isLeaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [isLeavingChat, setIsLeavingChat] = useState(false);
  const [leaveChatError, setLeaveChatError] = useState<string | null>(null);

  // Group modals
  const [isCreateGroupModalOpen, setIsCreateGroupModalOpen] = useState(false);
  const [isGroupManagementModalOpen, setIsGroupManagementModalOpen] =
    useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  // New DM state
  const [pendingDM, setPendingDM] = useState<{
    chatId: string;
    targetUserId: string;
  } | null>(null);

  // Scroll state
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Refs
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollAdjustRef = useRef<{
    previousHeight: number;
    previousTop: number;
  } | null>(null);
  const lastMessageIdRef = useRef<string | null>(null);
  const emptyChatPollAttemptsRef = useRef(0);
  // Track pending initial scroll - cleared when we successfully scroll to bottom
  const pendingInitialScrollRef = useRef<string | null>(null);

  // Debug mode
  const isDebugMode =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1');

  // SSE for real-time messages
  const {
    messages: realtimeMessages,
    isConnected: sseConnected,
    isLoadingMore,
    hasMore,
    loadMore,
    addMessage,
    updateMessage,
    markPendingReactionDelta,
  } = useChatMessages(selectedChatId);

  const toggleReaction = useToggleReaction({
    chatId: selectedChatId,
    messages: realtimeMessages,
    updateMessage,
    markPendingReactionDelta,
  });

  // Fetch chat list — shared query function used by both loadChats and React Query
  const fetchChatList = useCallback(
    async (token: string | null): Promise<Chat[]> => {
      const [personalResponse, gameResponse] = await Promise.all([
        fetch('/api/chats', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }),
        isDebugMode ? fetch('/api/chats?all=true') : Promise.resolve(null),
      ]);

      if (!personalResponse.ok) return [];

      const personalData = await personalResponse.json();

      let gameChats: Chat[] = [];
      if (gameResponse?.ok) {
        const gameData = await gameResponse.json();
        gameChats = gameData.chats || [];
      }

      const combined = [
        ...(personalData.groupChats || []),
        ...(personalData.directChats || []),
        ...gameChats,
      ].sort((a: Chat, b: Chat) => {
        const aTime = a.lastMessage?.createdAt || a.updatedAt;
        const bTime = b.lastMessage?.createdAt || b.updatedAt;
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      });

      // Client-side fallback: filter out DMs with the user's own agents
      return combined.filter((chat: Chat) => {
        if (chat.isGroup) return true;
        if (chat.otherUser?.isAgent && chat.otherUser?.managedBy === user?.id) {
          return false;
        }
        return true;
      });
    },
    [isDebugMode, user?.id]
  );

  // Load chats — uses React Query for caching so revisiting the chat page is instant
  const loadChats = useCallback(async () => {
    setLoading(true);

    if (!isDebugMode) {
      if (!ready || !authenticated) {
        setLoading(false);
        return;
      }
    }

    const token = await getAccessToken();
    if (!token && !isDebugMode) {
      setLoading(false);
      return;
    }

    const chats = await queryClient.fetchQuery({
      queryKey: chatListQueryKey(user?.id ?? null),
      queryFn: () => fetchChatList(token),
      staleTime: CHAT_LIST_STALE_TIME,
      gcTime: CHAT_LIST_GC_TIME,
    });

    setAllChats(chats);
    setLoading(false);
  }, [
    getAccessToken,
    isDebugMode,
    ready,
    authenticated,
    queryClient,
    fetchChatList,
    user?.id,
  ]);

  // Load chat details
  const loadChatDetails = useCallback(
    async (chatId: string) => {
      setLoadingChat(true);

      if (isDebugMode) {
        const response = await fetch(`/api/chats/${chatId}?debug=true`);
        const data = await response.json();
        setChatDetails({
          ...data,
          chat: data.chat || null,
          messages: data.messages || [],
          participants: data.participants || [],
        });
        setLoadingChat(false);
        return;
      }

      const token = await getAccessToken();
      if (!token) {
        setLoadingChat(false);
        return;
      }

      const response = await fetch(`/api/chats/${chatId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status === 404) {
        setLoadingChat(false);
        return;
      }

      if (!response.ok) {
        setLoadingChat(false);
        return;
      }

      const data = await response.json();
      setChatDetails({
        ...data,
        chat: data.chat || null,
        messages: data.messages || [],
        participants: data.participants || [],
      });
      setLoadingChat(false);
    },
    [getAccessToken, isDebugMode]
  );

  // Handle reply to message — resolves sender name from participants
  const handleReplyToMessage = useCallback(
    (msg: Message) => {
      const sender = chatDetails?.participants.find(
        (p) => p.id === msg.senderId
      );
      setReplyToMessage({
        id: msg.id,
        content: msg.content,
        senderId: msg.senderId,
        senderName: sender?.displayName,
      });
    },
    [chatDetails?.participants]
  );

  const clearReplyToMessage = useCallback(() => {
    setReplyToMessage(null);
  }, []);

  // Send message
  const sendMessage = useCallback(async () => {
    if (!selectedChatId || !messageInput.trim() || sending) return;

    setSending(true);
    setSendError(null);
    setSendWarning(null);
    setSendSuccess(false);

    const token = await getAccessToken();
    if (!token) {
      setSendError('Authentication required. Please log in again.');
      setSending(false);
      return;
    }

    const response = await fetch(`/api/chats/${selectedChatId}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        content: messageInput.trim(),
        ...(replyToMessage ? { replyToMessageId: replyToMessage.id } : {}),
      }),
    }).catch((error: Error) => {
      setSendError('Failed to send message. Please try again.');
      setSending(false);
      throw error;
    });

    const data = await response.json();

    if (!response.ok) {
      const message =
        (data && (data.error || data.message)) ||
        'Failed to send message. Please try again.';
      setSendError(message);
      setSending(false);
      return;
    }

    const warnings = Array.isArray(data?.warnings) ? data.warnings : [];
    if (warnings.length > 0) {
      setSendWarning(warnings.join('. '));
      setTimeout(() => setSendWarning(null), 5000);
    }

    setSendSuccess(true);
    setTimeout(() => setSendSuccess(false), 2000);

    if (data.message) {
      addMessage({
        id: data.message.id,
        content: data.message.content,
        chatId: data.message.chatId,
        senderId: data.message.senderId,
        createdAt:
          typeof data.message.createdAt === 'string'
            ? data.message.createdAt
            : new Date(data.message.createdAt).toISOString(),
      });
    }

    setMessageInput('');
    setReplyToMessage(null);
    void loadChats();
    setSending(false);
  }, [
    selectedChatId,
    messageInput,
    sending,
    getAccessToken,
    addMessage,
    loadChats,
    replyToMessage,
  ]);

  // Leave chat
  const handleLeaveChat = useCallback(async () => {
    if (!selectedChatId) return;
    setIsLeavingChat(true);
    setLeaveChatError(null);

    const accessToken = await getAccessToken();
    if (!accessToken) {
      setLeaveChatError('Authentication failed. Please try again.');
      setIsLeavingChat(false);
      return;
    }

    const response = await fetch(
      `/api/chats/${selectedChatId}/participants/me`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    ).catch((error: Error) => {
      setLeaveChatError(error.message);
      setIsLeavingChat(false);
      throw error;
    });

    if (!response.ok) {
      const errorData = await response.json();
      setLeaveChatError(errorData.message || 'Failed to leave chat');
      setIsLeavingChat(false);
      return;
    }

    setLeaveConfirmOpen(false);
    setSelectedChatId(null);
    await loadChats();
    setIsLeavingChat(false);
  }, [selectedChatId, getAccessToken, loadChats]);

  // Group handlers
  const handleGroupCreated = useCallback(
    async (groupId: string, chatId: string) => {
      await loadChats();
      await new Promise((resolve) => setTimeout(resolve, 500));
      setSelectedGroupId(groupId);
      setSelectedChatId(chatId);
      await loadChatDetails(chatId);
    },
    [loadChats, loadChatDetails]
  );

  const handleGroupUpdated = useCallback(async () => {
    await loadChats();
    if (selectedChatId) {
      await loadChatDetails(selectedChatId);
    }
  }, [loadChats, selectedChatId, loadChatDetails]);

  const handleManageGroup = useCallback(async () => {
    if (!chatDetails?.chat.id) return;

    const token = await getAccessToken();
    const response = await fetch(`/api/chats/${chatDetails.chat.id}/group`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch((error: Error) => {
      logger.error('Error fetching group ID', error, 'useChatPage');
      throw error;
    });

    if (response.ok) {
      const data = await response.json();
      setSelectedGroupId(data.groupId);
      setIsGroupManagementModalOpen(true);
    }
  }, [chatDetails?.chat.id, getAccessToken]);

  // Load new DM chat
  const loadNewDMChat = useCallback(
    async (chatId: string, targetUserId: string) => {
      setLoadingChat(true);

      const token = await getAccessToken();
      if (!token) {
        setLoadingChat(false);
        return;
      }

      const response = await fetch(`/api/users/${targetUserId}/profile`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {
        setLoadingChat(false);
        throw new Error('Failed to load user info');
      });

      if (!response.ok) {
        setLoadingChat(false);
        return;
      }

      const userData = await response.json();
      const targetUser = userData.user;

      setChatDetails({
        chat: {
          id: chatId,
          name: null,
          isGroup: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        messages: [],
        participants: [
          {
            id: user!.id,
            displayName: user!.displayName || user!.username || 'You',
            username: user!.username,
            profileImageUrl: user!.profileImageUrl,
          },
          {
            id: targetUser.id,
            displayName:
              targetUser.displayName || targetUser.username || 'User',
            username: targetUser.username,
            profileImageUrl: targetUser.profileImageUrl,
          },
        ],
      });

      const newChat: Chat = {
        id: chatId,
        name: targetUser.displayName || targetUser.username || 'User',
        isGroup: false,
        lastMessage: null,
        updatedAt: new Date().toISOString(),
        otherUser: {
          id: targetUser.id,
          displayName: targetUser.displayName,
          username: targetUser.username,
          profileImageUrl: targetUser.profileImageUrl,
        },
      };

      setAllChats((prev) => {
        if (prev.some((c) => c.id === chatId)) {
          return prev;
        }
        return [newChat, ...prev];
      });

      setLoadingChat(false);
    },
    [getAccessToken, user]
  );

  // Scroll to newest messages
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const container = chatContainerRef.current;
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior });
    }
  }, []);

  const setRefs = useCallback((node: HTMLDivElement | null) => {
    chatContainerRef.current = node;
  }, []);

  // Filter chats
  const filteredByType =
    activeFilter === 'all'
      ? allChats
      : activeFilter === 'dms'
        ? allChats.filter((c) => !c.isGroup)
        : allChats.filter((c) => c.isGroup);

  const filteredChats = searchQuery
    ? filteredByType.filter((chat) =>
        chat.name.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : filteredByType;

  // Load chats on mount
  useEffect(() => {
    if ((ready && authenticated) || isDebugMode) {
      loadChats();
    }
  }, [ready, authenticated, isDebugMode, loadChats]);

  // Dev UX: if a brand-new user has zero chats, poll briefly so the list updates
  // once the next tick auto-joins them into an NPC group chat.
  useEffect(() => {
    // Only in local dev (production builds should not poll)
    if (process.env.NODE_ENV !== 'development') {
      return;
    }
    if (!ready || !authenticated) {
      return;
    }
    if (loading) {
      return;
    }

    const hasAnyChats = allChats.length > 0;
    if (hasAnyChats) {
      emptyChatPollAttemptsRef.current = 0;
      return;
    }

    const maxAttempts = 12; // ~2 minutes at 10s intervals
    if (emptyChatPollAttemptsRef.current >= maxAttempts) {
      return;
    }

    emptyChatPollAttemptsRef.current += 1;
    const timeout = setTimeout(() => {
      void loadChats();
    }, 10_000);

    return () => clearTimeout(timeout);
  }, [ready, authenticated, loading, allChats.length, loadChats]);

  // Load selected chat details
  useEffect(() => {
    lastMessageIdRef.current = null;
    setIsAtBottom(true);
    setReplyToMessage(null);
    if (selectedChatId) {
      pendingInitialScrollRef.current = selectedChatId;
      loadChatDetails(selectedChatId);
    } else {
      pendingInitialScrollRef.current = null;
    }
  }, [selectedChatId, loadChatDetails]);

  // Update chatDetails with realtime messages
  useEffect(() => {
    if (realtimeMessages.length > 0) {
      setChatDetails((prev) => {
        if (!prev) return prev;
        return { ...prev, messages: realtimeMessages };
      });
    }
  }, [realtimeMessages]);

  // Handle new messages - scroll smoothly for incoming messages
  useEffect(() => {
    if (loadingChat) return;

    const msgs = chatDetails?.messages || [];
    const lastId = msgs.length > 0 ? msgs[msgs.length - 1]?.id : null;
    if (!lastId) return;

    const isNewMessage = lastId !== lastMessageIdRef.current;
    const wasEmpty = lastMessageIdRef.current === null;
    lastMessageIdRef.current = lastId;

    // For new messages (not initial load), scroll smoothly if at bottom
    if (!wasEmpty && isNewMessage && isAtBottom) {
      scrollToBottom('smooth');
    }
  }, [chatDetails?.messages, isAtBottom, scrollToBottom, loadingChat]);

  // Handle initial scroll - use MutationObserver to scroll on any DOM change
  useEffect(() => {
    const container = chatContainerRef.current;
    const endMarker = messagesEndRef.current;

    if (
      !container ||
      !endMarker ||
      !selectedChatId ||
      chatDetails?.chat?.id !== selectedChatId
    )
      return;

    if (pendingInitialScrollRef.current !== selectedChatId) return;

    let idleTimeout: ReturnType<typeof setTimeout> | null = null;
    let observer: MutationObserver | null = null;
    const IDLE_MS = 500; // Stop after 500ms of no DOM changes
    const MAX_TIME = 2000; // Hard timeout after 2 seconds
    const startTime = Date.now();

    const scrollToEnd = () => {
      endMarker.scrollIntoView({ behavior: 'auto', block: 'end' });
    };

    const finish = () => {
      observer?.disconnect();
      if (idleTimeout) clearTimeout(idleTimeout);
      pendingInitialScrollRef.current = null;
      setIsAtBottom(true);
    };

    // Scroll immediately
    scrollToEnd();

    // Watch for DOM changes and scroll on each
    observer = new MutationObserver(() => {
      if (pendingInitialScrollRef.current !== selectedChatId) return;

      // Check hard timeout
      if (Date.now() - startTime > MAX_TIME) {
        scrollToEnd();
        finish();
        return;
      }

      // Scroll on mutation
      scrollToEnd();

      // Reset idle timer - finish after no changes for IDLE_MS
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => {
        scrollToEnd();
        finish();
      }, IDLE_MS);
    });

    // Only observe childList and subtree - attributes/characterData are unnecessary for scroll
    observer.observe(container, {
      childList: true,
      subtree: true,
    });

    // Start idle timer (will finish if no mutations happen)
    idleTimeout = setTimeout(() => {
      scrollToEnd();
      finish();
    }, IDLE_MS);

    return () => {
      observer?.disconnect();
      if (idleTimeout) clearTimeout(idleTimeout);
    };
  }, [selectedChatId, chatDetails]);

  // Load older messages when scrolling up (near top)
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatDetails needed to re-run effect when DOM is ready after chat loads
  useEffect(() => {
    const container = chatContainerRef.current;
    const sentinel = topSentinelRef.current;

    if (!container || !sentinel || !selectedChatId) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;

        // Don't load more during initial scroll - wait until scrolled to bottom
        if (pendingInitialScrollRef.current === selectedChatId) return;

        // Check if user is near the top (scrollTop close to 0)
        const nearTop = container.scrollTop <= 200;
        if (entry.isIntersecting && nearTop && hasMore && !isLoadingMore) {
          pendingScrollAdjustRef.current = {
            previousHeight: container.scrollHeight,
            previousTop: container.scrollTop,
          };
          loadMore();
        }
      },
      { root: container, rootMargin: '0px 0px 0px 0px', threshold: 0.1 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [selectedChatId, hasMore, isLoadingMore, loadMore, chatDetails]);

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

  // Track scroll position for auto-scroll behavior
  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const threshold = 50;
      const maxScrollTop = container.scrollHeight - container.clientHeight;
      const atBottom = container.scrollTop >= maxScrollTop - threshold;
      setIsAtBottom(atBottom);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Check for chat ID in URL
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const chatParam = params.get('chat');
      const newDMParam = params.get('newDM');

      if (chatParam && chatParam !== selectedChatId) {
        setSelectedChatId(chatParam);

        // If this is a new DM, store it as pending until user is available
        if (newDMParam && chatParam.startsWith('dm-')) {
          setPendingDM({ chatId: chatParam, targetUserId: newDMParam });
        }

        // Clean up URL using Next.js router to keep router state in sync
        router.replace('/chats');
      }
    }
  }, [selectedChatId, router]);

  // Load pending DM once user is available
  useEffect(() => {
    if (pendingDM && user) {
      loadNewDMChat(pendingDM.chatId, pendingDM.targetUserId);
      setPendingDM(null);
    }
  }, [pendingDM, user, loadNewDMChat]);

  return {
    // Auth
    ready,
    authenticated,
    user,

    // UI state
    activeFilter,
    setActiveFilter,
    searchQuery,
    setSearchQuery,
    selectedChatId,
    setSelectedChatId,

    // Data
    filteredChats,
    chatDetails,

    // Loading state
    loading,
    loadingChat,
    sending,
    isLoadingMore,
    hasMore,

    // Message state
    messageInput,
    setMessageInput,
    sendError,
    sendWarning,
    sendSuccess,

    // Leave chat
    isLeaveConfirmOpen,
    setLeaveConfirmOpen,
    isLeavingChat,
    leaveChatError,
    setLeaveChatError,
    handleLeaveChat,

    // Group modals
    isCreateGroupModalOpen,
    setIsCreateGroupModalOpen,
    isGroupManagementModalOpen,
    setIsGroupManagementModalOpen,
    selectedGroupId,
    setSelectedGroupId,
    handleGroupCreated,
    handleGroupUpdated,
    handleManageGroup,

    // SSE
    sseConnected,

    // Refs
    messagesEndRef,
    topSentinelRef,
    setRefs,

    // Reply
    replyToMessage,
    handleReplyToMessage,
    clearReplyToMessage,

    // Actions
    sendMessage,
    toggleReaction,
    loadChats,
  };
}
