/**
 * Chat message component for the landing page chat interface.
 * Supports user/AI messages, typing animation, and thinking state.
 */

"use client";

import { useEffect, useState } from "react";

/** Message type for chat */
export interface ChatMessageData {
  id: number;
  text: string;
  isUser: boolean;
  isThinking?: boolean;
  isTyping?: boolean;
  hasSignUpButton?: boolean;
}

/** Thinking loader component */
function ThinkingLoader() {
  return <p className="text-white/50 font-medium text-sm animate-pulse">Thinking...</p>;
}

/** Typewriter text component */
function TypewriterText({ text, onUpdate }: { text: string; onUpdate?: () => void }) {
  const words = text.split(" ");
  const initialWords = 10;
  const [wordCount, setWordCount] = useState(Math.min(initialWords, words.length));

  useEffect(() => {
    if (wordCount < words.length) {
      const timeout = setTimeout(() => {
        setWordCount((prev) => prev + 1);
        onUpdate?.();
      }, 80);
      return () => clearTimeout(timeout);
    }
  }, [wordCount, words.length, onUpdate]);

  const displayedText = words.slice(0, wordCount).join(" ");

  return (
    <p className="text-[15px] leading-relaxed text-white/90">
      {displayedText}
      {wordCount < words.length && (
        <span className="inline-block w-[2px] h-[1em] bg-white/60 ml-[1px] animate-blink align-middle" />
      )}
    </p>
  );
}

interface ChatMessageProps {
  message: ChatMessageData;
  isNew: boolean;
  onContentUpdate?: () => void;
  onSignInClick: () => void;
}

/** Chat message component */
export function ChatMessage({ message, isNew, onContentUpdate, onSignInClick }: ChatMessageProps) {
  // User message styling - matches dashboard build agent chat
  if (message.isUser) {
    return (
      <div className={`flex justify-end ${isNew ? "animate-slideIn" : ""}`}>
        <div className="py-3 px-4 bg-[#FF5800]/10 border border-[#FF5800]/20 rounded-lg max-w-[85%] sm:max-w-[75%]">
          <p className="text-[15px] leading-relaxed text-white">{message.text}</p>
        </div>
      </div>
    );
  }

  // AI message styling - matches dashboard build agent chat
  return (
    <div
      className={`flex flex-col gap-2 ${isNew ? "animate-slideIn" : ""} ${message.hasSignUpButton ? "mt-6" : ""}`}
    >
      {/* Avatar and name row */}
      <div className="flex items-end gap-2.5">
        <div className="w-7 h-7 rounded-full bg-gradient-to-tl from-brand-orange to-orange-600 flex items-center justify-center shrink-0">
          {message.isThinking ? (
            <div className="size-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
          ) : (
            <span className="text-white text-xs font-bold">E</span>
          )}
        </div>
        <span className="text-sm font-medium text-white/60">Eliza</span>
      </div>

      {/* Message content */}
      <div className="max-w-[85%] sm:max-w-[75%]">
        {message.isThinking ? (
          <ThinkingLoader />
        ) : message.isTyping ? (
          <TypewriterText text={message.text} onUpdate={onContentUpdate} />
        ) : (
          <div>
            <p className="text-[15px] leading-relaxed text-white/90">{message.text}</p>
            {message.hasSignUpButton && (
              <button
                onMouseDown={() => {
                  onSignInClick();
                }}
                className="mt-1.5 px-4 py-2 bg-[#FF5800] text-white text-sm font-medium rounded-lg hover:bg-[#FF5800]/90 transition-colors"
              >
                Sign In
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
