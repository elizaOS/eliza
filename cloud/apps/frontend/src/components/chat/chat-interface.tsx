"use client";

import { Alert, AlertDescription, Badge, Button, Card } from "@elizaos/cloud-ui";
import { InfoIcon, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { AffiliateTheme } from "@/lib/config/affiliate-themes";
import { getThemeCSSVariables } from "@/lib/config/affiliate-themes";
import { useChatStore } from "@/lib/stores/chat-store";
import type { UserCharacterDto } from "@/types/cloud-api";
import { ElizaChatInterface } from "./eliza-chat-interface";

/**
 * Chat interface component with dynamic theming and message limit enforcement.
 * Wraps ElizaChatInterface with session management, signup prompts, and affiliate theming.
 *
 * @param props - Chat interface configuration
 * @param props.character - Character data for the chat session
 * @param props.session - Optional session data including message limits
 * @param props.user - Optional user data
 * @param props.showSignupPrompt - Whether to display signup prompt banner
 * @param props.source - Source identifier for analytics
 * @param props.sessionTokenFromUrl - Optional session token from URL parameters
 * @param props.theme - Affiliate theme configuration for styling
 */

interface ChatInterfaceProps {
  character: UserCharacterDto;
  session?: {
    id: string;
    token: string;
    userId: string;
    messageCount: number;
    messagesLimit: number;
    messagesRemaining: number;
  };
  user?: {
    id: string;
    name?: string;
    email?: string;
  };
  showSignupPrompt?: boolean;
  source?: string;
  sessionTokenFromUrl?: string;
  theme: AffiliateTheme;
}

export function ChatInterface({
  character,
  session,
  user,
  showSignupPrompt = false,
  source,
  sessionTokenFromUrl,
  theme,
}: ChatInterfaceProps) {
  const navigate = useNavigate();
  const [messageCount, setMessageCount] = useState(session?.messageCount || 0);
  const [_isLoadingSessionData, setIsLoadingSessionData] = useState(false);
  const { setSelectedCharacterId, setAnonymousSessionToken, loadRooms, setRoomId, roomId } =
    useChatStore();
  const isAnonymous = !user && !!session;

  // Use refs for initialization tracking to avoid re-renders and infinite loops
  const roomInitializedRef = useRef(false);
  const roomInitializingRef = useRef(false);
  const lastCharacterIdRef = useRef<string | null>(null);

  // CRITICAL: Fetch the LATEST session data from server on mount and when token changes
  // This ensures the message count is accurate after page reload, not stale from SSR props
  useEffect(() => {
    if (!sessionTokenFromUrl || user) {
      // No anonymous session or user is authenticated - skip
      return;
    }

    const fetchLatestSessionData = async () => {
      setIsLoadingSessionData(true);
      try {
        const response = await fetch(`/api/anonymous-session?token=${sessionTokenFromUrl}`);

        if (response.ok) {
          const data = await response.json();
          if (data.success && data.session) {
            const serverCount = data.session.message_count;

            // Use functional update to compare against current state value
            // This avoids stale closure issues with messageCount
            setMessageCount((currentCount) => {
              // Only update if server has a higher count
              // This ensures we don't overwrite local increments that haven't synced yet
              if (serverCount > currentCount) {
                return serverCount;
              }
              return currentCount;
            });
          }
        }
      } finally {
        setIsLoadingSessionData(false);
      }
    };

    // Fetch immediately on mount
    fetchLatestSessionData();
  }, [sessionTokenFromUrl, user]); // Only re-run if token changes or auth state changes

  // Callback to sync message count when a message is sent successfully
  // This is called from ElizaChatInterface after a successful message
  // NOTE: The actual increment happens server-side in message-handler.ts
  // This callback just fetches the latest count to update the UI
  const onMessageSent = useCallback(async () => {
    if (isAnonymous && sessionTokenFromUrl) {
      try {
        const response = await fetch(`/api/anonymous-session?token=${sessionTokenFromUrl}`);

        if (response.ok) {
          const data = await response.json();
          if (data.success && data.session) {
            const serverCount = data.session.message_count;
            setMessageCount(serverCount);
          }
        }
      } catch {
        // Silently handle fetch errors
      }
    }
  }, [isAnonymous, sessionTokenFromUrl]);
  const messagesRemaining = session ? session.messagesLimit - messageCount : Infinity;
  const progress = session ? (messageCount / session.messagesLimit) * 100 : 0;

  // Show signup prompt after 2 messages (encouraging earlier)
  const shouldShowSoftPrompt = isAnonymous && messageCount >= 2 && messagesRemaining > 0;

  // Hard paywall when no messages remaining (5 messages for free users)
  const shouldShowPaywall = isAnonymous && messagesRemaining <= 0;

  // Get CSS variables for theming
  const themeStyles = getThemeCSSVariables(theme);

  // CRITICAL: Reset room state when character changes to prevent showing stale conversation
  // This runs on mount AND when character changes
  useEffect(() => {
    const previousCharacterId = lastCharacterIdRef.current;
    const currentRoomId = useChatStore.getState().roomId;
    const currentRooms = useChatStore.getState().rooms;

    // Check if current roomId belongs to the current character
    const currentRoom = currentRoomId
      ? currentRooms.find((room) => room.id === currentRoomId)
      : null;

    // Room is valid ONLY if we find it AND it belongs to current character
    const roomIsValidForCharacter = currentRoom?.characterId === character.id;

    // Clear room if:
    // 1. Character changed within same component instance, OR
    // 2. On mount with a stale roomId (doesn't belong to current character)
    const characterChanged = previousCharacterId && previousCharacterId !== character.id;
    const hasStaleRoom = currentRoomId && !roomIsValidForCharacter;

    if (characterChanged || hasStaleRoom) {
      // Clear the current room - it doesn't belong to this character
      setRoomId(null);
      // Reset initialization refs so we can initialize for the new character
      roomInitializedRef.current = false;
      roomInitializingRef.current = false;
    }

    // Update the ref to track current character
    lastCharacterIdRef.current = character.id;
  }, [character.id, setRoomId]);

  // CRITICAL: Set the selected character ID so ElizaChatInterface knows which character to use
  useEffect(() => {
    setSelectedCharacterId(character.id);
  }, [character.id, setSelectedCharacterId]);

  // CRITICAL: Set anonymous session token in store so ElizaChatInterface can use it for API requests
  // This prevents the race condition where the cookie might not be set yet
  useEffect(() => {
    if (sessionTokenFromUrl && !user) {
      setAnonymousSessionToken(sessionTokenFromUrl);
    }
  }, [sessionTokenFromUrl, user, setAnonymousSessionToken]);

  // CRITICAL: Load existing rooms and auto-select the room for this character
  // This ensures conversation persists across page reloads for affiliate users
  // Using refs to prevent infinite loops - the effect only runs ONCE per character
  useEffect(() => {
    // Skip if already initialized for this character or currently initializing
    if (roomInitializedRef.current || roomInitializingRef.current) {
      return;
    }

    // Skip if no character ID
    if (!character.id) {
      return;
    }

    // If we have a room selected, verify it belongs to the current character
    if (roomId) {
      const currentRooms = useChatStore.getState().rooms;
      const currentRoom = currentRooms.find((room) => room.id === roomId);

      // If room exists and belongs to current character, we're good
      if (currentRoom && currentRoom.characterId === character.id) {
        roomInitializedRef.current = true;
        return;
      }

      // Room doesn't exist or belongs to different character - clear it
      setRoomId(null);
    }

    const initializeRoom = async () => {
      roomInitializingRef.current = true;

      try {
        // Load rooms (this uses internal deduplication)
        await loadRooms(true);

        // Get the current rooms from store
        const currentRooms = useChatStore.getState().rooms;

        // Find an existing room for this character
        const existingRoom = currentRooms.find((room) => room.characterId === character.id);

        if (existingRoom) {
          setRoomId(existingRoom.id);
        }

        // Mark as initialized so we don't try again
        roomInitializedRef.current = true;
      } catch {
        // Still mark as initialized to prevent retry loops
        roomInitializedRef.current = true;
      } finally {
        roomInitializingRef.current = false;
      }
    };

    initializeRoom();
  }, [
    character.id,
    loadRooms,
    roomId, // Room doesn't exist or belongs to different character - clear it
    setRoomId,
  ]); // Only depend on character.id - other deps are stable or accessed via refs/getState

  // CRITICAL: Set anonymous session cookie if session token is in URL (for affiliate users)
  // This ensures the cookie is set even if we're not sure about auth state yet
  // Also store in localStorage so client auth + migration flows can read it (httpOnly cookies aren't readable via JS)
  useEffect(() => {
    // Only set cookie if we have a session token AND user is NOT authenticated
    // (authenticated users don't need the anonymous session cookie)
    if (sessionTokenFromUrl && !user) {
      // Store in localStorage as backup (httpOnly cookies can't be read by JS)
      try {
        localStorage.setItem("eliza-anon-session-token", sessionTokenFromUrl);
      } catch {
        // Silently handle localStorage errors
      }

      fetch("/api/set-anonymous-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken: sessionTokenFromUrl }),
      });
    }
  }, [sessionTokenFromUrl, user]);

  const handleUpgrade = () => {
    toast.info("Redirecting to signup...");
    const params = new URLSearchParams({
      returnTo: `/chat/${character.id}`,
    });
    if (session?.token) {
      params.set("session", session.token);
    }
    navigate(`/login?${params.toString()}`);
  };

  // Paywall view
  if (shouldShowPaywall) {
    return (
      <div
        style={themeStyles}
        className="min-h-screen flex items-center justify-center p-4 themed-chat bg-gradient-to-b from-background to-muted/20"
      >
        <Card className="max-w-md w-full p-8 text-center space-y-6">
          <div className="flex justify-center">
            <div className="rounded-full p-4 bg-primary/10">
              <InfoIcon className="w-8 h-8 text-primary" />
            </div>
          </div>

          <div className="space-y-2">
            <h2 className="text-2xl font-bold">Log in to save {character.name}</h2>
            <p className="text-muted-foreground">
              Create a free account to keep chatting and save your character
            </p>
          </div>

          <div className="rounded-lg p-4 space-y-2 bg-muted/50">
            <p className="font-medium">What you get for free:</p>
            <ul className="text-sm text-left space-y-1 text-muted-foreground">
              <li>✅ Save your character forever</li>
              <li>✅ Continue chatting with $1.00 free credits</li>
              <li>✅ Access from any device</li>
              <li>✅ Create more characters</li>
            </ul>
          </div>

          <Button size="lg" className="w-full" onClick={handleUpgrade}>
            <Sparkles className="w-4 h-4 mr-2" />
            Log In Free
          </Button>

          <p className="text-xs text-muted-foreground">
            No credit card required • Takes 30 seconds
          </p>
        </Card>

        {/* Theme CSS Variables */}
        <style>{`
          .themed-chat {
            --theme-primary: ${theme.colors.primary};
            --theme-primary-light: ${theme.colors.primaryLight};
            --theme-accent: ${theme.colors.accent};
            --theme-gradient-from: ${theme.colors.gradientFrom};
            --theme-gradient-to: ${theme.colors.gradientTo};
          }
        `}</style>
      </div>
    );
  }

  return (
    <div style={themeStyles} className="h-screen flex flex-col themed-chat">
      {/* Free messages banner (anonymous only) */}
      {isAnonymous && !shouldShowPaywall && (
        <div className="border-b backdrop-blur-sm bg-muted/30">
          <div className="container mx-auto px-4 py-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-3">
                <Badge variant="secondary">{messagesRemaining} messages left</Badge>
                <div className="w-32 h-2 rounded-full overflow-hidden bg-muted">
                  <div
                    className="h-full transition-all duration-300 bg-primary"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={handleUpgrade}>
                <Sparkles className="w-4 h-4 mr-2" />
                Unlock Unlimited
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Soft signup prompt (5-9 messages) */}
      {shouldShowSoftPrompt && (
        <div className="border-b backdrop-blur-sm">
          <div className="container mx-auto px-4 py-3">
            <Alert className="border-primary/50 bg-primary/5">
              <Sparkles className="h-4 w-4" />
              <AlertDescription>
                Enjoying the conversation? Sign up for free to get unlimited messages and save your
                chat history.
                <Button size="sm" variant="link" onClick={handleUpgrade} className="ml-2">
                  Sign up free →
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        </div>
      )}

      {/* Chat interface */}
      <div className="flex-1 overflow-hidden">
        <ElizaChatInterface
          onMessageSent={onMessageSent}
          character={character}
          expectedCharacterId={character.id}
        />
      </div>

      {/* Theme CSS Variables */}
      <style>{`
        .themed-chat {
          --theme-primary: ${theme.colors.primary};
          --theme-primary-light: ${theme.colors.primaryLight};
          --theme-accent: ${theme.colors.accent};
          --theme-gradient-from: ${theme.colors.gradientFrom};
          --theme-gradient-to: ${theme.colors.gradientTo};
        }
      `}</style>
    </div>
  );
}
