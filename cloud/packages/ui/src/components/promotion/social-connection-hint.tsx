"use client";

/**
 * Social Connection Hint Component
 *
 * Displays dismissable hint cards for Discord and Telegram connections
 * when they are not yet connected. Helps guide new users to connect
 * their social platforms for promotion automation.
 */

import { ArrowRight, Bot, MessageSquare, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { DiscordIcon } from "../icons";
import { BrandCard, Button } from "../primitives";

const STORAGE_KEY_DISCORD = "eliza_dismiss_discord_hint";
const STORAGE_KEY_TELEGRAM = "eliza_dismiss_telegram_hint";

// Helper to safely get localStorage value (client-side only)
function getStorageValue(key: string): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(key) === "true";
}

interface ConnectionStatus {
  discord: {
    configured: boolean;
    connected: boolean;
    guildCount?: number;
  };
  telegram: {
    configured: boolean;
    connected: boolean;
    botUsername?: string;
  };
}

interface AutomationStatus {
  discord: {
    enabled: boolean;
    ready: boolean;
  };
  telegram: {
    enabled: boolean;
    ready: boolean;
  };
}

interface SocialConnectionHintProps {
  connectionStatus: ConnectionStatus;
  automationStatus: AutomationStatus;
}

interface DismissedState {
  discord: boolean;
  telegram: boolean;
  mounted: boolean;
}

export function SocialConnectionHint({
  connectionStatus,
  automationStatus,
}: SocialConnectionHintProps) {
  // Use single state object to avoid multiple setState calls in effect
  // Start with dismissed=true to avoid flash on SSR
  const [state, setState] = useState<DismissedState>({
    discord: true,
    telegram: true,
    mounted: false,
  });

  // Check localStorage after mount to avoid SSR mismatch
  // This is a valid hydration pattern - we need to read localStorage client-side only
  useEffect(() => {
    setState({
      discord: getStorageValue(STORAGE_KEY_DISCORD),
      telegram: getStorageValue(STORAGE_KEY_TELEGRAM),
      mounted: true,
    });
  }, []);

  const handleDismissDiscord = () => {
    setState((prev) => ({ ...prev, discord: true }));
    localStorage.setItem(STORAGE_KEY_DISCORD, "true");
  };

  const handleDismissTelegram = () => {
    setState((prev) => ({ ...prev, telegram: true }));
    localStorage.setItem(STORAGE_KEY_TELEGRAM, "true");
  };

  // Don't show hint if:
  // 1. Platform is connected at org level, OR
  // 2. Automation is already enabled for this app (user already set it up), OR
  // 3. User dismissed the hint
  const showDiscordHint =
    !connectionStatus.discord.connected && !automationStatus.discord.enabled && !state.discord;
  const showTelegramHint =
    !connectionStatus.telegram.connected && !automationStatus.telegram.enabled && !state.telegram;

  // Don't render anything if both hints are hidden
  if (!showDiscordHint && !showTelegramHint) {
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Discord Connection Hint */}
      {showDiscordHint && (
        <BrandCard className="p-4 border-[#5865F2]/30 bg-[#5865F2]/5 relative">
          <button
            type="button"
            onClick={handleDismissDiscord}
            className="absolute top-3 right-3 p-1 rounded-md hover:bg-white/10 transition-colors text-white/40 hover:text-white/60"
            aria-label="Dismiss Discord hint"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="flex items-start gap-4 pr-8">
            <div className="p-3 rounded-lg bg-[#5865F2]/20 shrink-0">
              <DiscordIcon className="h-6 w-6 text-[#5865F2]" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-white font-semibold flex items-center gap-2 mb-1">
                <Sparkles className="h-4 w-4 text-[#5865F2]" />
                Connect Discord for Automated Promotion
              </h3>
              <p className="text-white/60 text-sm mb-3">
                Add our bot to your Discord server to post AI-generated announcements, share
                updates, and engage your community automatically.
              </p>
              <div className="flex items-center gap-3">
                <Button asChild size="sm" className="bg-[#5865F2] hover:bg-[#4752C4]">
                  <Link to="/dashboard/settings?tab=connections">
                    Connect Discord
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Link>
                </Button>
                <span className="text-white/40 text-xs">Takes less than a minute</span>
              </div>
            </div>
          </div>
        </BrandCard>
      )}

      {/* Telegram Connection Hint */}
      {showTelegramHint && (
        <BrandCard className="p-4 border-[#0088cc]/30 bg-[#0088cc]/5 relative">
          <button
            type="button"
            onClick={handleDismissTelegram}
            className="absolute top-3 right-3 p-1 rounded-md hover:bg-white/10 transition-colors text-white/40 hover:text-white/60"
            aria-label="Dismiss Telegram hint"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="flex items-start gap-4 pr-8">
            <div className="p-3 rounded-lg bg-[#0088cc]/20 shrink-0">
              <MessageSquare className="h-6 w-6 text-[#0088cc]" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-white font-semibold flex items-center gap-2 mb-1">
                <Bot className="h-4 w-4 text-[#0088cc]" />
                Connect Telegram Bot for Announcements
              </h3>
              <p className="text-white/60 text-sm mb-3">
                Create a Telegram bot to post announcements to your channels and groups, auto-reply
                to messages, and welcome new members.
              </p>
              <div className="flex items-center gap-3">
                <Button asChild size="sm" className="bg-[#0088cc] hover:bg-[#0077b5]">
                  <Link to="/dashboard/settings?tab=connections">
                    Connect Telegram
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Link>
                </Button>
                <span className="text-white/40 text-xs">Create via @BotFather</span>
              </div>
            </div>
          </div>
        </BrandCard>
      )}

      {/* Both platforms connected hint - show only if both disconnected and neither dismissed */}
      {showDiscordHint && showTelegramHint && (
        <div className="text-center text-white/40 text-xs py-2">
          Connect at least one platform to enable automated social promotion
        </div>
      )}
    </div>
  );
}
