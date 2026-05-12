/**
 * Enhanced loading component with animated background and random loading messages.
 * Displays progress bar and animated spinner for image generation.
 *
 * @param props - Enhanced loading configuration
 * @param props.message - Optional custom loading message
 * @param props.progress - Optional progress percentage (0-100)
 */

"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useState } from "react";

const LOADING_MESSAGES = [
  "Painting pixels with AI magic...",
  "Mixing colors and dreams...",
  "Bringing your vision to life...",
  "Consulting with digital artists...",
  "Adding the finishing touches...",
];

interface EnhancedLoadingProps {
  message?: string;
  progress?: number;
}

export function EnhancedLoading({ message, progress }: EnhancedLoadingProps) {
  const [randomMessage] = useState(
    () => LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)],
  );
  const displayMessage = message || randomMessage;

  return (
    <div className="relative w-full h-[500px] rounded-none border border-white/10 bg-black/40 overflow-hidden">
      {/* Animated background */}
      <div className="absolute inset-0 bg-[#FF5800]/5" />

      {/* Center content */}
      <div className="relative z-10 flex flex-col items-center justify-center h-full px-6 space-y-3">
        {/* Animated icon */}
        <div className="relative">
          <div className="absolute inset-0 animate-ping opacity-75">
            <div className="w-12 h-12 rounded-full bg-[#FF5800]/20" />
          </div>
          <div className="relative flex items-center justify-center w-12 h-12 rounded-full bg-black/60 border border-[#FF5800]/40">
            <Loader2 className="w-6 h-6 text-[#FF5800] animate-spin" />
          </div>
        </div>

        {/* Loading text */}
        <div className="text-center space-y-2">
          <p className="text-sm font-semibold text-white">{displayMessage}</p>

          {/* Progress bar */}
          {progress !== undefined && (
            <div className="w-48 h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full bg-[#FF5800] transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          <p className="text-xs text-white/60">This may take 10-30 seconds</p>
        </div>

        {/* Status indicator */}
        <div className="flex items-center gap-1.5 text-xs text-white/50">
          <Sparkles className="h-3 w-3 text-[#FF5800]" />
          <span>AI Model Active</span>
        </div>
      </div>
    </div>
  );
}
