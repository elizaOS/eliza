/**
 * Eliza page client component for the main chat interface.
 * Initializes chat store, handles anonymous sessions, and displays chat interface with signup prompts.
 *
 * @param props - Eliza page client configuration
 * @param props.initialCharacters - Initial list of characters
 * @param props.isAuthenticated - Whether user is authenticated
 * @param props.initialRoomId - Optional initial room ID
 * @param props.initialCharacterId - Optional initial character ID
 */

"use client";

import { useSetPageHeader } from "@elizaos/cloud-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { type Character, useChatStore } from "@/lib/stores/chat-store";

interface AnonymousSessionResult {
  isNew: boolean;
  user: { id: string; [key: string]: unknown };
  session: {
    id: string;
    message_count: number;
    messages_limit: number;
    session_token: string;
    expires_at: string;
    is_active: boolean;
  };
}

async function getOrCreateAnonymousUserAction(): Promise<AnonymousSessionResult> {
  const res = await fetch("/api/auth/anonymous-session", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Failed to create anonymous session (${res.status})`);
  }
  return (await res.json()) as AnonymousSessionResult;
}

import type { ElizaCharacter } from "@/lib/types";
import { ElizaChatInterface } from "./eliza-chat-interface";
import { ModelPlayground } from "./model-playground";

interface SharedCharacter {
  id: string;
  name: string;
  username?: string | null;
  avatarUrl?: string | null;
  bio?: string;
  ownerId?: string;
  creatorUsername?: string | null;
}

interface AccessError {
  type: string;
  characterName?: string;
}

interface ElizaPageClientProps {
  initialCharacters: ElizaCharacter[];
  isAuthenticated: boolean;
  userId: string | null;
  initialRoomId?: string;
  initialCharacterId?: string;
  /** Pre-loaded character data for shared links (when character is not owned by user) */
  sharedCharacter?: SharedCharacter | null;
  /** Whether the current user owns the selected character */
  isOwnerOfSelectedCharacter?: boolean;
  /** Access error when trying to load a private character */
  accessError?: AccessError;
}

export function ElizaPageClient({
  initialCharacters,
  isAuthenticated,
  userId,
  initialRoomId,
  initialCharacterId,
  sharedCharacter,
  isOwnerOfSelectedCharacter,
  accessError,
}: ElizaPageClientProps) {
  const [anonymousSession, setAnonymousSession] = useState<{
    messageCount: number;
    messagesLimit: number;
    remainingMessages: number;
  } | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(!isAuthenticated);
  const errorShownRef = useRef(false);

  // Initialize store with characters (must be at top level)
  const { setRoomId, setAnonymousSessionToken, initializeState } = useChatStore();

  // Show access error toast when redirected from private character
  useEffect(() => {
    if (accessError && !errorShownRef.current) {
      errorShownRef.current = true;

      if (accessError.type === "private_character") {
        const characterName = accessError.characterName || "This agent";
        toast.error(`Sorry, "${characterName}" is not your agent`, {
          description:
            "This agent is private. Only the owner can chat with it. Ask the owner to make it public if you'd like to chat.",
          duration: 6000,
        });
      } else if (accessError.type === "character_unavailable") {
        toast.error("Character unavailable", {
          description:
            "The selected agent could not be loaded. Retry once the backing service is healthy.",
          duration: 6000,
        });
      } else {
        toast.error("Access denied", {
          description: "You don't have permission to access this agent.",
          duration: 5000,
        });
      }

      // Clear error AND characterId from URL without navigation
      // This prevents the URL from showing a characterId that the user can't access
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.delete("error");
        url.searchParams.delete("name");
        url.searchParams.delete("characterId"); // Also clear the inaccessible characterId
        window.history.replaceState({}, "", url.toString());
      }
    }
  }, [accessError]);

  // Note: Page header is now handled by ChatHeader component
  // Remove this if you want to completely disable the old header system for chat
  useSetPageHeader({
    title: "Chat",
    description:
      "Chat with AI agents or test raw model behavior with a direct playground and custom system prompts.",
  });

  // Memoize transformed characters to prevent unnecessary re-renders
  // Include shared character data for shared links (when character is not owned by user)
  const characters = useMemo<Character[]>(() => {
    // User's own characters - they own all of these
    const chars: Character[] = initialCharacters.map((char) => ({
      id: char.id || "",
      name: char.name || "Unknown",
      username: char.username || undefined,
      avatarUrl: char.avatarUrl || undefined,
      ownerId: userId || undefined, // User owns their own characters
    }));

    // Add shared character if provided and not already in the list
    if (sharedCharacter && !chars.some((c) => c.id === sharedCharacter.id)) {
      chars.push({
        id: sharedCharacter.id,
        name: sharedCharacter.name,
        username: sharedCharacter.username || undefined,
        avatarUrl: sharedCharacter.avatarUrl || undefined,
        bio: sharedCharacter.bio,
        ownerId: sharedCharacter.ownerId,
        creatorUsername: sharedCharacter.creatorUsername || undefined,
      });
    }

    return chars;
  }, [initialCharacters, sharedCharacter, userId]);

  // Initialize store atomically on mount and when props change
  // CRITICAL: Auth state, characters, and selection must be set together to prevent race conditions
  // that cause incorrect viewerState computation (e.g., briefly showing owner controls to non-owners)
  useEffect(() => {
    // Set all state atomically to compute correct viewerState
    initializeState({
      isAuthenticated,
      userId,
      characters,
      selectedCharacterId: initialCharacterId || null,
    });

    // Handle roomId separately (not involved in viewerState computation)
    if (initialCharacterId && !initialRoomId) {
      // Clear stored roomId when navigating to a new character
      // This ensures a fresh room is created for the new character
      setRoomId(null);
    } else if (initialRoomId) {
      setRoomId(initialRoomId);
    }
  }, [
    isAuthenticated,
    userId,
    characters,
    initialCharacterId,
    initialRoomId,
    initializeState,
    setRoomId,
  ]);

  // Initialize anonymous session for unauthenticated users (only once)
  useEffect(() => {
    if (!isAuthenticated && !anonymousSession && isLoadingSession) {
      getOrCreateAnonymousUserAction()
        .then((result) => {
          // Safely handle potentially null/undefined result
          if (result?.session) {
            setAnonymousSession({
              messageCount: result.session.message_count ?? 0,
              messagesLimit: result.session.messages_limit ?? 3,
              remainingMessages:
                (result.session.messages_limit ?? 3) - (result.session.message_count ?? 0),
            });
            // Store session token in chat store so it gets passed with messages
            if (result.session.session_token) {
              setAnonymousSessionToken(result.session.session_token);
            }
          }
        })
        .catch((error) => {
          console.error("[ElizaPageClient] Failed to create anonymous session:", error);
        })
        .finally(() => {
          // Always set loading to false regardless of success/failure
          setIsLoadingSession(false);
        });
    }
  }, [anonymousSession, isAuthenticated, isLoadingSession, setAnonymousSessionToken]); // Only run on mount

  // Show loading state while initializing anonymous session
  if (!isAuthenticated && isLoadingSession) {
    return (
      <div className="flex h-full items-center justify-center animate-in fade-in duration-300">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-white/40 animate-pulse" />
          <div className="text-white/60">Loading...</div>
        </div>
      </div>
    );
  }

  const shouldShowPlayground = !initialCharacterId && !sharedCharacter;

  if (shouldShowPlayground) {
    return <ModelPlayground />;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden animate-in fade-in duration-300">
      {/* Chat Interface */}
      <div className="flex flex-1 overflow-hidden">
        <ElizaChatInterface expectedCharacterId={initialCharacterId} />
      </div>
    </div>
  );
}
