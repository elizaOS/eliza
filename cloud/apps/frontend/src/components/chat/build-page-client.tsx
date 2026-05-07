/**
 * Build page client component for character building interface.
 * Initializes chat store, handles anonymous sessions, and displays build mode with signup prompts.
 *
 * @param props - Build page client configuration
 * @param props.initialCharacters - Initial list of characters
 * @param props.isAuthenticated - Whether user is authenticated
 * @param props.initialCharacterId - Optional initial character ID
 */

"use client";

import { useSetPageHeader } from "@elizaos/cloud-ui";
import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

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

import { type Character, useChatStore } from "@/lib/stores/chat-store";
import type { ElizaCharacter } from "@/lib/types";
import { CharacterBuildMode } from "./character-build-mode";
import { SignupPromptBanner } from "./signup-prompt-banner";

interface BuildPageClientProps {
  initialCharacters: ElizaCharacter[];
  isAuthenticated: boolean;
  userId: string | null;
  initialCharacterId?: string;
}

export function BuildPageClient({
  initialCharacters,
  isAuthenticated,
  userId,
  initialCharacterId,
}: BuildPageClientProps) {
  const [anonymousSession, setAnonymousSession] = useState<{
    messageCount: number;
    messagesLimit: number;
    remainingMessages: number;
  } | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(!isAuthenticated);
  const [showWarning, setShowWarning] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Ref to track when user confirmed navigation (bypasses beforeunload)
  const isNavigatingRef = useRef(false);
  // Ref to store pending navigation target
  const pendingNavigationRef = useRef<string | null>(null);

  const navigate = useNavigate();

  // Initialize store with characters
  const { setAnonymousSessionToken, initializeState } = useChatStore();

  useSetPageHeader({
    title: "Build",
    description:
      "Build and customize AI agents using the elizaOS runtime with intelligent assistance.",
  });

  // Initialize store atomically on mount and when props change
  // CRITICAL: Auth state, characters, and selection must be set together to prevent race conditions
  // that cause incorrect viewerState computation (e.g., briefly showing non-owner controls to owners)
  useEffect(() => {
    // Transform characters to match store interface
    // In build mode, all characters are owned by the user
    const characters: Character[] = initialCharacters.map((char) => ({
      id: char.id || "",
      name: char.name || "Unknown",
      username: char.username || undefined,
      avatarUrl: char.avatarUrl || undefined,
      ownerId: userId || undefined, // User owns all their characters
    }));

    // Set all state atomically to compute correct viewerState
    // Set selected character from URL, or reset to null for creator mode (Eliza)
    // This ensures navigating to /dashboard/build always starts in creator mode
    initializeState({
      isAuthenticated,
      userId,
      characters,
      selectedCharacterId: initialCharacterId || null,
    });
  }, [initialCharacters, initialCharacterId, initializeState, isAuthenticated, userId]);

  // Initialize anonymous session for unauthenticated users
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
          console.error("[BuildPageClient] Failed to create anonymous session:", error);
        })
        .finally(() => {
          // Always set loading to false regardless of success/failure
          setIsLoadingSession(false);
        });
    }
  }, [isAuthenticated, anonymousSession, isLoadingSession, setAnonymousSessionToken]);

  // Intercept in-app navigation when there are unsaved changes
  useEffect(() => {
    if (!hasUnsavedChanges) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a");

      if (anchor && anchor.href) {
        const url = new URL(anchor.href);
        const currentUrl = new URL(window.location.href);

        // Skip blob URLs (used for file downloads like Export JSON)
        if (url.protocol === "blob:") {
          return;
        }

        // Only intercept navigation to different paths
        if (url.pathname !== currentUrl.pathname) {
          e.preventDefault();
          e.stopPropagation();
          pendingNavigationRef.current = anchor.href;
          setShowWarning(true);
        }
      }

      const button = target.closest("button");
      if (button && button.textContent?.toLowerCase().includes("back")) {
        e.preventDefault();
        e.stopPropagation();
        pendingNavigationRef.current = "back";
        setShowWarning(true);
      }
    };

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [hasUnsavedChanges]);

  // Warn on browser close/refresh (only when not already navigating via our modal)
  useEffect(() => {
    if (!hasUnsavedChanges) return;

    // Reset navigation flag when setting up new warning listener
    // This ensures the flag doesn't persist from a previous navigation
    isNavigatingRef.current = false;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Skip if user already confirmed leave via our modal
      if (isNavigatingRef.current) return;

      e.preventDefault();
      e.returnValue = "";
      return "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  const handleConfirmLeave = () => {
    // Mark that we're intentionally navigating (bypasses beforeunload)
    isNavigatingRef.current = true;
    setShowWarning(false);
    setHasUnsavedChanges(false);

    const pending = pendingNavigationRef.current;
    if (pending === "back") {
      navigate(-1);
    } else if (pending) {
      // Use navigate for internal links to avoid beforeunload
      try {
        const url = new URL(pending);
        if (url.origin === window.location.origin) {
          navigate(url.pathname + url.search + url.hash);
        } else {
          window.location.href = pending;
        }
      } catch {
        // Invalid URL format - fall back to direct navigation
        window.location.href = pending;
      }
    }
    pendingNavigationRef.current = null;
  };

  const handleCancelLeave = () => {
    setShowWarning(false);
    pendingNavigationRef.current = null;
  };

  // Show loading state while initializing anonymous session
  if (!isAuthenticated && isLoadingSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-white/60">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Unsaved Changes Warning Modal */}
      {showWarning && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[9999] animate-in fade-in duration-150">
          <div className="bg-[#0A0A0A] border border-white/10 rounded-lg p-6 flex flex-col items-center gap-4 max-w-sm mx-4 animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/20">
              <TriangleAlert className="text-amber-500 h-6 w-6" />
            </div>
            <div className="text-center">
              <h2 className="text-lg font-medium text-white">Unsaved changes</h2>
              <p className="text-sm text-white/50 mt-1">
                Your changes will be lost if you leave without saving.
              </p>
            </div>
            <div className="flex gap-3 w-full">
              <button
                onClick={handleCancelLeave}
                className="flex-1 px-4 py-2.5 border border-white/10 rounded-lg text-sm font-medium text-white/70 hover:text-white hover:bg-white/5 transition-colors"
              >
                Stay
              </button>
              <button
                onClick={handleConfirmLeave}
                className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white transition-colors"
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Signup prompt banner for anonymous users */}
      {!isAuthenticated && anonymousSession && (
        <SignupPromptBanner
          messageCount={anonymousSession.messageCount}
          messagesLimit={anonymousSession.messagesLimit}
        />
      )}

      {/* Build Mode */}
      {/* Key forces complete remount when characterId changes, ensuring fresh state */}
      <div className="flex flex-1 overflow-hidden">
        <CharacterBuildMode
          key={initialCharacterId || "creator"}
          initialCharacters={initialCharacters}
          initialCharacterId={initialCharacterId}
          onUnsavedChanges={setHasUnsavedChanges}
        />
      </div>
    </div>
  );
}
