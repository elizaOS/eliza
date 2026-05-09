/**
 * Eliza chat interface component providing full-featured chat functionality.
 * Supports text and voice messages, streaming responses, document integration,
 * model tier selection, audio playback, and room management.
 *
 * @param props - Chat interface configuration
 * @param props.onMessageSent - Optional callback when a message is sent
 * @param props.character - Optional character data for the chat session
 */

"use client";

import {
  Button,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/cloud-ui";
import {
  ArrowUp,
  Check,
  Crown,
  FileText,
  Globe,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Mic,
  Plus,
  Sparkles,
  Square,
  Volume2,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import type {
  ReasoningChunkData,
  StreamChunkData,
  StreamingMessage,
} from "@/lib/hooks/use-streaming-message";
import { sendStreamingMessage } from "@/lib/hooks/use-streaming-message";
import { useThrottledStreamingUpdate } from "@/lib/hooks/use-throttled-streaming";
import { useChatStore } from "@/lib/stores/chat-store";
import { cn } from "@/lib/utils";
import { ensureAudioFormat } from "@/lib/utils/audio";
import { ElizaAvatar } from "./eliza-avatar";
import { useAudioPlayer } from "./hooks/use-audio-player";
import { useAudioRecorder } from "./hooks/use-audio-recorder";
import { useModelTier } from "./hooks/use-model-tier";
import { MemoizedChatMessage } from "./memoized-chat-message";
import "highlight.js/styles/github-dark.css";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@elizaos/cloud-ui";
import type { Voice as CustomVoice } from "@elizaos/cloud-ui";
import { type ChatMediaAttachment, ContentType } from "@elizaos/cloud-ui";
import {
  ADDITIONAL_IMAGE_MODELS,
  ADDITIONAL_MODELS,
  DEFAULT_IMAGE_MODEL,
  formatSelectorProvider,
  IMAGE_TIERS,
} from "@/lib/models";
import { useAvailableModels } from "./hooks/use-available-models";
import { useModelAvailability } from "./hooks/use-model-availability";
import { PendingDocumentsProcessor } from "./pending-documents-processor";

interface Message {
  id: string;
  content: {
    text: string;
    clientMessageId?: string;
    attachments?: ChatMediaAttachment[];
  };
  isAgent: boolean;
  createdAt: number;
}

/**
 * Display version of AgentInfo with UI-specific fields.
 * Used for chat interface display (simplified from full AgentInfo).
 */
interface AgentInfoDisplay {
  id?: string;
  name?: string;
  avatarUrl?: string;
}

interface CharacterData {
  id: string;
  name: string;
  avatarUrl?: string | null;
  avatar_url?: string | null;
  character_data?: {
    bio?: string | string[];
    personality?: string;
    description?: string;
    avatarUrl?: string | null;
    avatar_url?: string | null;
  };
}

interface ElizaChatInterfaceProps {
  onMessageSent?: () => void | Promise<void>;
  character?: CharacterData;
  expectedCharacterId?: string; // Used to validate room belongs to expected character during navigation
}

const tierIcons: Record<string, React.ReactNode> = {
  fast: <Zap className="h-3.5 w-3.5" />,
  pro: <Sparkles className="h-3.5 w-3.5" />,
  ultra: <Crown className="h-3.5 w-3.5" />,
};

/**
 * Returns responsive text size classes based on character name length.
 * Shorter names get larger fonts, longer names scale down for readability.
 */
function getGreetingTextSizeClass(nameLength: number): string {
  if (nameLength > 20) return "text-2xl sm:text-3xl md:text-4xl";
  if (nameLength > 12) return "text-3xl sm:text-4xl md:text-5xl";
  return "text-4xl sm:text-5xl md:text-6xl";
}

/**
 * Check if an error message indicates the anonymous message limit was reached.
 * Centralized detection to ensure consistent handling across onError and catch blocks.
 */
function isMessageLimitError(errorMessage: string): boolean {
  const lowerMsg = errorMessage.toLowerCase();
  return lowerMsg.includes("message limit") || lowerMsg.includes("sign up to continue");
}

export function ElizaChatInterface({
  onMessageSent,
  character,
  expectedCharacterId,
}: ElizaChatInterfaceProps) {
  // Use chat store for room and character management
  const {
    roomId,
    rooms,
    isLoadingRooms,
    loadRooms,
    createRoom: createRoomInStore,
    selectedCharacterId,
    availableCharacters,
    setAvailableCharacters,
    pendingMessage,
    setPendingMessage,
    anonymousSessionToken,
  } = useChatStore();

  // Check authentication status for features that require it
  const { authenticated } = useSessionAuth();

  const [messages, setMessages] = useState<Message[]>([]);
  const [agentInfo, setAgentInfo] = useState<AgentInfoDisplay | null>(null);
  const [inputText, setInputText] = useState("");
  const inputTextRef = useRef(inputText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isPendingMessageProcessingRef = useRef(false);
  const pendingMessageToSendRef = useRef<string | null>(null);
  const isCreatingRoomRef = useRef(false);
  // Promise-based room creation tracking to avoid race conditions
  const roomCreationPromiseRef = useRef<Promise<string | null> | null>(null);
  // Ref to hold sendMessage function - avoids TDZ error when used in effects before definition
  const sendMessageRef = useRef<((textOverride?: string) => Promise<void>) | null>(null);
  // Track newly created rooms to skip unnecessary loading (prevents flicker)
  const justCreatedRoomIdRef = useRef<string | null>(null);
  // Track if we're in the middle of sending to prevent loading state flicker
  const isSendingRef = useRef(false);

  // Get character name from prop (preferred), store, or agentInfo (memoized)
  const selectedCharacter = useMemo(
    () => availableCharacters.find((char) => char.id === selectedCharacterId),
    [availableCharacters, selectedCharacterId],
  );
  const characterName = useMemo(
    () => character?.name || selectedCharacter?.name || agentInfo?.name || "Agent",
    [character?.name, selectedCharacter?.name, agentInfo?.name],
  );

  // Fetch shared character data if not available in store (for shared links)
  // This is a client-side fallback in case server-side fetch wasn't performed
  const fetchedCharacterRef = useRef<string | null>(null);
  useEffect(() => {
    const targetId = expectedCharacterId || selectedCharacterId;

    // Skip if no character ID or already fetched or character is in store
    if (!targetId || fetchedCharacterRef.current === targetId) return;
    if (availableCharacters.some((c) => c.id === targetId)) return;

    // Track this fetch to prevent race conditions
    const currentTargetId = targetId;
    fetchedCharacterRef.current = targetId;

    const controller = new AbortController();

    // Fetch character data from public API
    fetch(`/api/characters/${targetId}/public`, { signal: controller.signal })
      .then((res) => {
        if (res.ok) return res.json();
        throw new Error("Failed to fetch character");
      })
      .then((data) => {
        // Check if this is still the current target (prevents race condition)
        if (fetchedCharacterRef.current !== currentTargetId) return;

        if (data.success && data.data) {
          const charData = data.data;
          // Add to available characters in store
          setAvailableCharacters([
            ...availableCharacters,
            {
              id: charData.id,
              name: charData.name,
              username: charData.username || undefined,
              avatarUrl: charData.avatarUrl || undefined,
            },
          ]);
        }
      })
      .catch((err) => {
        // Ignore abort errors
        if (err instanceof Error && err.name === "AbortError") return;
        console.warn("[ElizaChat] Could not fetch shared character:", err);
      });

    return () => {
      controller.abort();
    };
  }, [expectedCharacterId, selectedCharacterId, availableCharacters, setAvailableCharacters]);

  // Get avatar URL from prop (preferred), store, or agentInfo
  // Check both top-level and nested character_data properties
  const characterAvatarUrl = useMemo(
    () =>
      character?.avatarUrl ||
      character?.avatar_url ||
      character?.character_data?.avatarUrl ||
      character?.character_data?.avatar_url ||
      selectedCharacter?.avatarUrl ||
      agentInfo?.avatarUrl,
    [
      character?.avatarUrl,
      character?.avatar_url,
      character?.character_data?.avatarUrl,
      character?.character_data?.avatar_url,
      selectedCharacter?.avatarUrl,
      agentInfo?.avatarUrl,
    ],
  );

  // Consolidated loading states
  const [loadingState, setLoadingState] = useState({
    isSending: false,
    isLoadingMessages: false,
    isProcessingSTT: false,
  });

  const [error, setError] = useState<string | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const thinkingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Throttled streaming updates (reduces re-renders from ~100/sec to ~60/sec)
  const {
    accumulateChunk,
    clearAll: clearAllStreaming,
    scheduleUpdate,
  } = useThrottledStreamingUpdate();
  // Track rendered message keys to prevent re-animation
  const renderedMessagesRef = useRef<Set<string>>(new Set());

  const [audioState, setAudioState] = useState<{
    autoPlayTTS: boolean;
    currentPlayingId: string | null;
    selectedVoiceId: string | null;
    customVoices: CustomVoice[];
  }>(() => ({
    autoPlayTTS: false,
    currentPlayingId: null,
    selectedVoiceId:
      typeof window !== "undefined" ? localStorage.getItem("eliza-selected-voice-id") : null,
    customVoices: [],
  }));

  const [isUploadingFiles, setIsUploadingFiles] = useState(false);
  const [createImageEnabled, setCreateImageEnabled] = useState(false);
  const [selectedImageModel, setSelectedImageModel] = useState(DEFAULT_IMAGE_MODEL);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  // Track if anonymous user has reached message limit - disables input
  const [isMessageLimitReached, setIsMessageLimitReached] = useState(false);

  // Custom model selection (when user picks from "More models")
  const [customModel, setCustomModel] = useState<{
    id: string;
    name: string;
    modelId: string;
  } | null>(null);

  // Model selector tab: "text" or "image"
  const [modelSelectorTab, setModelSelectorTab] = useState<"text" | "image">("text");
  const {
    models: availableTextModels,
    isLoading: isLoadingTextModels,
    error: availableTextModelsError,
  } = useAvailableModels();

  // Model availability check - shows which models are currently available
  const allImageModelIds = useMemo(
    () => [...IMAGE_TIERS.map((t) => t.model), ...ADDITIONAL_IMAGE_MODELS].map((m) => m.modelId),
    [],
  );
  const { availability: modelAvailability, reasons: modelUnavailableReasons } =
    useModelAvailability(allImageModelIds);

  // Reasoning/chain-of-thought state - shows LLM's thinking process
  const [reasoningState, setReasoningState] = useState<{
    text: string;
    phase: "planning" | "actions" | "response" | null;
    isVisible: boolean;
  }>({ text: "", phase: null, isVisible: false });

  const messageAudioUrls = useRef<Map<string, string>>(new Map());
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const voicesFetchedRef = useRef(false);

  // Clear audio cache when voice changes (so messages regenerate with new voice)
  useEffect(() => {
    if (messageAudioUrls.current.size > 0) {
      // Revoke all object URLs to prevent memory leaks
      messageAudioUrls.current.forEach((url) => URL.revokeObjectURL(url));
      messageAudioUrls.current.clear();
    }
  }, []);

  // Cleanup refs on unmount to prevent memory leaks
  useEffect(() => {
    // Capture ref value inside effect for cleanup
    const renderedMessages = renderedMessagesRef.current;
    const thinkingTimeout = thinkingTimeoutRef.current;
    const audioUrls = messageAudioUrls.current;

    return () => {
      if (thinkingTimeout) {
        clearTimeout(thinkingTimeout);
      }
      clearAllStreaming();
      renderedMessages.clear();
      // Revoke all audio URLs on unmount
      audioUrls.forEach((url) => URL.revokeObjectURL(url));
      audioUrls.clear();
    };
  }, [clearAllStreaming]);

  const recorder = useAudioRecorder();
  const player = useAudioPlayer();

  const {
    selectedTier,
    selectedModelId,
    tiers,
    setTier,
    isLoading: isLoadingModels,
  } = useModelTier();
  const tierModelIds = useMemo(() => new Set(tiers.map((tier) => tier.modelId)), [tiers]);
  const moreTextModels = useMemo(
    () =>
      (availableTextModels.length > 0 ? availableTextModels : ADDITIONAL_MODELS)
        .filter((model) => !tierModelIds.has(model.modelId))
        .filter(
          (model, index, models) =>
            models.findIndex((candidate) => candidate.modelId === model.modelId) === index,
        ),
    [availableTextModels, tierModelIds],
  );

  // Reset message limit state when user authenticates (e.g., signs up via modal)
  useEffect(() => {
    if (authenticated && isMessageLimitReached) {
      setIsMessageLimitReached(false);
    }
  }, [authenticated, isMessageLimitReached]);

  const loadMessages = useCallback(async (targetRoomId: string, skipLoadingState = false) => {
    // Don't show loading state if we're sending (prevents flicker) or explicitly skipped
    if (!skipLoadingState && !isSendingRef.current) {
      setLoadingState((prev) => ({ ...prev, isLoadingMessages: true }));
    }
    try {
      const response = await fetch(`/api/eliza/rooms/${targetRoomId}`, {
        credentials: "include",
      });
      if (response.ok) {
        const data = await response.json();
        // Only update messages if we're not in the middle of sending
        // This prevents overwriting optimistic messages with stale data
        if (!isSendingRef.current) {
          setMessages(data.messages || []);
        }
        if (data.agent) {
          setAgentInfo(data.agent);
        }
      }
    } catch (err) {
      console.error("Error loading messages:", err);
    } finally {
      if (!skipLoadingState && !isSendingRef.current) {
        setLoadingState((prev) => ({ ...prev, isLoadingMessages: false }));
      }
    }
  }, []); // Stable - no dependencies needed

  // Load messages when roomId from context changes
  useEffect(() => {
    // Use expectedCharacterId (from URL/props) as source of truth, fallback to store's selectedCharacterId
    const targetCharacterId = expectedCharacterId || selectedCharacterId;

    if (roomId) {
      // CRITICAL: Validate room belongs to expected character before loading
      // This prevents loading stale room data during navigation race conditions
      const rooms = useChatStore.getState().rooms;
      const room = rooms.find((r) => r.id === roomId);
      if (room && room.characterId && targetCharacterId && room.characterId !== targetCharacterId) {
        return; // Skip loading - room belongs to different character
      }

      // Skip loading for newly created rooms (they're empty, shows centered layout immediately)
      // New rooms don't appear in the rooms list until agent replies
      if (!room) {
        // Clear any existing messages from previous chat
        setMessages([]);
        setAgentInfo(null);
        setError(null);
        return; // Skip loading - room is new and empty
      }

      // Skip loading for rooms we just created during message send (prevents flicker)
      if (justCreatedRoomIdRef.current === roomId) {
        justCreatedRoomIdRef.current = null; // Clear the flag
        return; // Skip loading - room is empty and we have optimistic messages
      }
      // Skip loading if we're currently sending (prevents flicker)
      if (isSendingRef.current) {
        return;
      }
      loadMessages(roomId);
    } else {
      // Room was deleted or cleared - reset to empty state
      setMessages([]);
      setAgentInfo(null);
      setError(null);
      setLoadingState((prev) => ({ ...prev, isLoadingMessages: false }));
    }
  }, [roomId, selectedCharacterId, expectedCharacterId, loadMessages]);

  const createRoom = useCallback(
    async (characterId?: string | null, skipLoadRooms = false) => {
      const charIdToUse = characterId !== undefined ? characterId : selectedCharacterId;
      setError(null);
      // Use store's createRoom which handles the API call
      // Pass skipLoadRooms to prevent unnecessary room list reload during message send
      const newRoomId = await createRoomInStore(charIdToUse);

      if (!newRoomId) {
        throw new Error("Failed to create room");
      }

      // New rooms are empty - skip loading to avoid race with optimistic messages
      return newRoomId;
    },
    [createRoomInStore, selectedCharacterId],
  );

  const handleStreamMessage = useCallback(
    (messageData: StreamingMessage) => {
      if (messageData.type === "agent") {
        setReasoningState({ text: "", phase: null, isVisible: false });
      }

      setMessages((prev) => {
        if (messageData.type === "agent") {
          clearAllStreaming();
          if (thinkingTimeoutRef.current) {
            clearTimeout(thinkingTimeoutRef.current);
            thinkingTimeoutRef.current = null;
          }
          if (prev.some((m) => m.id === messageData.id)) return prev;

          const streamingIndex = prev.findIndex((m) => m.id === `streaming-${messageData.id}`);
          if (streamingIndex !== -1) {
            const updated = [...prev];
            // Use final message content (properly parsed) but preserve streaming ID transition
            // The streaming text should match the final text after XML filtering
            // Prefer final message text as it's the authoritative parsed response
            updated[streamingIndex] = {
              ...updated[streamingIndex],
              id: messageData.id,
              content: {
                ...messageData.content,
                // Use final message text - it's properly parsed and may include
                // post-processing like AI-speak removal
                text: messageData.content.text || updated[streamingIndex].content.text,
              },
            };
            return updated.filter(
              (m) => !m.id.startsWith("thinking-") && !m.id.startsWith("temp-"),
            );
          }

          return [
            ...prev.filter(
              (m) =>
                !m.id.startsWith("thinking-") &&
                !m.id.startsWith("temp-") &&
                !m.id.startsWith("streaming-"),
            ),
            messageData,
          ];
        }

        // Handle thinking indicator
        if (messageData.type === "thinking") {
          const withoutThinking = prev.filter((m) => !m.id.startsWith("thinking-"));
          return [...withoutThinking, messageData];
        }

        // Handle user messages
        if (messageData.type === "user") {
          // Replace temp message with real one
          const tempIndex = prev.findIndex(
            (m) => m.id.startsWith("temp-") && m.content.text === messageData.content.text,
          );

          if (tempIndex !== -1) {
            const updated = [...prev];
            updated[tempIndex] = messageData;
            return updated;
          }

          // Check for duplicates
          if (prev.some((m) => m.id === messageData.id)) {
            return prev;
          }

          return [...prev, messageData];
        }

        return prev;
      });
    },
    [clearAllStreaming],
  );

  // Handle reasoning/chain-of-thought chunks - shows LLM's planning
  const handleReasoningChunk = useCallback((chunkData: ReasoningChunkData) => {
    const { chunk, phase } = chunkData;
    setReasoningState((prev) => ({
      text: prev.text + chunk,
      phase: phase as "planning" | "actions" | "response",
      isVisible: true,
    }));
  }, []);

  // Handle real-time streaming chunks - updates message text incrementally
  const handleStreamChunk = useCallback(
    (chunkData: StreamChunkData) => {
      const { messageId, chunk } = chunkData;

      // Accumulate text in hook (no re-render)
      accumulateChunk(messageId, chunk);

      // Schedule throttled UI update
      scheduleUpdate(messageId, (newText) => {
        setMessages((prev) => {
          // Check if we already have a streaming message for this messageId
          const streamingMsgIndex = prev.findIndex((m) => m.id === `streaming-${messageId}`);

          if (streamingMsgIndex !== -1) {
            // Update existing streaming message
            const updated = [...prev];
            updated[streamingMsgIndex] = {
              ...updated[streamingMsgIndex],
              content: { ...updated[streamingMsgIndex].content, text: newText },
            };
            return updated;
          }

          // First chunk - create a new streaming message and remove thinking indicator
          const withoutThinking = prev.filter((m) => !m.id.startsWith("thinking-"));

          // Clear thinking timeout
          if (thinkingTimeoutRef.current) {
            clearTimeout(thinkingTimeoutRef.current);
            thinkingTimeoutRef.current = null;
          }

          // Add new streaming message
          const streamingMessage: Message = {
            id: `streaming-${messageId}`,
            content: { text: newText },
            isAgent: true,
            createdAt: Date.now(),
          };

          return [...withoutThinking, streamingMessage];
        });
      });
    },
    [accumulateChunk, scheduleUpdate],
  );

  // Handle message limit reached - shows signup prompt instead of error
  const handleMessageLimitReached = useCallback(() => {
    clearAllStreaming();
    if (thinkingTimeoutRef.current) {
      clearTimeout(thinkingTimeoutRef.current);
      thinkingTimeoutRef.current = null;
    }

    setIsMessageLimitReached(true);

    setMessages((prev) => {
      // Filter out temp (optimistic user message), thinking, and streaming messages
      // The user's message was rejected, so we shouldn't show it
      const filtered = prev.filter(
        (msg) =>
          !msg.id.startsWith("temp-") &&
          !msg.id.startsWith("thinking-") &&
          !msg.id.startsWith("streaming-"),
      );

      const signupPromptMessage: Message = {
        id: `signup-prompt-${Date.now()}`,
        content: {
          text: `I'd love to continue our conversation!\n\nYou've used all your free messages. **Sign up for free** to keep chatting with me and unlock unlimited conversations.`,
        },
        isAgent: true,
        createdAt: Date.now(),
      };

      return [...filtered, signupPromptMessage];
    });
  }, [clearAllStreaming]);

  const sendMessage = useCallback(
    async (textOverride?: string) => {
      const messageText = textOverride?.trim() || inputTextRef.current.trim();
      if (!messageText || loadingState.isSending) return;

      if (!textOverride) {
        setInputText("");
      }
      // Set both state and ref to track sending status
      setLoadingState((prev) => ({ ...prev, isSending: true }));
      isSendingRef.current = true;
      setError(null);

      // Reset scroll tracking - user wants to see their message and response
      userScrolledUpRef.current = false;

      // Track if we created a new room (to skip loadRooms later)
      let didCreateNewRoom = false;

      try {
        // If no room exists, create one first
        let currentRoomId = roomId;
        if (!currentRoomId) {
          // If room creation is already in progress, await the existing promise
          if (isCreatingRoomRef.current && roomCreationPromiseRef.current) {
            const existingRoomId = await roomCreationPromiseRef.current;
            if (!existingRoomId) {
              setError("Room creation failed");
              setLoadingState((prev) => ({ ...prev, isSending: false }));
              isSendingRef.current = false;
              return;
            }
            currentRoomId = existingRoomId;
          } else {
            // Start new room creation and store the promise
            // Pass skipLoadRooms=true to prevent unnecessary room list reload
            isCreatingRoomRef.current = true;
            roomCreationPromiseRef.current = createRoom(selectedCharacterId, true)
              .then((newRoomId) => {
                isCreatingRoomRef.current = false;
                roomCreationPromiseRef.current = null;
                return newRoomId;
              })
              .catch((err) => {
                isCreatingRoomRef.current = false;
                roomCreationPromiseRef.current = null;
                console.error("[ElizaChat] Room creation error:", err);
                return null;
              });

            const newRoomId = await roomCreationPromiseRef.current;
            if (!newRoomId) {
              setError("Room creation returned empty ID");
              setLoadingState((prev) => ({ ...prev, isSending: false }));
              isSendingRef.current = false;
              return;
            }
            currentRoomId = newRoomId;
            didCreateNewRoom = true;
            // Mark this room as just created to skip loading in the useEffect
            justCreatedRoomIdRef.current = newRoomId;
          }
        }

        // Add optimistic temp user message
        const clientMessageId = `temp-${crypto.randomUUID()}`;
        const now = Date.now();
        const tempUserMessage: Message = {
          id: clientMessageId,
          content: { text: messageText },
          isAgent: false,
          createdAt: now,
        };

        // Add optimistic thinking indicator immediately for instant feedback
        const optimisticThinkingMessage: Message = {
          id: `thinking-${Date.now()}`,
          content: { text: "" },
          isAgent: true,
          createdAt: now + 1, // Slightly after user message to ensure ordering
        };

        setMessages((prev) => [...prev, tempUserMessage, optimisticThinkingMessage]);

        // Reset reasoning state for new message
        setReasoningState({ text: "", phase: null, isVisible: false });
        // Clear loading state immediately so chat interface shows right away
        setLoadingState((prev) => ({ ...prev, isLoadingMessages: false }));

        // Safety timeout: remove thinking indicator after 30 seconds if no response
        thinkingTimeoutRef.current = setTimeout(() => {
          setMessages((prev) => prev.filter((m) => !m.id.startsWith("thinking-")));
          console.warn("[Chat] Thinking indicator timeout - agent took too long to respond");
        }, 30000);

        // Stream the response using single endpoint
        await sendStreamingMessage({
          roomId: currentRoomId,
          text: messageText,
          model: customModel?.modelId || selectedModelId, // Use custom model if selected, otherwise tier model
          sessionToken: anonymousSessionToken || undefined, // Pass session token for anonymous users
          webSearchEnabled, // Pass web search toggle state
          createImageEnabled, // Pass create image toggle state
          imageModel: selectedImageModel.modelId, // Pass selected image model for image generation
          onMessage: handleStreamMessage,
          onChunk: handleStreamChunk, // Handle real-time streaming chunks
          onReasoning: handleReasoningChunk, // Handle chain-of-thought display
          onError: (errorMsg) => {
            // Check for anonymous message limit error
            if (isMessageLimitError(errorMsg) && !authenticated) {
              handleMessageLimitReached();
              return;
            }

            // Regular error handling
            setError(errorMsg);
            toast.error(errorMsg);
            clearAllStreaming();
            setMessages((prev) =>
              prev.filter(
                (msg) =>
                  !msg.id.startsWith("temp-") &&
                  !msg.id.startsWith("thinking-") &&
                  !msg.id.startsWith("streaming-"),
              ),
            );
            if (thinkingTimeoutRef.current) {
              clearTimeout(thinkingTimeoutRef.current);
              thinkingTimeoutRef.current = null;
            }
          },
          onComplete: () => {
            // Reload rooms to update lastText, lastTime, and AI-generated title
            // Title is generated automatically by the server-side room-title service
            const delay = didCreateNewRoom ? 500 : 100;
            setTimeout(() => {
              loadRooms();
            }, delay);

            // Notify parent that a message was sent successfully (for anonymous message counting)
            if (onMessageSent) {
              onMessageSent();
            }
          },
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Failed to send message";

        // Check for anonymous message limit error
        if (isMessageLimitError(errorMessage) && !authenticated) {
          handleMessageLimitReached();
        } else {
          setError(errorMessage);
          console.error("Error sending message:", err);
          toast.error(errorMessage);
          clearAllStreaming();
          setMessages((prev) =>
            prev.filter(
              (msg) =>
                !msg.id.startsWith("temp-") &&
                !msg.id.startsWith("thinking-") &&
                !msg.id.startsWith("streaming-"),
            ),
          );
          if (thinkingTimeoutRef.current) {
            clearTimeout(thinkingTimeoutRef.current);
            thinkingTimeoutRef.current = null;
          }
        }
      } finally {
        setLoadingState((prev) => ({ ...prev, isSending: false }));
        isSendingRef.current = false;
      }
    },
    [
      loadingState.isSending,
      roomId,
      createRoom,
      selectedCharacterId,
      selectedModelId,
      customModel,
      anonymousSessionToken,
      webSearchEnabled,
      createImageEnabled,
      selectedImageModel,
      handleStreamMessage,
      handleStreamChunk,
      handleReasoningChunk,
      handleMessageLimitReached,
      loadRooms,
      onMessageSent,
      clearAllStreaming,
      authenticated,
    ],
  );

  // Handle pending message from landing page
  useEffect(() => {
    // Guard: Only process if we have a pending message and not already processing
    if (!pendingMessage || isPendingMessageProcessingRef.current || loadingState.isSending) {
      return;
    }

    let timeoutId1: NodeJS.Timeout | null = null;
    let timeoutId2: NodeJS.Timeout | null = null;
    let isCancelled = false;

    // If no roomId exists, create one first
    if (!roomId) {
      isPendingMessageProcessingRef.current = true;

      // Store the message in ref so we can send it after room is created
      pendingMessageToSendRef.current = pendingMessage;

      // Clear from Zustand immediately to prevent re-triggering
      setPendingMessage(null);

      createRoom()
        .then(() => {
          // Room creation will update roomId, which will trigger sending logic
        })
        .catch(() => {
          if (!isCancelled) {
            isPendingMessageProcessingRef.current = false;
          }
        });
      return () => {
        isCancelled = true;
      };
    }

    // If we have a roomId and a pending message in ref (after room creation), send it
    if (roomId && pendingMessageToSendRef.current && !loadingState.isLoadingMessages) {
      const messageToSend = pendingMessageToSendRef.current;

      // Clear the ref
      pendingMessageToSendRef.current = null;

      // Auto-send after a short delay (wait for room to be fully ready)
      timeoutId1 = setTimeout(() => {
        if (isCancelled) return;
        setInputText(messageToSend);
        timeoutId2 = setTimeout(() => {
          if (isCancelled) return;
          // Use ref to avoid TDZ - sendMessage is defined later in the component
          sendMessageRef.current?.(messageToSend).finally(() => {
            // Reset processing flag after message is sent
            if (!isCancelled) {
              isPendingMessageProcessingRef.current = false;
            }
          });
        }, 100);
      }, 500);
    }

    return () => {
      isCancelled = true;
      if (timeoutId1) clearTimeout(timeoutId1);
      if (timeoutId2) clearTimeout(timeoutId2);
    };
  }, [
    roomId,
    loadingState.isSending,
    pendingMessage,
    loadingState.isLoadingMessages,
    createRoom,
    setPendingMessage,
  ]);

  // Extract stable values from audioState to prevent callback recreation
  const selectedVoiceIdRef = useRef(audioState.selectedVoiceId);
  const autoPlayTTSRef = useRef(audioState.autoPlayTTS);

  // Keep refs in sync with state
  useEffect(() => {
    selectedVoiceIdRef.current = audioState.selectedVoiceId;
    autoPlayTTSRef.current = audioState.autoPlayTTS;
  }, [audioState.selectedVoiceId, audioState.autoPlayTTS]);

  const generateSpeech = useCallback(
    async (text: string, messageId: string) => {
      try {
        const currentVoiceId = selectedVoiceIdRef.current;
        const requestBody: { text: string; voiceId?: string } = { text };
        if (currentVoiceId) {
          requestBody.voiceId = currentVoiceId;
        }

        const response = await fetch("/api/elevenlabs/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          throw new Error("Failed to generate speech");
        }

        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        messageAudioUrls.current.set(messageId, audioUrl);

        if (autoPlayTTSRef.current) {
          setAudioState((prev) => ({ ...prev, currentPlayingId: messageId }));
          await player.playAudio(audioUrl);
        }

        return audioUrl;
      } catch (error) {
        console.error("TTS error:", error);
        toast.error("Failed to generate speech");
        throw error;
      }
    },
    [player], // Only player is needed, audioState values accessed via refs
  );

  // Load custom voices on mount (only for authenticated users)
  useEffect(() => {
    // Only fetch custom voices for authenticated users
    // This API requires authentication and will return 401 for anonymous users
    if (!authenticated) {
      return;
    }

    // Prevent duplicate fetches - only fetch once per component lifecycle
    if (voicesFetchedRef.current) {
      return;
    }
    voicesFetchedRef.current = true;

    const fetchCustomVoices = async () => {
      try {
        const response = await fetch("/api/elevenlabs/voices/user");
        if (response.ok) {
          const data = await response.json();
          if (data.success && Array.isArray(data.voices)) {
            setAudioState((prev) => ({ ...prev, customVoices: data.voices }));
          }
        }
      } catch {
        // 401 errors are expected for users without voice features
      }
    };

    fetchCustomVoices();
  }, [authenticated]);

  const handleVoiceInput = useCallback(() => {
    if (recorder.isRecording) {
      recorder.stopRecording();
    } else {
      recorder.startRecording();
      if (recorder.error) {
        toast.error(recorder.error);
      }
    }
  }, [recorder]);

  const handleFileUpload = useCallback(
    async (files: File[]) => {
      if (!selectedCharacterId || files.length === 0) return;

      setIsUploadingFiles(true);

      try {
        const formData = new FormData();
        formData.append("characterId", selectedCharacterId);

        for (const file of files) {
          formData.append("files", file, file.name);
        }

        const response = await fetch("/api/v1/documents/upload-file", {
          method: "POST",
          body: formData,
        });

        if (response.ok) {
          toast.success(`${files.length} file(s) uploaded`, {
            description: "Files are now searchable",
          });
        } else {
          const data = await response.json();
          toast.error("Upload failed", {
            description: data.error || "Failed to upload files",
          });
        }
      } catch (error) {
        console.error("[ElizaChat] File upload error:", error);
        toast.error("Upload failed", {
          description: "Network error - please try again",
        });
      } finally {
        setIsUploadingFiles(false);
      }
    },
    [selectedCharacterId],
  );

  // Process audio blob when it becomes available after recording stops
  useEffect(() => {
    const processAudioBlob = async () => {
      // Guard: Don't process if no audio blob or already processing
      if (!recorder.audioBlob || loadingState.isProcessingSTT) return;

      setLoadingState((prev) => ({ ...prev, isProcessingSTT: true }));

      try {
        // Ensure the blob is in proper audio format (fix Safari/macOS video/webm issue)
        const audioBlob = await ensureAudioFormat(recorder.audioBlob);

        // Create FormData with audio file
        const formData = new FormData();
        const audioFile = new File([audioBlob], "recording.webm", {
          type: audioBlob.type || "audio/webm",
        });
        formData.append("audio", audioFile);

        // Call STT API
        const response = await fetch("/api/elevenlabs/stt", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          toast.error(errorData.error || "Failed to transcribe audio");
          console.error("[ElizaChat STT] API error:", errorData);
          return;
        }

        const { transcript } = await response.json();

        if (!transcript || transcript.trim().length === 0) {
          toast.error("No speech detected. Please try again.");
          console.warn("[ElizaChat STT] Empty transcript received");
          return;
        }

        // Auto-send the transcribed message (will create room if needed)
        // Use ref to avoid TDZ - sendMessage is defined later in the component
        await sendMessageRef.current?.(transcript);
      } catch (error) {
        console.error("[ElizaChat STT] Processing error:", error);
        toast.error("Failed to process audio. Please try again.");
      } finally {
        // Cleanup: Clear recording and reset processing state
        recorder.clearRecording();
        setLoadingState((prev) => ({ ...prev, isProcessingSTT: false }));
      }
    };

    processAudioBlob();
  }, [recorder.audioBlob, loadingState.isProcessingSTT, recorder]);

  // Auto-generate TTS for new agent messages (only if autoPlayTTS is enabled)
  useEffect(() => {
    // Only generate TTS if auto-play is enabled
    if (!autoPlayTTSRef.current) return;

    const newAgentMessages = messages.filter(
      (msg) =>
        msg.isAgent && !msg.id.startsWith("thinking-") && !messageAudioUrls.current.has(msg.id),
    );

    newAgentMessages.forEach((msg) => {
      if (msg.content.text) {
        void generateSpeech(msg.content.text, msg.id);
      }
    });
  }, [messages, generateSpeech]); // generateSpeech is now stable

  // Handle streaming messages from the single endpoint

  // Track if user has scrolled up (away from bottom) - don't force scroll if they're reading
  const userScrolledUpRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  // Check if viewport is at or near bottom
  const isNearBottom = useCallback(() => {
    if (!scrollAreaRef.current) return true;
    const viewport = scrollAreaRef.current.querySelector("[data-radix-scroll-area-viewport]");
    if (!viewport) return true;

    // Consider "near bottom" if within 150px of the bottom
    const threshold = 150;
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    return distanceFromBottom < threshold;
  }, []);

  // Robust scroll to bottom function - respects user scroll position
  const scrollToBottom = useCallback((smooth = false) => {
    // Don't auto-scroll if user has scrolled up to read
    if (userScrolledUpRef.current) return;

    if (scrollAreaRef.current) {
      const viewport = scrollAreaRef.current.querySelector("[data-radix-scroll-area-viewport]");
      if (viewport) {
        requestAnimationFrame(() => {
          if (smooth) {
            viewport.scrollTo({
              top: viewport.scrollHeight,
              behavior: "smooth",
            });
          } else {
            viewport.scrollTop = viewport.scrollHeight;
          }
        });
      }
    }
  }, []);

  // Track scroll events to detect user scrolling up
  useEffect(() => {
    if (!scrollAreaRef.current) return;
    const viewport = scrollAreaRef.current.querySelector("[data-radix-scroll-area-viewport]");
    if (!viewport) return;

    const handleScroll = () => {
      const currentScrollTop = viewport.scrollTop;
      const isAtBottom = isNearBottom();

      // User scrolled UP (away from bottom)
      if (currentScrollTop < lastScrollTopRef.current && !isAtBottom) {
        userScrolledUpRef.current = true;
      }
      // User scrolled back to bottom - re-enable auto-scroll
      if (isAtBottom) {
        userScrolledUpRef.current = false;
      }

      lastScrollTopRef.current = currentScrollTop;
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [isNearBottom]);

  // Keep inputTextRef in sync with inputText
  useEffect(() => {
    inputTextRef.current = inputText;
  }, [inputText]);

  // Auto-resize textarea when inputText changes
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 400) + "px";
    }
  }, []);

  // Auto-scroll to bottom when messages change
  // Uses smooth scrolling during streaming for a polished feel
  useEffect(() => {
    // Check if there's an active streaming message
    const isStreaming = messages.some(
      (m) => m.id.startsWith("streaming-") || m.id.startsWith("thinking-"),
    );

    // Use smooth scroll during streaming for fluid appearance
    // Use instant scroll for initial load and completed messages
    scrollToBottom(isStreaming);

    // Delayed scroll for late-loading content (images, markdown rendering)
    const timer = setTimeout(() => scrollToBottom(isStreaming), 100);
    return () => clearTimeout(timer);
  }, [messages, scrollToBottom]); // scrollToBottom is stable

  // Keep sendMessageRef in sync - allows effects defined before sendMessage to call it
  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

  const formatTimestamp = (timestamp: number): string => {
    const diffMs = Date.now() - timestamp;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  const copyToClipboard = async (
    text: string,
    messageId: string,
    attachments?: ChatMediaAttachment[],
  ) => {
    // Check if there are image attachments
    const imageAttachment = attachments?.find((att) => att.contentType === ContentType.IMAGE);

    if (imageAttachment) {
      // Copy the actual image to clipboard
      const response = await fetch(imageAttachment.url);
      const blob = await response.blob();

      // Ensure the blob is an image type
      const imageBlob = blob.type.startsWith("image/")
        ? blob
        : new Blob([blob], { type: "image/png" });

      const clipboardItem = new ClipboardItem({
        [imageBlob.type]: imageBlob,
      });

      await navigator.clipboard.write([clipboardItem]);
      setCopiedMessageId(messageId);
      toast.success("Image copied to clipboard");
      setTimeout(() => setCopiedMessageId(null), 2000);
      return;
    }

    // Fall back to copying text if no image
    await navigator.clipboard.writeText(text);
    setCopiedMessageId(messageId);
    toast.success("Message copied to clipboard");
    // Reset after 2 seconds
    setTimeout(() => setCopiedMessageId(null), 2000);
  };

  // Check if chat is empty (no messages and not loading)
  const isEmptyChat = messages.length === 0 && !loadingState.isLoadingMessages && !error;

  // Check if this is the first conversation with this character
  // Count rooms that belong to the same character (excluding current room)
  // Default to "first conversation" when rooms are loading to avoid flicker
  const isFirstConversation = useMemo(() => {
    if (!selectedCharacterId || isLoadingRooms) return true;
    const characterRooms = rooms.filter(
      (r) => r.characterId === selectedCharacterId && r.id !== roomId,
    );
    return characterRooms.length === 0;
  }, [rooms, selectedCharacterId, roomId, isLoadingRooms]);

  return (
    <div className="flex h-full w-full min-h-0 justify-center py-3 pr-3">
      {/* Main Chat Area - Centered with max width for readability */}
      <div
        className={`flex flex-col items-center flex-1 min-h-0 w-full px-4 sm:px-6 rounded-2xl bg-[#070707] ${isEmptyChat ? "justify-center" : ""}`}
      >
        {/* Pending document processing banner */}
        <PendingDocumentsProcessor characterId={selectedCharacterId} />

        {/* Loading state */}
        {loadingState.isLoadingMessages && (
          <div className="flex flex-col items-center justify-center h-full text-center py-12 space-y-6">
            <ElizaAvatar
              avatarUrl={characterAvatarUrl}
              name={characterName}
              className="h-16 w-16 mb-4"
              fallbackClassName="bg-muted"
              iconClassName="h-8 w-8 text-muted-foreground"
              animate={true}
            />
            <div className="space-y-2">
              <p className="text-base font-semibold">Loading conversation...</p>
            </div>
            {/* Message Skeletons */}
            <div className="w-full max-w-2xl space-y-4 mt-8">
              {/* Agent message skeleton */}
              <div className="flex justify-start animate-pulse">
                <div className="flex flex-col gap-2 max-w-[70%]">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full bg-white/10" />
                    <div className="h-4 w-20 bg-white/10 rounded" />
                  </div>
                  <div className="h-16 bg-white/5 rounded" />
                </div>
              </div>
              {/* User message skeleton */}
              <div className="flex justify-end animate-pulse">
                <div className="flex flex-col gap-2 max-w-[70%]">
                  <div className="h-12 bg-white/10 rounded" />
                </div>
              </div>
              {/* Agent message skeleton */}
              <div className="flex justify-start animate-pulse">
                <div className="flex flex-col gap-2 max-w-[70%]">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full bg-white/10" />
                    <div className="h-4 w-20 bg-white/10 rounded" />
                  </div>
                  <div className="h-20 bg-white/5 rounded" />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Messages Area - Hidden when empty to center input */}
        {!isEmptyChat && !loadingState.isLoadingMessages && (
          <div className="flex-1 min-h-0 w-full overflow-hidden">
            <ScrollArea className="h-full py-6" ref={scrollAreaRef}>
              <div className="max-w-4xl mx-auto px-2 space-y-6">
                {error && (
                  <div className="rounded-lg border border-destructive bg-destructive/10 p-3">
                    <p className="text-sm text-destructive">{error}</p>
                  </div>
                )}

                {messages.map((message) => {
                  const isStreaming = message.id.startsWith("streaming-");
                  // Use stable key that doesn't change when streaming message becomes final
                  // This prevents React from remounting the component (avoids flash)
                  const stableKey = isStreaming ? message.id.replace("streaming-", "") : message.id;
                  return (
                    <MemoizedChatMessage
                      key={stableKey}
                      message={message}
                      characterName={characterName}
                      characterAvatarUrl={characterAvatarUrl}
                      copiedMessageId={copiedMessageId}
                      currentPlayingId={audioState.currentPlayingId}
                      isPlaying={player.isPlaying}
                      hasAudioUrl={messageAudioUrls.current.has(message.id)}
                      isStreaming={isStreaming}
                      formatTimestamp={formatTimestamp}
                      onCopy={copyToClipboard}
                      // Pass reasoning state to thinking AND streaming messages
                      // This shows "Composing" phase while text streams in
                      reasoningText={
                        message.id.startsWith("thinking-") || message.id.startsWith("streaming-")
                          ? reasoningState.text
                          : undefined
                      }
                      reasoningPhase={
                        message.id.startsWith("thinking-") || message.id.startsWith("streaming-")
                          ? reasoningState.phase
                          : undefined
                      }
                      onPlayAudio={(messageId) => {
                        const url = messageAudioUrls.current.get(messageId);
                        if (url) {
                          if (audioState.currentPlayingId === messageId && player.isPlaying) {
                            player.stopAudio();
                            setAudioState((prev) => ({
                              ...prev,
                              currentPlayingId: null,
                            }));
                          } else {
                            setAudioState((prev) => ({
                              ...prev,
                              currentPlayingId: messageId,
                            }));
                            player.playAudio(url);
                          }
                        }
                      }}
                      onImageLoad={scrollToBottom}
                      onTextReveal={() => scrollToBottom(true)}
                    />
                  );
                })}
              </div>
            </ScrollArea>
          </div>
        )}

        {/* Empty chat greeting */}
        {isEmptyChat && (
          <div className="mb-8 text-center px-4">
            <h1
              className={cn(
                "font-medium text-white/90",
                getGreetingTextSizeClass(characterName.length),
              )}
            >
              {isFirstConversation ? `Meet ${characterName}.` : `Say hi to ${characterName}.`}
            </h1>
          </div>
        )}

        {/* Input Area - Buttons inside input like Gemini/ChatGPT */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage();
          }}
          className="py-4 md:py-6 w-full"
        >
          <div className="mx-auto max-w-4xl">
            <div className="relative rounded-2xl border border-white/12 bg-white/4 overflow-hidden shadow-lg shadow-black/20">
              {/* Robot Eye Visor Scanner */}
              {loadingState.isSending && (
                <div className="absolute top-0 left-0 right-0 h-[2px] overflow-hidden pointer-events-none z-10">
                  <div
                    className="absolute h-full w-24 bg-gradient-to-r from-transparent via-[#FF5800] to-transparent"
                    style={{
                      animation: "visor-scan 4.8s cubic-bezier(0.4, 0, 0.6, 1) infinite",
                      boxShadow: "0 0 15px 3px rgba(255, 88, 0, 0.7)",
                      filter: "blur(0.5px)",
                    }}
                  />
                  <div
                    className="absolute h-full w-16 bg-gradient-to-r from-transparent via-[#FF5800]/60 to-transparent"
                    style={{
                      animation:
                        "visor-scan-delayed 6.2s cubic-bezier(0.3, 0.1, 0.7, 0.9) infinite 1.5s",
                      boxShadow: "0 0 10px 2px rgba(255, 88, 0, 0.5)",
                      filter: "blur(1px)",
                    }}
                  />
                </div>
              )}

              {/* Textarea */}
              <textarea
                rows={1}
                value={inputText}
                onChange={(e) => setInputText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (!loadingState.isSending && !recorder.isRecording) {
                      sendMessage();
                    }
                  }
                }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = "52px";
                  target.style.height = Math.min(target.scrollHeight, 200) + "px";
                }}
                placeholder={
                  isMessageLimitReached
                    ? "Sign up to continue chatting..."
                    : recorder.isRecording
                      ? "Recording... Click stop when done"
                      : "Type your message..."
                }
                disabled={recorder.isRecording || isMessageLimitReached}
                className="w-full bg-transparent px-4 pt-3 pb-3 text-[15px] text-white placeholder:text-white/40 focus:outline-none disabled:opacity-50 resize-none leading-relaxed"
                style={{ minHeight: "52px", maxHeight: "200px" }}
              />

              {/* Bottom bar with buttons inside input */}
              <div className="flex items-center justify-between px-2 py-2">
                {/* Left side - Plus menu and Mic */}
                <div className="flex items-center gap-1.5">
                  <input
                    type="file"
                    id="chat-file-upload"
                    multiple
                    accept=".pdf,.txt,.md,.doc,.docx,.json,.xml,.yaml,.yml,.csv"
                    onChange={(e) => {
                      const files = e.target.files;
                      if (files && files.length > 0) {
                        handleFileUpload(Array.from(files));
                        e.target.value = "";
                      }
                    }}
                    className="hidden"
                  />

                  {/* Plus Menu */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 rounded-lg hover:bg-white/[0.06] transition-colors"
                      >
                        <Plus className="h-4 w-4 text-neutral-400" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      className="w-56 rounded-xl border-white/10 bg-neutral-800/60 backdrop-blur-md p-1.5"
                      align="start"
                      side="top"
                      sideOffset={8}
                    >
                      <DropdownMenuItem
                        className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer data-[highlighted]:bg-white/5 focus:bg-white/5"
                        disabled={isUploadingFiles || loadingState.isSending}
                        onSelect={() => {
                          document.getElementById("chat-file-upload")?.click();
                        }}
                      >
                        {isUploadingFiles ? (
                          <Loader2 className="h-4 w-4 text-white/50 animate-spin" />
                        ) : (
                          <FileText className="h-4 w-4 text-white/50" />
                        )}
                        <span className="text-sm">Upload files</span>
                      </DropdownMenuItem>

                      <DropdownMenuItem
                        className="flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer data-[highlighted]:bg-white/5 focus:bg-white/5"
                        onSelect={(e) => {
                          e.preventDefault();
                          setCreateImageEnabled(!createImageEnabled);
                        }}
                      >
                        <div className="flex items-center gap-3">
                          <ImageIcon
                            className={`h-4 w-4 ${createImageEnabled ? "text-[#FF5800]" : "text-white/50"}`}
                          />
                          <span className="text-sm">Create image</span>
                        </div>
                        {createImageEnabled && <Check className="h-4 w-4 text-[#FF5800]" />}
                      </DropdownMenuItem>

                      <DropdownMenuItem
                        className="flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer data-[highlighted]:bg-white/5 focus:bg-white/5"
                        onSelect={(e) => {
                          e.preventDefault();
                          setWebSearchEnabled(!webSearchEnabled);
                        }}
                      >
                        <div className="flex items-center gap-3">
                          <Globe
                            className={`h-4 w-4 ${webSearchEnabled ? "text-[#FF5800]" : "text-white/50"}`}
                          />
                          <span className="text-sm">Web search</span>
                        </div>
                        {webSearchEnabled && <Check className="h-4 w-4 text-[#FF5800]" />}
                      </DropdownMenuItem>

                      <DropdownMenuItem
                        className="flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer data-[highlighted]:bg-white/5 focus:bg-white/5"
                        onSelect={(e) => {
                          e.preventDefault();
                          setAudioState((prev) => ({
                            ...prev,
                            autoPlayTTS: !prev.autoPlayTTS,
                          }));
                        }}
                      >
                        <div className="flex items-center gap-3">
                          <Volume2
                            className={`h-4 w-4 ${audioState.autoPlayTTS ? "text-[#FF5800]" : "text-white/50"}`}
                          />
                          <span className="text-sm">Auto-play voice</span>
                        </div>
                        {audioState.autoPlayTTS && <Check className="h-4 w-4 text-[#FF5800]" />}
                      </DropdownMenuItem>

                      {audioState.customVoices.length > 0 && (
                        <div className="px-3 py-2">
                          <Select
                            value={audioState.selectedVoiceId || "default"}
                            onValueChange={(value) => {
                              const newVoiceId = value === "default" ? null : value;
                              setAudioState((prev) => ({
                                ...prev,
                                selectedVoiceId: newVoiceId,
                              }));
                              if (typeof window !== "undefined") {
                                if (newVoiceId) {
                                  localStorage.setItem("eliza-selected-voice-id", newVoiceId);
                                } else {
                                  localStorage.removeItem("eliza-selected-voice-id");
                                }
                              }
                              const voiceName = newVoiceId
                                ? audioState.customVoices.find(
                                    (v) => v.elevenlabsVoiceId === newVoiceId,
                                  )?.name || "Custom"
                                : "Default";
                              toast.success(`Voice: ${voiceName}`);
                            }}
                          >
                            <SelectTrigger className="w-full h-8 rounded-lg border-white/10 bg-white/5 text-sm">
                              <SelectValue placeholder="Select voice" />
                            </SelectTrigger>
                            <SelectContent className="rounded-lg border-white/10 bg-neutral-800/60 backdrop-blur-md">
                              <SelectItem value="default">Default Voice</SelectItem>
                              {audioState.customVoices.map((voice) => (
                                <SelectItem key={voice.id} value={voice.elevenlabsVoiceId}>
                                  {voice.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {/* Mic Button */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={loadingState.isSending}
                    onClick={handleVoiceInput}
                    className={`h-8 w-8 rounded-lg transition-colors ${
                      recorder.isRecording
                        ? "bg-red-500/10 hover:bg-red-500/20"
                        : "hover:bg-white/[0.06]"
                    } disabled:opacity-40`}
                  >
                    {recorder.isRecording ? (
                      <Square className="h-4 w-4 text-red-400" />
                    ) : (
                      <Mic className="h-4 w-4 text-neutral-400" />
                    )}
                  </Button>

                  {/* Create Image indicator pill */}
                  {createImageEnabled && (
                    <button
                      type="button"
                      onClick={() => setCreateImageEnabled(false)}
                      className="flex items-center gap-1 h-7 px-3 rounded-lg bg-transparent hover:bg-[#FF5800]/10 text-[#FF5800] text-sm transition-colors"
                    >
                      <span>{selectedImageModel.name}</span>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Right side - Model selector and Send */}
                <div className="flex items-center gap-1">
                  {/* Model Selector - Claude style */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={isLoadingModels}
                        className="h-8 gap-1.5 px-2.5 rounded-lg hover:bg-white/[0.06] transition-colors"
                      >
                        <span className="flex items-center gap-1.5 text-sm text-white/50">
                          {!customModel && tierIcons[selectedTier]}
                          {customModel
                            ? customModel.name
                            : tiers.find((t) => t.id === selectedTier)?.name || "Pro"}
                        </span>
                        <svg
                          className="h-3.5 w-3.5 text-white/30"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 9l-7 7-7-7"
                          />
                        </svg>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      className="w-72 rounded-xl border-white/10 bg-neutral-800/60 backdrop-blur-md p-1.5"
                      align="end"
                      side="top"
                      sideOffset={8}
                    >
                      {/* Tab switcher */}
                      <div className="relative inline-flex items-center gap-0.5 p-1 mb-2 rounded-lg bg-white/5 border border-white/10 w-full">
                        {/* Animated indicator */}
                        <div
                          className="absolute top-1 bottom-1 rounded-md bg-white transition-all duration-300 ease-out"
                          style={{
                            left: modelSelectorTab === "text" ? "4px" : "50%",
                            width: "calc(50% - 6px)",
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => setModelSelectorTab("text")}
                          className={cn(
                            "relative z-10 flex-1 flex items-center justify-center gap-1.5 py-1.5 text-sm font-medium rounded-md transition-colors duration-300",
                            modelSelectorTab === "text"
                              ? "text-black"
                              : "text-white/60 hover:text-white hover:bg-white/10",
                          )}
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                          Text
                        </button>
                        <button
                          type="button"
                          onClick={() => setModelSelectorTab("image")}
                          className={cn(
                            "relative z-10 flex-1 flex items-center justify-center gap-1.5 py-1.5 text-sm font-medium rounded-md transition-colors duration-300",
                            modelSelectorTab === "image"
                              ? "text-black"
                              : "text-white/60 hover:text-white hover:bg-white/10",
                          )}
                        >
                          <ImageIcon className="h-3.5 w-3.5" />
                          Image
                        </button>
                      </div>

                      {/* Text models tab */}
                      {modelSelectorTab === "text" && (
                        <>
                          {tiers.map((tier) => (
                            <DropdownMenuItem
                              key={tier.id}
                              className="flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer data-[highlighted]:bg-white/5 focus:bg-white/5"
                              onSelect={() => {
                                setTier(tier.id as "fast" | "pro" | "ultra");
                                setCustomModel(null);
                              }}
                            >
                              <div className="flex items-start gap-3">
                                <span className="mt-0.5 text-white/50">{tierIcons[tier.id]}</span>
                                <div className="flex flex-col gap-0.5">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-[14px] font-medium text-white">
                                      {tier.name}
                                    </span>
                                    {tier.recommended && (
                                      <span className="rounded-full border border-[#FF5800]/30 bg-[#FF5800]/10 px-1.5 py-0.5 text-[9px] uppercase text-[#FF9B66]">
                                        Recommended
                                      </span>
                                    )}
                                    <span className="text-[11px] text-white/30 font-mono">
                                      {tier.modelId.split("/")[1]}
                                    </span>
                                  </div>
                                  <span className="text-[12px] text-white/40">
                                    {tier.description}
                                  </span>
                                </div>
                              </div>
                              {!customModel && selectedTier === tier.id && (
                                <Check className="h-4 w-4 text-[#FF5800]" />
                              )}
                            </DropdownMenuItem>
                          ))}

                          {/* More models submenu */}
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger className="flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer text-[14px] text-white/70 data-[highlighted]:bg-white/5 focus:bg-white/5">
                              More models
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent
                              className="w-64 rounded-xl border-white/10 bg-neutral-800/60 backdrop-blur-md p-0"
                              sideOffset={8}
                            >
                              <ScrollArea className="max-h-80" viewportClassName="max-h-80">
                                <div className="p-1.5">
                                  {isLoadingTextModels && (
                                    <div className="px-3 py-2 text-[12px] text-white/40">
                                      Loading current model catalog...
                                    </div>
                                  )}
                                  {!isLoadingTextModels && availableTextModelsError && (
                                    <div className="px-3 py-2 text-[12px] text-white/40">
                                      {availableTextModelsError}
                                    </div>
                                  )}
                                  {moreTextModels.map((model) => (
                                    <DropdownMenuItem
                                      key={model.id}
                                      className="flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer data-[highlighted]:bg-white/5 focus:bg-white/5"
                                      onSelect={() => {
                                        setCustomModel({
                                          id: model.id,
                                          name: model.name,
                                          modelId: model.modelId,
                                        });
                                      }}
                                    >
                                      <div className="flex flex-col">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <span className="text-[13px] font-medium text-white">
                                            {model.name}
                                          </span>
                                          <span className="rounded-full border border-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-white/40">
                                            {formatSelectorProvider(model.provider)}
                                          </span>
                                          {model.recommended && (
                                            <span className="rounded-full border border-[#FF5800]/30 bg-[#FF5800]/10 px-1.5 py-0.5 text-[9px] uppercase text-[#FF9B66]">
                                              Recommended
                                            </span>
                                          )}
                                          {model.free && (
                                            <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 text-[9px] uppercase text-emerald-200">
                                              Free
                                            </span>
                                          )}
                                          <span className="text-[10px] text-white/30 font-mono">
                                            {model.modelId.split("/")[1]}
                                          </span>
                                        </div>
                                        <span className="text-[11px] text-white/40">
                                          {model.description}
                                        </span>
                                      </div>
                                      {customModel?.id === model.id && (
                                        <Check className="h-4 w-4 text-[#FF5800]" />
                                      )}
                                    </DropdownMenuItem>
                                  ))}
                                </div>
                              </ScrollArea>
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        </>
                      )}

                      {/* Image models tab */}
                      {modelSelectorTab === "image" && (
                        <>
                          {IMAGE_TIERS.map((tier) => {
                            const isAvailable = modelAvailability.get(tier.model.modelId) !== false;
                            const unavailableReason = modelUnavailableReasons.get(
                              tier.model.modelId,
                            );
                            return (
                              <DropdownMenuItem
                                key={tier.id}
                                className={cn(
                                  "flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer data-[highlighted]:bg-white/5 focus:bg-white/5",
                                  !isAvailable && "opacity-60",
                                )}
                                onSelect={() => {
                                  if (!isAvailable) {
                                    toast.error(
                                      `${tier.name} is currently unavailable. ${unavailableReason || "Try another model."}`,
                                    );
                                    return;
                                  }
                                  setSelectedImageModel(tier.model);
                                  setCreateImageEnabled(true);
                                }}
                              >
                                <div className="flex items-start gap-3">
                                  <span className="mt-0.5 text-white/50 relative">
                                    {tier.id === "fast" ? (
                                      <Zap className="h-4 w-4" />
                                    ) : tier.id === "pro" ? (
                                      <Sparkles className="h-4 w-4" />
                                    ) : (
                                      <Crown className="h-4 w-4" />
                                    )}
                                    {!isAvailable && (
                                      <span
                                        className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500"
                                        title={unavailableReason}
                                      />
                                    )}
                                  </span>
                                  <div className="flex flex-col gap-0.5">
                                    <div className="flex items-center gap-2">
                                      <span
                                        className={cn(
                                          "text-[14px] font-medium",
                                          isAvailable ? "text-white" : "text-white/60",
                                        )}
                                      >
                                        {tier.name}
                                      </span>
                                      <span className="text-[11px] text-white/30 font-mono">
                                        {tier.model.modelId.split("/")[1]}
                                      </span>
                                      {!isAvailable && (
                                        <span className="text-[10px] text-red-400 font-medium px-1.5 py-0.5 bg-red-500/10 rounded">
                                          Offline
                                        </span>
                                      )}
                                    </div>
                                    <span className="text-[12px] text-white/40">
                                      {!isAvailable
                                        ? unavailableReason || "Provider unavailable"
                                        : tier.description}
                                    </span>
                                  </div>
                                </div>
                                {createImageEnabled && selectedImageModel.id === tier.model.id && (
                                  <Check className="h-4 w-4 text-[#FF5800]" />
                                )}
                              </DropdownMenuItem>
                            );
                          })}

                          {/* More image models submenu */}
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger className="flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer text-[14px] text-white/70 data-[highlighted]:bg-white/5 focus:bg-white/5">
                              More models
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent
                              className="w-64 rounded-xl border-white/10 bg-neutral-800/60 backdrop-blur-md p-1.5"
                              sideOffset={8}
                            >
                              {ADDITIONAL_IMAGE_MODELS.map((model) => {
                                const isAvailable = modelAvailability.get(model.modelId) !== false;
                                const unavailableReason = modelUnavailableReasons.get(
                                  model.modelId,
                                );
                                return (
                                  <DropdownMenuItem
                                    key={model.id}
                                    className={cn(
                                      "flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer data-[highlighted]:bg-white/5 focus:bg-white/5",
                                      !isAvailable && "opacity-60",
                                    )}
                                    onSelect={() => {
                                      if (!isAvailable) {
                                        toast.error(
                                          `${model.name} is currently unavailable. ${unavailableReason || "Try another model."}`,
                                        );
                                        return;
                                      }
                                      setSelectedImageModel(model);
                                      setCreateImageEnabled(true);
                                    }}
                                  >
                                    <div className="flex flex-col">
                                      <div className="flex items-center gap-2">
                                        {!isAvailable && (
                                          <span
                                            className="h-2 w-2 rounded-full bg-red-500 flex-shrink-0"
                                            title={unavailableReason}
                                          />
                                        )}
                                        <span
                                          className={cn(
                                            "text-[13px] font-medium",
                                            isAvailable ? "text-white" : "text-white/60",
                                          )}
                                        >
                                          {model.name}
                                        </span>
                                        <span className="text-[10px] text-white/30 font-mono">
                                          {model.modelId.split("/")[1]}
                                        </span>
                                        {!isAvailable && (
                                          <span className="text-[10px] text-red-400 font-medium px-1.5 py-0.5 bg-red-500/10 rounded">
                                            Offline
                                          </span>
                                        )}
                                      </div>
                                      <span className="text-[11px] text-white/40">
                                        {!isAvailable
                                          ? unavailableReason || "Provider unavailable"
                                          : model.description}
                                      </span>
                                    </div>
                                    {createImageEnabled && selectedImageModel.id === model.id && (
                                      <Check className="h-4 w-4 text-[#FF5800]" />
                                    )}
                                  </DropdownMenuItem>
                                );
                              })}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {/* Send Button */}
                  <Button
                    type="submit"
                    disabled={
                      loadingState.isSending ||
                      !inputText.trim() ||
                      recorder.isRecording ||
                      isMessageLimitReached
                    }
                    size="icon"
                    className="h-8 w-8 rounded-xl bg-[#FF5800] hover:bg-[#e54e00] disabled:bg-white/10 transition-colors group"
                  >
                    {loadingState.isSending ? (
                      <Loader2 className="h-4 w-4 animate-spin text-white" />
                    ) : (
                      <ArrowUp className="h-4 w-4 text-white group-disabled:text-neutral-400" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
