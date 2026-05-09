/**
 * Signup prompt banner component for anonymous users.
 * Shows progressive signup prompts based on message count with different urgency levels.
 *
 * @param props - Signup prompt banner configuration
 * @param props.messageCount - Current number of messages sent
 * @param props.messagesLimit - Maximum messages allowed for anonymous users
 * @param props.onDismiss - Optional callback when banner is dismissed
 */

"use client";

import { BrandButton } from "@elizaos/cloud-ui";
import { Clock, X, Zap } from "lucide-react";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";

interface SignupPromptBannerProps {
  messageCount: number;
  messagesLimit: number;
  onDismiss?: () => void;
}

export function SignupPromptBanner({
  messageCount,
  messagesLimit,
  onDismiss,
}: SignupPromptBannerProps) {
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const [dismissed, setDismissed] = useState(false);

  const login = () => {
    const search = typeof window !== "undefined" ? window.location.search : "";
    const returnTo = encodeURIComponent(`${pathname}${search}`);
    navigate(`/login?returnTo=${returnTo}`);
  };

  const remaining = messagesLimit - messageCount;

  // Determine which prompt to show based on message count
  // Thresholds adjusted for 3-message limit
  const getPromptConfig = () => {
    if (remaining <= 0) {
      // Limit reached - show blocking message
      return {
        icon: Zap,
        iconColor: "#FF5800",
        title: "Message limit reached",
        description: "Sign up free to continue chatting",
        bgColor: "bg-[#FF5800]/15",
        borderColor: "border-[#FF5800]/40",
        urgent: true,
      };
    } else if (remaining === 1) {
      // Last message
      return {
        icon: Zap,
        iconColor: "#FF5800",
        title: "1 message left",
        description: "Sign up to keep chatting",
        bgColor: "bg-[#FF5800]/10",
        borderColor: "border-[#FF5800]/30",
        urgent: true,
      };
    } else if (messageCount >= 1) {
      // After first message
      return {
        icon: Clock,
        iconColor: "#FF5800",
        title: `${remaining} messages left`,
        description: "Sign up free for unlimited access",
        bgColor: "bg-[#FF5800]/5",
        borderColor: "border-[#FF5800]/20",
        urgent: false,
      };
    }

    return null;
  };

  const config = getPromptConfig();

  // Don't show banner if dismissed (unless limit reached) or no config
  // Can't dismiss the banner when limit is reached - must sign up
  if ((dismissed && remaining > 0) || !config) {
    return null;
  }

  const Icon = config.icon;

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  return (
    <div
      className={cn(
        "relative overflow-hidden border-b transition-all duration-300 animate-in fade-in slide-in-from-top-4",
        config.bgColor,
        config.borderColor,
      )}
    >
      {/* Animated background gradient */}
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-shimmer" />

      <div className="relative flex items-center justify-between gap-4 px-4 py-3 md:px-6">
        {/* Left: Icon + Text */}
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full"
            style={{ backgroundColor: `${config.iconColor}20` }}
          >
            <Icon
              className={cn("h-5 w-5", config.urgent && "animate-pulse")}
              style={{ color: config.iconColor }}
            />
          </div>

          <div className="flex flex-col min-w-0">
            <p className="text-sm font-semibold text-white truncate">{config.title}</p>
            <p className="text-xs text-white/60 truncate hidden sm:block">{config.description}</p>
          </div>
        </div>

        {/* Right: CTA + Dismiss */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <BrandButton
            variant={config.urgent ? "primary" : "outline"}
            size="sm"
            onClick={login}
            className={cn("whitespace-nowrap", config.urgent && "animate-pulse")}
          >
            {config.urgent ? "Sign Up Now" : "Sign Up Free"}
          </BrandButton>

          {/* Hide dismiss when limit reached */}
          {remaining > 0 && (
            <button
              onClick={handleDismiss}
              className="p-1.5 rounded hover:bg-white/10 transition-colors"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4 text-white/40 hover:text-white/60" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
