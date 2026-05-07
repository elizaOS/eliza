/**
 * Build mode assistant component for AI-assisted character building.
 * Provides chat interface for refining character properties with markdown support and quick prompts.
 *
 * Two modes:
 * - Creator mode (isCreatorMode=true): Chat with default Eliza to create a new character
 * - Build mode (isCreatorMode=false): Chat with the actual character to edit it
 *
 * @param props - Build mode assistant configuration
 * @param props.character - Character being edited (required for build mode)
 * @param props.onCharacterUpdate - Callback when character is updated
 * @param props.onCharacterRefresh - Optional callback to refresh character from database
 * @param props.onRoomIdChange - Optional callback when room ID changes (for parent to track)
 * @param props.userId - User ID for conversation management
 * @param props.isCreatorMode - Whether this is blank state creator (chat with Eliza) or editing existing character
 */

"use client";

import { ScrollArea } from "@elizaos/cloud-ui";
import Image from "@elizaos/cloud-ui/runtime/image";
import {
  ArrowUp,
  Check,
  Copy,
  Crown,
  Loader2,
  Lock,
  MessageSquare,
  Sparkles,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { useThrottledStreamingUpdate } from "@/lib/hooks/use-throttled-streaming";
import type { ElizaCharacter } from "@/lib/types";
import "highlight.js/styles/github-dark.css";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@elizaos/cloud-ui";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { AgentMode } from "@/lib/eliza/agent-mode-types";
import {
  BUILD_MODE_TIER_LIST,
  BUILD_MODE_TIERS,
  DEFAULT_MODEL_TIER,
  type ModelTier,
} from "@/lib/models/model-tiers";
import { useChatStore } from "@/lib/stores/chat-store";
import { ElizaAvatar } from "./eliza-avatar";

// Default Eliza configuration for creator mode (build page only)
const DEFAULT_ELIZA = {
  name: "Eliza",
  avatarUrl: "/avatars/eliza-default.png",
} as const;

interface BuildModeAssistantProps {
  character?: ElizaCharacter;
  onCharacterUpdate: (updates: Partial<ElizaCharacter>) => void;
  onCharacterRefresh?: () => Promise<void>;
  onRoomIdChange?: (roomId: string) => void;
  onCharacterCreated?: (characterId: string, characterName: string) => void;
  userId: string;
  isCreatorMode?: boolean;
}

interface MessageAttachment {
  id: string;
  url: string;
  title?: string;
  contentType?: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  attachments?: MessageAttachment[];
}

interface LockedRoomInfo {
  characterId: string;
  characterName: string;
}

export function BuildModeAssistant({
  character,
  onCharacterUpdate,
  onCharacterRefresh,
  onRoomIdChange,
  onCharacterCreated,
  userId,
  isCreatorMode = false,
}: BuildModeAssistantProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const roomInitKeyRef = useRef<string | null>(null); // Track which room key we've initialized
  const messagesLoadedRef = useRef<string | null>(null); // Track which room we've loaded messages for
  // Track rendered message keys to prevent re-animation (avoids flash)
  const renderedMessagesRef = useRef<Set<string>>(new Set());
  // Throttled streaming updates (reduces re-renders from ~100/sec to ~60/sec)
  const {
    accumulateChunk,
    clearAll: clearAllStreaming,
    scheduleUpdate,
  } = useThrottledStreamingUpdate();
  const [inputText, setInputText] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);

  // Get store method to update character avatar in sidebar/dropdown
  const updateCharacterAvatar = useChatStore((state) => state.updateCharacterAvatar);
  const [isLoading, setIsLoading] = useState(false);

  const [selectedTier, setSelectedTier] = useState<ModelTier>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("build-mode-model-tier");
      if (stored && (stored === "fast" || stored === "pro" || stored === "ultra")) {
        return stored as ModelTier;
      }
    }
    return DEFAULT_MODEL_TIER;
  });
  const selectedModelId =
    BUILD_MODE_TIER_LIST.find((t) => t.id === selectedTier)?.modelId ??
    BUILD_MODE_TIERS[DEFAULT_MODEL_TIER].modelId;

  const tierIcons: Record<string, React.ReactNode> = {
    fast: <Zap className="size-5 text-white/40" />,
    pro: <Sparkles className="size-5 text-white/40" />,
    ultra: <Crown className="size-5 text-white/40" />,
  };
  const tierIconsSmall: Record<string, React.ReactNode> = {
    fast: <Zap className="size-3.5 text-white/50" />,
    pro: <Sparkles className="size-3.5 text-white/50" />,
    ultra: <Crown className="size-3.5 text-white/50" />,
  };
  const [isInitializing, setIsInitializing] = useState(true); // Loading state for initial welcome
  const [builderRoomId, setBuilderRoomId] = useState<string>("");
  const [lockedRoom, setLockedRoom] = useState<LockedRoomInfo | null>(null); // Track if room is locked after character creation

  // Detect stale messages during mode/character transitions
  const expectedRoomKey = isCreatorMode ? "creator" : `build-${character?.id}`;
  const messagesAreStale =
    (roomInitKeyRef.current !== null && roomInitKeyRef.current !== expectedRoomKey) ||
    (!isCreatorMode && !character?.id);

  // Cleanup refs on unmount to prevent memory leaks
  useEffect(() => {
    const renderedMessages = renderedMessagesRef.current;
    return () => {
      renderedMessages.clear();
      clearAllStreaming(); // Cancel pending rAF frames and clear text
    };
  }, [clearAllStreaming]);

  // Creator mode: Show Eliza as the builder assistant
  // Edit mode: Show the character being edited (chat with the character)
  const displayName = isCreatorMode ? DEFAULT_ELIZA.name : character?.name || "Agent";
  const displayAvatar = isCreatorMode
    ? DEFAULT_ELIZA.avatarUrl
    : character?.avatarUrl || DEFAULT_ELIZA.avatarUrl;

  // Create builder room using Eliza rooms API
  // - Creator mode: always fresh room for creating new characters, chat with Eliza
  // - Edit mode: reuses same room per character to persist edit history, chat with character
  useEffect(() => {
    if (!userId) return;

    // Create a stable key for this room configuration
    const roomKey = isCreatorMode ? "creator" : `build-${character?.id}`;

    // Skip if we've already initialized this exact room configuration
    if (roomInitKeyRef.current === roomKey) return;
    roomInitKeyRef.current = roomKey;

    // Clear state IMMEDIATELY (synchronously) when switching modes/characters
    // This prevents stale messages from showing while new room initializes
    setMessages([]);
    setLockedRoom(null);
    setBuilderRoomId("");
    setIsInitializing(true);
    messagesLoadedRef.current = null;

    const initializeBuilderRoom = async () => {
      // For edit mode, try to find existing room and reuse it (preserve history)
      if (!isCreatorMode && character?.id) {
        const roomsResponse = await fetch("/api/eliza/rooms?includeBuildRooms=true", {
          credentials: "include",
        });

        if (roomsResponse.ok) {
          const roomsData = await roomsResponse.json();
          const rooms = roomsData.rooms || [];

          // Find existing build room for this character
          const existingRoom = rooms.find(
            (room: { id: string; title?: string; characterId?: string }) =>
              room.title?.startsWith(`[BUILD]`) && room.characterId === character.id,
          );

          if (existingRoom) {
            // Reuse existing room - preserve edit history
            setBuilderRoomId(existingRoom.id);
            onRoomIdChange?.(existingRoom.id);
            return;
          }
        }

        // No existing room found - create new one with welcome message
        const welcomeText =
          "You can update your agent by describing the changes you have in mind here, or edit the agent directly on the right. What needs tweaking?";
        const roomTitle = `[BUILD] ${character?.name || "Character"} (${character?.id})`;

        const createResponse = await fetch("/api/eliza/rooms", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            characterId: character?.id,
            name: roomTitle,
          }),
        });

        if (!createResponse.ok) {
          toast.error("Failed to create builder room");
          setIsInitializing(false);
          return;
        }

        const createData = await createResponse.json();
        const roomId = createData.roomId;

        // Store welcome message for new edit room
        const welcomeResponse = await fetch(`/api/eliza/rooms/${roomId}/welcome`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: welcomeText }),
        });

        if (!welcomeResponse.ok) {
          toast.error("Failed to initialize builder room");
          setIsInitializing(false);
          return;
        }

        setBuilderRoomId(roomId);
        onRoomIdChange?.(roomId);
        return;
      }

      // Creator mode: always create fresh room with Eliza
      const welcomeText =
        "Hi, I'm Eliza. There are two different ways to build your agent:\n1. You can describe what you're imagining - personality, purpose, whatever - and I'll create the agent by building its personality and assigning its capabilities as we go.\n2. You can also build the agent manually on the right.\n\nSo, what are we making?";
      const roomTitle = `[CREATOR] New Character Builder ${Date.now()}`;

      const createResponse = await fetch("/api/eliza/rooms", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          characterId: character?.id,
          name: roomTitle,
        }),
      });

      if (!createResponse.ok) {
        toast.error("Failed to create builder room");
        setIsInitializing(false);
        return;
      }

      const createData = await createResponse.json();
      const roomId = createData.roomId;

      // Store welcome message
      const welcomeResponse = await fetch(`/api/eliza/rooms/${roomId}/welcome`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: welcomeText }),
      });

      if (!welcomeResponse.ok) {
        toast.error("Failed to initialize builder room");
        setIsInitializing(false);
        return;
      }

      setBuilderRoomId(roomId);
      onRoomIdChange?.(roomId);
    };

    initializeBuilderRoom();
  }, [isCreatorMode, character?.id, character?.name, userId, onRoomIdChange]);

  // Load persisted messages when room is initialized
  useEffect(() => {
    if (!builderRoomId) return;

    // Prevent duplicate loads for the same room
    if (messagesLoadedRef.current === builderRoomId) return;
    messagesLoadedRef.current = builderRoomId;

    const loadMessages = async () => {
      setIsInitializing(true);

      const response = await fetch(`/api/eliza/rooms/${builderRoomId}`, {
        credentials: "include",
      });

      if (response.ok) {
        const data = await response.json();
        const loadedMessages = data.messages || [];
        const metadata = data.metadata as
          | {
              locked?: boolean;
              createdCharacterId?: string;
              createdCharacterName?: string;
            }
          | undefined;

        // Check if room is locked (character was created)
        if (metadata?.locked && metadata.createdCharacterId) {
          setLockedRoom({
            characterId: metadata.createdCharacterId,
            characterName: metadata.createdCharacterName || "your agent",
          });
        }

        // Convert Eliza messages to our Message format
        const convertedMessages: Message[] = loadedMessages
          .map(
            (msg: {
              id: string;
              content: {
                text?: string;
                source?: string;
                metadata?: { type?: string };
                attachments?: Array<{
                  id?: string;
                  url: string;
                  title?: string;
                  contentType?: string;
                }>;
              };
              createdAt: number;
              isAgent: boolean;
            }) => {
              const text = msg.content?.text;
              const attachments = msg.content?.attachments;

              // Allow messages with text OR attachments
              if (
                (!text || typeof text !== "string") &&
                (!attachments || attachments.length === 0)
              ) {
                return null;
              }

              // Skip action result messages
              if (msg.content?.metadata?.type === "action_result") return null;

              const source = msg.content?.source;
              const isAgentMessage =
                source === "agent" || source === "action" || (source === undefined && msg.isAgent);

              return {
                id: msg.id,
                role: isAgentMessage ? ("assistant" as const) : ("user" as const),
                content: text || "",
                timestamp: msg.createdAt,
                attachments: attachments?.map((att) => ({
                  id: att.id || `att-${msg.id}`,
                  url: att.url,
                  title: att.title,
                  contentType: att.contentType,
                })),
              };
            },
          )
          .filter((msg: Message | null): msg is Message => msg !== null);

        setMessages(convertedMessages);
      }

      setIsInitializing(false);
    };

    loadMessages();
  }, [builderRoomId]);

  // Persist model tier to localStorage
  useEffect(() => {
    localStorage.setItem("build-mode-model-tier", selectedTier);
  }, [selectedTier]);

  // Send message to elizaOS stream endpoint with BUILD workflow
  const sendElizaMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || !builderRoomId) return;

      setIsLoading(true);

      // Add user message to UI immediately
      const userMessage: Message = {
        id: `user-${Date.now()}`,
        role: "user",
        content: text,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMessage]);

      // Build metadata based on mode
      // Include current client-side character state so the agent knows what user sees
      const clientCharacterState = character
        ? {
            name: character.name || "",
            bio: character.bio || "",
            system: character.system || "",
            adjectives: character.adjectives || [],
            topics: character.topics || [],
            style: character.style || { all: [], chat: [], post: [] },
            messageExamples: character.messageExamples || [],
            avatarUrl: character.avatarUrl || "",
          }
        : null;

      const metadata: Record<string, unknown> = isCreatorMode
        ? {
            isCreatorMode: true,
            clientCharacterState,
            isUnsaved: true, // Creator mode is always unsaved
          }
        : {
            targetCharacterId: character?.id,
            clientCharacterState,
            isUnsaved: !character?.id, // Unsaved if no ID yet
          };

      try {
        const response = await fetch(`/api/eliza/rooms/${builderRoomId}/messages/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            text,
            model: selectedModelId,
            agentMode: {
              mode: AgentMode.BUILD,
              metadata,
            },
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let assistantMessage = "";
        let assistantMessageId = "";

        if (reader) {
          let buffer = "";
          let detectedApplyAction = false;
          let detectedCharacterCreated = false;
          let createdCharacterId: string | null = null;
          let proposedCharacterUpdate: Partial<ElizaCharacter> | null = null;
          let messageAttachments: MessageAttachment[] = [];

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            const events = buffer.split("\n\n");
            buffer = events.pop() || "";

            for (const eventBlock of events) {
              if (!eventBlock.trim()) continue;

              const lines = eventBlock.split("\n");
              let eventType = "";
              let eventData = "";

              for (const line of lines) {
                if (line.startsWith("event: ")) {
                  eventType = line.slice(7).trim();
                } else if (line.startsWith("data: ")) {
                  eventData = line.slice(6);
                }
              }

              // Handle streaming chunks for real-time display
              if (eventType === "chunk" && eventData) {
                try {
                  const chunkData = JSON.parse(eventData);
                  if (chunkData.chunk && chunkData.messageId) {
                    // Accumulate chunk text
                    accumulateChunk(chunkData.messageId, chunkData.chunk);

                    // Update streaming message in UI using throttled update
                    const streamingId = `streaming-${chunkData.messageId}`;
                    scheduleUpdate(chunkData.messageId, (accumulatedText) => {
                      setMessages((prev) => {
                        const existingIndex = prev.findIndex((m) => m.id === streamingId);
                        const streamingMsg: Message = {
                          id: streamingId,
                          role: "assistant",
                          content: accumulatedText,
                          timestamp: Date.now(),
                        };

                        if (existingIndex >= 0) {
                          const updated = [...prev];
                          updated[existingIndex] = streamingMsg;
                          return updated;
                        }
                        return [...prev, streamingMsg];
                      });
                    });

                    assistantMessageId = chunkData.messageId;
                  }
                } catch {
                  // Ignore chunk parse errors
                }
                continue;
              }

              if (eventData) {
                try {
                  const data = JSON.parse(eventData);

                  if (
                    data.type === "agent" &&
                    (data.content?.text || data.content?.attachments?.length)
                  ) {
                    // Skip action result messages from UI but process metadata
                    if (data.content?.metadata?.type === "action_result") {
                      // Check for character creation in action results
                      if (data.content?.metadata?.characterId) {
                        detectedCharacterCreated = true;
                        createdCharacterId = data.content.metadata.characterId;
                      }
                      // Check for SAVE_CHANGES action
                      if (data.content?.actions && Array.isArray(data.content.actions)) {
                        if (data.content.actions.includes("SAVE_CHANGES")) {
                          detectedApplyAction = true;
                        }
                      }
                      continue;
                    }

                    assistantMessage = data.content.text || "";
                    assistantMessageId = data.id;

                    // Capture attachments (images, etc.)
                    if (data.content?.attachments?.length) {
                      messageAttachments = data.content.attachments.map(
                        (att: {
                          id?: string;
                          url: string;
                          title?: string;
                          contentType?: string;
                        }) => ({
                          id: att.id || `att-${Date.now()}`,
                          url: att.url,
                          title: att.title,
                          contentType: att.contentType,
                        }),
                      );
                    }

                    // Check for SAVE_CHANGES action
                    if (data.content?.actions && Array.isArray(data.content.actions)) {
                      if (data.content.actions.includes("SAVE_CHANGES")) {
                        detectedApplyAction = true;
                      }
                    }

                    // Check for CREATE_CHARACTER metadata
                    if (
                      data.content?.metadata?.action === "CREATE_CHARACTER" &&
                      data.content?.metadata?.characterCreated
                    ) {
                      detectedCharacterCreated = true;
                      createdCharacterId = data.content.metadata.characterId || null;
                    }

                    // Check for SUGGEST_CHANGES with partial field updates
                    if (
                      data.content?.metadata?.action === "SUGGEST_CHANGES" &&
                      data.content?.metadata?.changes
                    ) {
                      proposedCharacterUpdate = data.content.metadata.changes;
                    }

                    // Check for GENERATE_AVATAR with avatar URL
                    if (
                      data.content?.metadata?.action === "GENERATE_AVATAR" &&
                      data.content?.metadata?.changes?.avatarUrl
                    ) {
                      proposedCharacterUpdate = data.content.metadata.changes;
                      // Track if avatar was auto-saved
                      if (data.content?.metadata?.avatarSaved) {
                        (proposedCharacterUpdate as Record<string, unknown>).__avatarSaved = true;
                      }
                    }
                  }
                } catch {
                  // Silently ignore parse errors during streaming
                }
              }

              // Handle done event - replace streaming message with final message
              if (eventType === "done") {
                if (assistantMessage || messageAttachments.length > 0) {
                  const finalId = assistantMessageId || `assistant-${Date.now()}`;
                  const streamingId = `streaming-${assistantMessageId}`;

                  // Replace streaming message with final message
                  setMessages((prev) => {
                    const existingIndex = prev.findIndex((m) => m.id === streamingId);
                    const finalMessage: Message = {
                      id: finalId,
                      role: "assistant",
                      content: assistantMessage,
                      timestamp: Date.now(),
                      attachments: messageAttachments.length > 0 ? messageAttachments : undefined,
                    };

                    if (existingIndex >= 0) {
                      // Replace streaming message with final
                      const updated = [...prev];
                      updated[existingIndex] = finalMessage;
                      return updated;
                    }
                    // No streaming message found, just add final
                    return [...prev, finalMessage];
                  });

                  // Apply character updates to editor
                  if (proposedCharacterUpdate) {
                    // Check for avatar saved flag and remove it before updating
                    const updateWithMeta = proposedCharacterUpdate as Record<string, unknown>;
                    const avatarWasSaved = updateWithMeta.__avatarSaved;
                    delete updateWithMeta.__avatarSaved;

                    onCharacterUpdate(proposedCharacterUpdate);
                    const isAvatarUpdate = "avatarUrl" in proposedCharacterUpdate;

                    if (isAvatarUpdate) {
                      // Update sidebar/dropdown avatar if saved in build mode (not creator mode)
                      if (avatarWasSaved && !isCreatorMode && character?.id) {
                        updateCharacterAvatar(character.id, updateWithMeta.avatarUrl as string);
                      }

                      toast.success(
                        avatarWasSaved ? "Avatar generated and saved!" : "Avatar preview updated!",
                        { duration: 4000 },
                      );
                    } else {
                      toast.success("Character preview updated!", {
                        description: isCreatorMode ? undefined : "Save to persist changes",
                        duration: 4000,
                      });
                    }
                  }

                  // Handle character creation in creator mode - lock the room
                  if (isCreatorMode && detectedCharacterCreated && createdCharacterId) {
                    const createdName =
                      (proposedCharacterUpdate?.name as string) || character?.name || "your agent";

                    // Lock the room and show link to chat with the created agent
                    setLockedRoom({
                      characterId: createdCharacterId,
                      characterName: createdName,
                    });

                    // Notify parent that character was created (clears unsaved changes)
                    onCharacterCreated?.(createdCharacterId, createdName);

                    toast.success("Character created! You can now chat with your agent.", {
                      duration: 4000,
                    });
                  }

                  // Refresh character data after apply action (SAVE_CHANGES)
                  if (detectedApplyAction && onCharacterRefresh) {
                    toast.success("Character saved!", { duration: 3000 });
                    await onCharacterRefresh();
                  }
                }
              }
              // Clear streaming state
              clearAllStreaming();
            }
          }
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to send message. Please try again.",
        );
      } finally {
        setIsLoading(false);
      }
    },
    [
      accumulateChunk,
      builderRoomId,
      character,
      clearAllStreaming,
      isCreatorMode,
      onCharacterCreated,
      onCharacterRefresh,
      onCharacterUpdate,
      scheduleUpdate,
      selectedModelId,
      updateCharacterAvatar,
    ],
  );

  // Robust scroll to bottom function
  const scrollToBottom = useCallback((smooth = false) => {
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

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  // Additional scroll after a delay to handle late-loading content
  useEffect(() => {
    const timer = setTimeout(() => {
      scrollToBottom();
    }, 100);
    return () => clearTimeout(timer);
  }, [scrollToBottom]);

  // Extract and apply character updates in real-time
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];

    if (lastMessage && lastMessage.role === "assistant" && lastMessage.id !== "welcome") {
      const content = lastMessage.content;

      const jsonMatch = content.match(/```json\n([\s\S]*?)(\n```|$)/);
      if (jsonMatch) {
        const jsonText = jsonMatch[1].trim();

        try {
          const updates = JSON.parse(jsonText);
          onCharacterUpdate(updates);
        } catch {
          try {
            const fieldMatches = jsonText.matchAll(
              /"(\w+)":\s*("(?:[^"\\]|\\.)*"|true|false|null|\d+(?:\.\d+)?|\[[^\]]*\])/g,
            );
            const partialUpdates: Record<string, unknown> = {};

            for (const match of fieldMatches) {
              const [, key, value] = match;
              try {
                const parsedValue = JSON.parse(value);
                if (parsedValue !== null && parsedValue !== undefined) {
                  partialUpdates[key] = parsedValue;
                }
              } catch {
                // Skip invalid values
              }
            }

            if (Object.keys(partialUpdates).length > 0) {
              onCharacterUpdate(partialUpdates);
            }
          } catch {
            // Silently ignore parsing errors during streaming
          }
        }
      }
    }
    // Note: If onCharacterUpdate causes too many re-runs, wrap it in useCallback in the parent
  }, [messages, onCharacterUpdate]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!inputText.trim() || isLoading) return;

      const userMessage = inputText;
      setInputText("");
      await sendElizaMessage(userMessage);
    },
    [inputText, isLoading, sendElizaMessage],
  );

  const formatTimestamp = (timestamp: number): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return date.toLocaleDateString();
  };

  const copyToClipboard = async (text: string, messageId: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedMessageId(messageId);
    toast.success("Message copied to clipboard");
    setTimeout(() => setCopiedMessageId(null), 2000);
  };

  return (
    <div className="flex h-full w-full min-h-0 flex-col rounded-2xl bg-[#0A0A0A]">
      {/* Messages Area */}
      <div className="flex-1 min-h-0 overflow-hidden pt-4 md:pt-6 pr-1 md:pr-2">
        <ScrollArea className="h-full" ref={scrollAreaRef}>
          <div className="space-y-6 pl-4 md:pl-6 pr-3 md:pr-4">
            {/* Only render messages if they're not stale (from a different mode/character) */}
            {!messagesAreStale &&
              messages.map((message, index) => {
                const content = message.content;
                const isAgent = message.role === "assistant";
                const isStreaming = message.id.startsWith("streaming-");
                // Use stable key that doesn't change when streaming message becomes final
                const stableKey = isStreaming ? message.id.replace("streaming-", "") : message.id;
                // Only animate messages that haven't been rendered before
                const wasAlreadyRendered = renderedMessagesRef.current.has(stableKey);
                const shouldAnimate = !wasAlreadyRendered && !isStreaming;
                renderedMessagesRef.current.add(stableKey);

                return (
                  <div
                    key={stableKey}
                    className={`flex ${isAgent ? "justify-start" : "justify-end"}${shouldAnimate ? " animate-in fade-in slide-in-from-bottom-4 duration-500" : ""}`}
                    style={shouldAnimate ? { animationDelay: `${index * 50}ms` } : undefined}
                  >
                    {isAgent ? (
                      <div className="flex flex-col gap-1.5 max-w-[85%] md:max-w-[75%] group/message">
                        {/* Agent Name Row with Avatar */}
                        <div className="flex items-end gap-2.5">
                          <ElizaAvatar
                            avatarUrl={displayAvatar}
                            name={displayName}
                            className="flex-shrink-0 w-7 h-7"
                            iconClassName="h-4 w-4"
                            fallbackClassName="bg-[#FF5800]"
                          />
                          <span className="text-sm font-medium text-white/60">{displayName}</span>
                        </div>

                        <div className="flex flex-col gap-1.5">
                          {/* Message Attachments (Images) */}
                          {message.attachments && message.attachments.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                              {message.attachments.map((attachment) => (
                                <div
                                  key={attachment.id}
                                  className="relative rounded-lg overflow-hidden border border-white/[0.08] bg-white/[0.02]"
                                >
                                  <Image
                                    src={attachment.url}
                                    alt={attachment.title || "Generated image"}
                                    width={280}
                                    height={280}
                                    className="max-w-[280px] max-h-[280px] object-cover"
                                    unoptimized
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                          {/* Message Text */}
                          {content && (
                            <div className="overflow-hidden">
                              <style>{`
                                .build-mode-content pre {
                                  background: rgba(0, 0, 0, 0.4) !important;
                                  padding: 12px !important;
                                  border-radius: 8px !important;
                                  overflow-x: auto !important;
                                  margin: 8px 0 !important;
                                }
                                .build-mode-content
                                  pre::-webkit-scrollbar {
                                  height: 8px;
                                }
                                .build-mode-content
                                  pre::-webkit-scrollbar-track {
                                  background: rgba(0, 0, 0, 0.2);
                                }
                                .build-mode-content
                                  pre::-webkit-scrollbar-thumb {
                                  background: rgba(255, 88, 0, 0.4);
                                  border-radius: 4px;
                                }
                                .build-mode-content
                                  pre::-webkit-scrollbar-thumb:hover {
                                  background: rgba(255, 88, 0, 0.6);
                                }
                                .build-mode-content pre code {
                                  font-family:
                                    "Monaco", "Menlo", "Ubuntu Mono",
                                    "Consolas", monospace !important;
                                  font-size: 13px !important;
                                  white-space: pre-wrap !important;
                                  word-break: break-word !important;
                                }
                                .build-mode-content code {
                                  font-family:
                                    "Monaco", "Menlo", "Ubuntu Mono",
                                    "Consolas", monospace !important;
                                  font-size: 13px !important;
                                }
                                /* JSON property keys */
                                .build-mode-content .token.property,
                                .build-mode-content .token.key {
                                  color: #fe9f6d !important;
                                }
                                /* JSON punctuation (brackets, braces, commas, colons) */
                                .build-mode-content
                                  .token.punctuation {
                                  color: #e434bb !important;
                                }
                                /* JSON string values */
                                .build-mode-content .token.string {
                                  color: #d4d4d4 !important;
                                }
                                /* JSON numbers */
                                .build-mode-content .token.number {
                                  color: #d4d4d4 !important;
                                }
                                /* JSON booleans and null */
                                .build-mode-content .token.boolean,
                                .build-mode-content .token.null {
                                  color: #d4d4d4 !important;
                                }
                                /* Remove prose margins for tighter spacing */
                                .build-mode-content p {
                                  margin: 0 !important;
                                  word-break: break-word !important;
                                }
                                .build-mode-content p + p {
                                  margin-top: 8px !important;
                                }
                                .build-mode-content ul,
                                .build-mode-content ol {
                                  margin: 8px 0 !important;
                                  padding-left: 24px !important;
                                  list-style-position: outside !important;
                                }
                                .build-mode-content li {
                                  margin: 6px 0 !important;
                                  padding-left: 4px !important;
                                }
                                .build-mode-content li > p {
                                  display: inline !important;
                                  margin: 0 !important;
                                }
                                .build-mode-content
                                  li > p:first-child {
                                  display: inline !important;
                                }
                                .build-mode-content h1,
                                .build-mode-content h2,
                                .build-mode-content h3,
                                .build-mode-content h4 {
                                  margin: 12px 0 4px 0 !important;
                                  font-weight: 600 !important;
                                }
                                .build-mode-content h1 {
                                  font-size: 18px !important;
                                }
                                .build-mode-content h2 {
                                  font-size: 16px !important;
                                }
                                .build-mode-content h3,
                                .build-mode-content h4 {
                                  font-size: 14px !important;
                                }
                                /* Streaming text animation for smoother chunk appearance */
                                @keyframes streamFadeIn {
                                  from {
                                    opacity: 0.7;
                                  }
                                  to {
                                    opacity: 1;
                                  }
                                }
                                .streaming-text {
                                  animation: streamFadeIn 150ms ease-out
                                    forwards;
                                }
                                .streaming-text p:last-child,
                                .streaming-text > *:last-child {
                                  animation: streamFadeIn 120ms ease-out
                                    forwards;
                                }
                              `}</style>
                              <div
                                className={`text-[15px] leading-relaxed text-white/90 build-mode-content break-words${isStreaming ? " streaming-text" : ""}`}
                              >
                                <ReactMarkdown
                                  remarkPlugins={[remarkGfm]}
                                  rehypePlugins={[rehypeHighlight]}
                                  components={{
                                    code: ({ className, children, ...props }) => {
                                      const isInline = !className;
                                      return isInline ? (
                                        <code
                                          className="bg-white/10 px-1.5 py-0.5 rounded text-xs break-all"
                                          {...props}
                                        >
                                          {children}
                                        </code>
                                      ) : (
                                        <code className={className} {...props}>
                                          {children}
                                        </code>
                                      );
                                    },
                                    pre: ({ children }) => (
                                      <pre className="bg-black/40 border border-white/10 rounded-lg p-3 overflow-x-auto my-2">
                                        {children}
                                      </pre>
                                    ),
                                    a: ({ href, children }) => (
                                      <a
                                        href={href}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-[#FF5800] hover:text-[#FF5800]/80 underline break-all"
                                      >
                                        {children}
                                      </a>
                                    ),
                                    ul: ({ children }) => (
                                      <ul className="list-disc my-2 pl-6">{children}</ul>
                                    ),
                                    ol: ({ children }) => (
                                      <ol className="list-decimal my-2 pl-6">{children}</ol>
                                    ),
                                    li: ({
                                      children,
                                      ...props
                                    }: React.HTMLProps<HTMLLIElement>) => (
                                      <li className="my-1.5 pl-1" {...props}>
                                        {children}
                                      </li>
                                    ),
                                    p: ({ children }) => (
                                      <p className="my-2 first:mt-0 last:mb-0">{children}</p>
                                    ),
                                  }}
                                >
                                  {content}
                                </ReactMarkdown>
                                {/* Blinking cursor for streaming messages */}
                                {isStreaming && (
                                  <span className="inline-block w-2 h-4 bg-[#FF5800]/70 ml-0.5 animate-pulse" />
                                )}
                              </div>
                            </div>
                          )}
                          {/* Time and Actions - hide during streaming */}
                          {!isStreaming && (
                            <div className="flex items-center gap-2 pl-1 opacity-0 group-hover/message:opacity-100 transition-opacity">
                              <span className="text-xs text-white/40">
                                {formatTimestamp(message.timestamp)}
                              </span>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 w-6 p-0 hover:bg-white/10 rounded transition-colors"
                                onClick={() => copyToClipboard(content, message.id)}
                                title="Copy message"
                              >
                                {copiedMessageId === message.id ? (
                                  <Check className="h-3.5 w-3.5 text-green-500" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5 text-white/50 hover:text-white/80" />
                                )}
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1.5 max-w-[85%] md:max-w-[75%] group/message items-end">
                        {/* User Message */}
                        <div className="py-3 px-4 bg-[#FF5800]/10 border border-[#FF5800]/20 rounded-lg transition-colors hover:bg-[#FF5800]/15 hover:border-[#FF5800]/30 ml-auto">
                          <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-white/95">
                            {content}
                          </div>
                        </div>
                        {/* Time and Actions */}
                        <div className="flex items-center gap-2 justify-end pr-1 opacity-0 group-hover/message:opacity-100 transition-opacity">
                          <span className="text-xs text-white/40">
                            {formatTimestamp(message.timestamp)}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 hover:bg-white/10 rounded transition-colors"
                            onClick={() => copyToClipboard(content, message.id)}
                            title="Copy message"
                          >
                            {copiedMessageId === message.id ? (
                              <Check className="h-3.5 w-3.5 text-green-500" />
                            ) : (
                              <Copy className="h-3.5 w-3.5 text-white/50 hover:text-white/80" />
                            )}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

            {/* Show thinking indicator when loading, initializing, or transitioning between modes */}
            {(isLoading || messagesAreStale || (isInitializing && messages.length === 0)) &&
              !messages.some((m) => m.id.startsWith("streaming-")) && (
                <div className="flex justify-start animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="flex flex-col gap-1.5 max-w-[85%] md:max-w-[75%]">
                    <div className="flex items-center gap-2 pl-1">
                      <ElizaAvatar
                        avatarUrl={displayAvatar}
                        name={displayName}
                        className="flex-shrink-0 w-5 h-5"
                        iconClassName="h-3 w-3"
                        fallbackClassName="bg-[#FF5800]"
                        animate={true}
                      />
                      <span className="text-xs font-medium text-white/50">{displayName}</span>
                    </div>
                    <div className="flex items-center gap-2 py-3 px-4 bg-white/[0.03] border border-white/[0.06] rounded-lg">
                      <Loader2 className="h-4 w-4 animate-spin text-white/40" />
                      <span className="text-sm text-white/40">thinking...</span>
                    </div>
                  </div>
                </div>
              )}

            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>
      </div>

      {/* Locked Room Banner - Shows when character was created */}
      {lockedRoom && (
        <div className="border-t border-white/[0.06] py-4">
          <div className="pl-[56px] md:pl-[64px] pr-4 md:pr-6">
            <div className="flex flex-col md:flex-row items-center justify-between gap-4 p-4 bg-white/[0.02] border border-white/[0.08] rounded-lg">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 border border-green-500/20">
                  <Lock className="w-5 h-5 text-green-500" />
                </div>
                <div>
                  <p className="text-sm font-medium text-white">Build session complete</p>
                  <p className="text-xs text-white/50">
                    {lockedRoom.characterName} has been created successfully
                  </p>
                </div>
              </div>
              <Link
                to={`/dashboard/chat?characterId=${lockedRoom.characterId}`}
                className="flex items-center gap-2 px-4 py-2 bg-[#FF5800] hover:bg-[#FF5800]/90 text-white text-sm font-medium rounded-lg transition-colors"
              >
                <MessageSquare className="w-4 h-4" />
                Chat with {lockedRoom.characterName}
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Input Area - Hidden when room is locked */}
      {!lockedRoom && (
        <form onSubmit={handleSubmit} className="py-4 md:py-6">
          <div className="mx-auto px-4 md:px-6">
            <div className="relative rounded-2xl border border-white/12 bg-white/4 overflow-hidden shadow-lg shadow-black/20">
              {/* Robot Eye Visor Scanner - Only show when loading */}
              {isLoading && (
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
                    if (!isLoading) {
                      handleSubmit(e);
                    }
                  }
                }}
                onInput={(e) => {
                  const target = e.currentTarget;
                  target.style.height = "52px";
                  target.style.height = Math.min(target.scrollHeight, 200) + "px";
                }}
                placeholder="Describe your agent or ask for help..."
                className="w-full bg-transparent px-4 pt-3 pb-3 text-[15px] text-white placeholder:text-white/40 focus:outline-none resize-none leading-relaxed"
                style={{ minHeight: "52px", maxHeight: "200px" }}
              />

              {/* Bottom bar with buttons inside input */}
              <div className="flex items-center justify-end px-2 py-2">
                {/* Model Selector */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-8 gap-1.5 px-2.5 rounded-lg hover:bg-white/[0.06] transition-colors"
                    >
                      <span className="flex items-center gap-1.5 text-sm text-white/50">
                        {tierIconsSmall[selectedTier]}
                        {BUILD_MODE_TIER_LIST.find((t) => t.id === selectedTier)?.name || "Pro"}
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
                    className="w-72 rounded-xl border-white/10 bg-neutral-600/10 backdrop-blur-md p-1.5"
                    align="end"
                    side="top"
                    sideOffset={8}
                  >
                    {BUILD_MODE_TIER_LIST.map((tier) => (
                      <DropdownMenuItem
                        key={tier.id}
                        className="flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer data-[highlighted]:bg-white/5 focus:bg-white/5"
                        onSelect={() => {
                          setSelectedTier(tier.id as "fast" | "pro" | "ultra");
                        }}
                      >
                        <div className="flex items-center gap-3">
                          <span>{tierIcons[tier.id]}</span>
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-2">
                              <span className="text-[14px] font-medium text-white">
                                {tier.name}
                              </span>
                              <span className="text-[11px] text-white/50 font-mono">
                                {tier.modelId.split("/")[1]}
                              </span>
                            </div>
                            <span className="text-[12px] text-white/60">{tier.description}</span>
                          </div>
                        </div>
                        {selectedTier === tier.id && <Check className="h-4 w-4 text-[#FF5800]" />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Send Button */}
                <Button
                  type="submit"
                  disabled={isLoading || !inputText.trim()}
                  size="icon"
                  className="h-8 w-8 rounded-xl bg-[#FF5800] hover:bg-[#e54e00] disabled:bg-white/10 transition-colors group ml-1"
                >
                  {isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin text-white" />
                  ) : (
                    <ArrowUp className="h-4 w-4 text-white group-disabled:text-neutral-400" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
