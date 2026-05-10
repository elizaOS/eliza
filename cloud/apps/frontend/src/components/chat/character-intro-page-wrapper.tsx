/**
 * Character intro page wrapper component handling session creation and navigation.
 * Manages anonymous session creation and routing for authenticated/anonymous users.
 *
 * @param props - Character intro page wrapper configuration
 * @param props.character - Character data to display
 * @param props.characterId - Character ID
 * @param props.source - Optional source identifier
 * @param props.theme - Affiliate theme configuration
 * @param props.existingSessionId - Optional existing session ID
 * @param props.isAuthenticated - Whether user is authenticated
 */

"use client";

import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { AffiliateTheme } from "@/lib/config/affiliate-themes";
import type { UserCharacterDto } from "@/types/cloud-api";
import { CharacterIntroPage } from "./character-intro-page";

interface CharacterIntroPageWrapperProps {
  character: UserCharacterDto;
  characterId: string;
  source?: string;
  theme: AffiliateTheme;
  existingSessionId?: string;
  isAuthenticated?: boolean;
}

export function CharacterIntroPageWrapper({
  character,
  characterId,
  source,
  theme,
  existingSessionId,
  isAuthenticated = false,
}: CharacterIntroPageWrapperProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [isCreatingSession, setIsCreatingSession] = useState(false);

  // For authenticated users, go directly to chat (no session needed)
  function handleAuthenticatedStart() {
    const params = new URLSearchParams();
    if (source) params.set("source", source);
    const queryString = params.toString();
    navigate(`/chat/${characterId}${queryString ? `?${queryString}` : ""}`);
  }

  async function handleEmailSubmit(email: string): Promise<void> {
    const params = new URLSearchParams();
    if (source) params.set("source", source);

    const queryString = params.toString();
    const newUrl = `/chat/${characterId}${queryString ? `?${queryString}` : ""}`;

    navigate(newUrl);
  }

  async function handleSkip() {
    // Use existing session from URL or props if available
    const sessionFromUrl = searchParams.get("session");
    let sessionId = sessionFromUrl || existingSessionId;

    // If no existing session, CREATE one in the database
    if (!sessionId) {
      setIsCreatingSession(true);
      const response = await fetch("/api/affiliate/create-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          characterId,
          source: source || "direct",
        }),
      });

      if (response.ok) {
        const data = await response.json();
        sessionId = data.sessionToken;
      } else {
        // Fallback: generate UUID (won't have message tracking)
        sessionId = crypto.randomUUID();
      }
      setIsCreatingSession(false);
    }

    // Navigate to chat with session
    navigate(`/chat/${characterId}?session=${sessionId}&source=${source || "direct"}`);
  }

  return (
    <CharacterIntroPage
      character={character}
      onEmailSubmit={handleEmailSubmit}
      onSkip={handleSkip}
      onAuthenticatedStart={handleAuthenticatedStart}
      source={source}
      theme={theme}
      isLoading={isCreatingSession}
      isAuthenticated={isAuthenticated}
    />
  );
}
