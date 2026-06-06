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

import { useRenderGuard, useSetPageHeader } from "@elizaos/ui";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { type Character, useChatStore } from "@/lib/stores/chat-store";
import type { ElizaCharacter } from "@/lib/types";
import { useT } from "@/providers/I18nProvider";
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
  accessError,
}: ElizaPageClientProps) {
  const t = useT();
  useRenderGuard("ElizaPageClient");
  const errorShownRef = useRef(false);

  // Initialize store with characters (must be at top level)
  const { setRoomId, initializeState } = useChatStore();

  // Show access error toast when redirected from private character
  useEffect(() => {
    if (accessError && !errorShownRef.current) {
      errorShownRef.current = true;

      if (accessError.type === "private_character") {
        const characterName =
          accessError.characterName ||
          t("cloud.elizaPage.thisAgent", { defaultValue: "This agent" });
        toast.error(
          t("cloud.elizaPage.privateNotYours", {
            characterName,
            defaultValue: 'Sorry, "{{characterName}}" is not your agent',
          }),
          {
            description: t("cloud.elizaPage.privateDesc", {
              defaultValue:
                "This agent is private. Only the owner can chat with it. Ask the owner to make it public if you'd like to chat.",
            }),
            duration: 6000,
          },
        );
      } else if (accessError.type === "character_unavailable") {
        toast.error(
          t("cloud.elizaPage.characterUnavailable", {
            defaultValue: "Character unavailable",
          }),
          {
            description: t("cloud.elizaPage.characterUnavailableDesc", {
              defaultValue:
                "The selected agent could not be loaded. Retry once the backing service is healthy.",
            }),
            duration: 6000,
          },
        );
      } else {
        toast.error(
          t("cloud.elizaPage.accessDenied", {
            defaultValue: "Access denied",
          }),
          {
            description: t("cloud.elizaPage.accessDeniedDesc", {
              defaultValue: "You don't have permission to access this agent.",
            }),
            duration: 5000,
          },
        );
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
  }, [accessError, t]);

  // Note: Page header is now handled by ChatHeader component
  // Remove this if you want to completely disable the old header system for chat
  useSetPageHeader({
    title: t("cloud.elizaPage.chatTitle", { defaultValue: "Chat" }),
    description: t("cloud.elizaPage.chatDescription", {
      defaultValue:
        "Chat with AI agents or test raw model behavior with a direct playground and custom system prompts.",
    }),
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

  // Guests must sign in to chat. The $5 signup bonus is the new "try it"
  // path — anonymous sessions were removed, so unauthenticated visitors get a
  // sign-in CTA (with the agent context preserved through the OAuth round-trip).
  if (!isAuthenticated) {
    const characterName =
      sharedCharacter?.name ||
      initialCharacters[0]?.name ||
      t("cloud.elizaPage.thisAgent", { defaultValue: "this agent" });
    const returnTo =
      typeof window !== "undefined"
        ? encodeURIComponent(window.location.pathname + window.location.search)
        : "";
    const loginHref = `/login?returnTo=${returnTo}`;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center animate-in fade-in duration-300">
        <h2 className="text-xl font-semibold text-white">
          {t("cloud.elizaPage.signInToChat", {
            defaultValue: `Sign in to chat with ${characterName}`,
          })}
        </h2>
        <p className="max-w-sm text-sm text-white/60">
          {t("cloud.elizaPage.signInSubtext", {
            defaultValue:
              "Create a free account and get $5 in credits to start.",
          })}
        </p>
        <div className="flex items-center gap-3">
          <a
            href={loginHref}
            className="bg-[#FF5800] px-5 py-2.5 font-semibold text-white transition-colors hover:bg-[#e54f00]"
          >
            {t("cloud.login.button.signUp", { defaultValue: "Sign Up" })}
          </a>
          <a
            href={loginHref}
            className="border border-white/30 px-5 py-2.5 font-semibold text-white transition-colors hover:bg-white/10"
          >
            {t("cloud.login.button.logIn", { defaultValue: "Log In" })}
          </a>
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
