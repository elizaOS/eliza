/**
 * Character introduction page component displayed before starting a chat.
 * Shows character information, bio, and email capture for anonymous users.
 * Supports affiliate theming and authentication state handling.
 *
 * @param props - Character intro page configuration
 * @param props.character - Character data to display
 * @param props.onEmailSubmit - Callback when email is submitted
 * @param props.onSkip - Callback when user skips email capture
 * @param props.onAuthenticatedStart - Optional callback for authenticated users
 * @param props.source - Optional source identifier
 * @param props.theme - Affiliate theme configuration
 * @param props.isLoading - Whether page is in loading state
 * @param props.isAuthenticated - Whether user is authenticated
 */

"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Card,
  CardContent,
} from "@elizaos/cloud-ui";
import { MessageCircle, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import type { AffiliateTheme } from "@/lib/config/affiliate-themes";
import { getThemeCSSVariables } from "@/lib/config/affiliate-themes";
import type { UserCharacterDto } from "@/types/cloud-api";
import { EmailCaptureModal } from "./email-capture-modal";

interface CharacterIntroPageProps {
  character: UserCharacterDto;
  onEmailSubmit: (email: string) => Promise<void>;
  onSkip: () => void;
  onAuthenticatedStart?: () => void;
  source?: string;
  theme: AffiliateTheme;
  isLoading?: boolean;
  isAuthenticated?: boolean;
}

export function CharacterIntroPage({
  character,
  onEmailSubmit,
  onSkip,
  onAuthenticatedStart,
  source,
  theme,
  isLoading: parentLoading = false,
  isAuthenticated = false,
}: CharacterIntroPageProps) {
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const isAnyLoading = isLoading || parentLoading;

  // Extract bio text
  const bioText = Array.isArray(character.bio) ? character.bio.join(" ") : character.bio;

  // Get vibe from character metadata
  const characterData = character.character_data as Record<string, unknown> | undefined;
  const affiliate = characterData?.affiliate as
    | { vibe?: string; [key: string]: unknown }
    | undefined;
  const vibeLabel = affiliate?.vibe;

  const handleStartChat = () => {
    // If user is authenticated, skip the modal and go directly to chat
    if (isAuthenticated && onAuthenticatedStart) {
      onAuthenticatedStart();
      return;
    }
    // Show email modal for unauthenticated users
    setShowEmailModal(true);
  };

  const handleEmailSubmit = async (email: string) => {
    setIsLoading(true);
    await onEmailSubmit(email);
    setIsLoading(false);
  };

  const handleSkip = () => {
    setShowEmailModal(false);
    onSkip();
  };

  // Get CSS variables for theming
  const themeStyles = getThemeCSSVariables(theme);

  return (
    <div
      style={themeStyles}
      className="min-h-screen themed-intro bg-gradient-to-b from-background to-muted/20"
    >
      <div className="container mx-auto px-4 py-12 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="max-w-3xl mx-auto"
        >
          {/* Header */}
          <div className="text-center mb-8">
            {theme.features.showSourceBadge && source && (
              <Badge variant="secondary" className="mb-4">
                Created via {source}
              </Badge>
            )}
            <h1 className="text-4xl font-bold mb-2">Meet Your AI Companion</h1>
            <p className="text-muted-foreground">{theme.branding.tagline}</p>
          </div>

          {/* Character Card */}
          <Card className="mb-8 overflow-hidden border-2">
            <CardContent className="p-8">
              <div className="flex flex-col items-center text-center space-y-6">
                {/* Avatar */}
                <motion.div
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: 0.2, duration: 0.4 }}
                >
                  <div className="relative">
                    <Avatar className="h-32 w-32 relative border-4 border-primary/20">
                      <AvatarImage src={character.avatar_url || undefined} />
                      <AvatarFallback className="text-4xl bg-gradient-to-br from-primary/20 to-primary/10">
                        {character.name.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  </div>
                </motion.div>

                {/* Name and Vibe */}
                <div>
                  <h2 className="text-3xl font-bold mb-2">{character.name}</h2>
                  {theme.features.showVibeLabel && vibeLabel && (
                    <Badge variant="outline" className="text-lg px-3 py-1">
                      <Sparkles className="w-4 h-4 mr-2" />
                      {vibeLabel.charAt(0).toUpperCase() + vibeLabel.slice(1)}
                    </Badge>
                  )}
                </div>

                {/* Bio */}
                <p className="text-lg max-w-xl leading-relaxed text-muted-foreground">{bioText}</p>

                {/* CTA Button */}
                <motion.div
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: 0.4, duration: 0.3 }}
                  className="w-full max-w-md space-y-4 mt-6"
                >
                  <Button
                    size="lg"
                    className="w-full text-lg h-14 bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70"
                    onClick={handleStartChat}
                    disabled={isAnyLoading}
                  >
                    <MessageCircle className="w-5 h-5 mr-2" />
                    Start Chatting (Free)
                  </Button>

                  <p className="text-sm text-muted-foreground">
                    No credit card required • 10 free messages
                  </p>
                </motion.div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Email Capture Modal */}
      <EmailCaptureModal
        open={showEmailModal}
        onClose={() => setShowEmailModal(false)}
        onSubmit={handleEmailSubmit}
        onSkip={handleSkip}
        characterName={character.name}
        isLoading={isLoading}
      />

      {/* Theme CSS Variables */}
      <style>{`
        .themed-intro {
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
