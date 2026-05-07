/**
 * Memoized chat message component for performance optimization.
 * Prevents re-renders of messages that haven't changed.
 */

"use client";

import { Button } from "@elizaos/cloud-ui";
import dynamic from "@elizaos/cloud-ui/runtime/dynamic";
import Image from "@elizaos/cloud-ui/runtime/image";
import { Check, Copy, Loader2, Square, Volume2 } from "lucide-react";
import React, { memo, useEffect, useRef, useState } from "react";
import { type ChatMediaAttachment, ContentType } from "@elizaos/cloud-ui/types/chat-media";
import { ElizaAvatar } from "./eliza-avatar";

/**
 * Hook for smooth typewriter animation of streaming text.
 * Handles burst input gracefully by revealing text at a consistent, readable pace.
 * Uses requestAnimationFrame for smooth 60fps animation.
 *
 * KEY DESIGN PRINCIPLES:
 * 1. First chunk appears IMMEDIATELY - no delay
 * 2. NEVER jumps to end - always types at visible speed
 * 3. Catches up smoothly when behind, but max speed is capped
 * 4. Animation continues after stream ends at same pace
 */
function useTypewriterText(
  targetText: string,
  isActive: boolean,
  config: { onReveal?: () => void } = {},
) {
  const { onReveal } = config;

  // CONSISTENT SPEED APPROACH:
  // - Never "jump" by revealing too much at once
  // - Keep typing at a steady pace regardless of how much is buffered
  // - Fast enough to not feel sluggish (6 chars per 10ms = ~600 chars/sec)
  // - Slow enough to be readable and feel like typing
  const CHARS_PER_FRAME = 6;
  const FRAME_DELAY = 10; // ms between frames

  // Track animation state in ref (for animation logic)
  const animState = useRef({
    visibleLength: 0,
    lastFrame: 0,
    animationId: null as number | null,
    lastTargetLength: 0,
    everActive: false,
  });

  // Track display state in React state (for rendering)
  const [displayLength, setDisplayLength] = useState(0);

  // Store onReveal in ref so it doesn't cause effect re-runs
  const onRevealRef = useRef(onReveal);
  useEffect(() => {
    onRevealRef.current = onReveal;
  });

  // Handle animation
  useEffect(() => {
    const state = animState.current;

    // Track if ever active
    if (isActive) {
      state.everActive = true;
    }

    // Detect new message (target got shorter) and reset
    if (targetText.length < state.lastTargetLength) {
      state.visibleLength = 0;
      state.lastTargetLength = targetText.length;
      setDisplayLength(0);
    } else {
      state.lastTargetLength = targetText.length;
    }

    // Skip animation for history messages (never activated)
    if (!isActive && !state.everActive) {
      return;
    }

    // Animation complete
    if (state.visibleLength >= targetText.length && targetText.length > 0) {
      return;
    }

    const animate = (timestamp: number) => {
      // Frame rate control
      if (timestamp - state.lastFrame < FRAME_DELAY) {
        state.animationId = requestAnimationFrame(animate);
        return;
      }
      state.lastFrame = timestamp;

      const remaining = targetText.length - state.visibleLength;

      if (remaining <= 0) {
        state.animationId = null;
        return;
      }

      // CONSISTENT TYPING: Always same speed, never jump
      // This prevents the "streaming few lines then jumping" issue
      const toReveal = Math.min(CHARS_PER_FRAME, remaining);

      state.visibleLength += toReveal;
      setDisplayLength(state.visibleLength);

      // Notify parent to scroll
      onRevealRef.current?.();

      // Continue if more to reveal
      if (state.visibleLength < targetText.length) {
        state.animationId = requestAnimationFrame(animate);
      } else {
        state.animationId = null;
      }
    };

    // Start animation immediately if we have text
    if (!state.animationId && targetText.length > state.visibleLength) {
      state.animationId = requestAnimationFrame(animate);
    }

    // Capture ref value for cleanup
    const currentAnimState = animState.current;

    return () => {
      if (currentAnimState.animationId) {
        cancelAnimationFrame(currentAnimState.animationId);
        currentAnimState.animationId = null;
      }
    };
  }, [isActive, targetText]);

  // RENDER LOGIC:
  // - If displayLength > 0: animation is in progress, show animated portion
  // - If displayLength === 0 but isActive: animation will start next frame, show empty
  // - If displayLength === 0 and !isActive: not a streaming message, show full text
  if (displayLength > 0 || isActive) {
    return targetText.slice(0, displayLength);
  }

  return targetText;
}

/**
 * Hook for smooth typewriter animation of reasoning/CoT text.
 * Slightly slower than main text for easier reading of thought process.
 */
function useReasoningTypewriter(targetText: string, isActive: boolean, onReveal?: () => void) {
  // Slower for reasoning: 4 chars per 12ms = ~333 chars/sec
  // Consistent speed - never jumps
  const CHARS_PER_FRAME = 4;
  const FRAME_DELAY = 12;

  const animState = useRef({
    visibleLength: 0,
    lastFrame: 0,
    animationId: null as number | null,
    lastTargetLength: 0,
    everActive: false,
  });

  const [displayLength, setDisplayLength] = useState(0);

  const onRevealRef = useRef(onReveal);
  useEffect(() => {
    onRevealRef.current = onReveal;
  });

  useEffect(() => {
    const state = animState.current;

    if (isActive && targetText) {
      state.everActive = true;
    }

    // Detect reset
    if (!targetText || targetText.length < state.lastTargetLength) {
      state.visibleLength = 0;
      state.lastTargetLength = targetText?.length || 0;
      setDisplayLength(0);
      if (!targetText) {
        state.everActive = false;
      }
      return;
    }
    state.lastTargetLength = targetText.length;

    if (!isActive && !state.everActive) {
      return;
    }

    if (state.visibleLength >= targetText.length && targetText.length > 0) {
      return;
    }

    const animate = (timestamp: number) => {
      if (timestamp - state.lastFrame < FRAME_DELAY) {
        state.animationId = requestAnimationFrame(animate);
        return;
      }
      state.lastFrame = timestamp;

      const remaining = targetText.length - state.visibleLength;
      if (remaining <= 0) {
        state.animationId = null;
        return;
      }

      // Consistent speed - never jumps
      const toReveal = Math.min(CHARS_PER_FRAME, remaining);

      state.visibleLength += toReveal;
      setDisplayLength(state.visibleLength);

      onRevealRef.current?.();

      if (state.visibleLength < targetText.length) {
        state.animationId = requestAnimationFrame(animate);
      } else {
        state.animationId = null;
      }
    };

    if (!state.animationId && targetText.length > state.visibleLength) {
      state.animationId = requestAnimationFrame(animate);
    }

    const currentState = animState.current;

    return () => {
      if (currentState.animationId) {
        cancelAnimationFrame(currentState.animationId);
        currentState.animationId = null;
      }
    };
  }, [targetText, isActive]);

  if (!targetText) return "";
  if (displayLength > 0 || isActive) return targetText.slice(0, displayLength);
  return targetText;
}

// Dynamically import ReactMarkdown to reduce initial bundle (~150KB savings)
// No loading fallback - we'll show plain text while it loads to avoid flicker
const ReactMarkdown = dynamic(() => import("react-markdown"), {
  ssr: false,
});

/**
 * Normalize markdown list formatting.
 * Fixes LLM output that puts extra newlines between numbered list items,
 * which causes markdown to render them as separate paragraphs instead of a list.
 */
function normalizeMarkdownLists(text: string): string {
  // Pattern 1: Fix paragraph breaks between numbered list items
  // "11. **Item**...\n\n12. **Item**..." → "11. **Item**...\n12. **Item**..."
  // This ensures markdown recognizes consecutive numbered items as a list
  let result = text.replace(/(\d+\.\s+[^\n]+)\n\n+(?=\d+\.\s)/g, "$1\n");

  // Pattern 2: Fix numbered lists where number is on its own line
  // "1.\n\nVisit..." → "1. Visit..."
  result = result.replace(/^(\d+\.)\s*[\r\n]+\s*(?=\S)/gm, "$1 ");

  // Pattern 3: Fix bold numbers on their own line
  // "**1.**\nVisit..." → "1. Visit..."
  result = result.replace(/^\*\*(\d+)\.\*\*\s*[\r\n]+\s*/gm, "$1. ");

  return result;
}

// Pre-load plugins at module level - shared across all message instances
// This prevents the flash caused by loading plugins inside each component
let pluginsCache: { remarkGfm: any; rehypeHighlight: any } | null = null;
const pluginsPromise = Promise.all([
  import("remark-gfm").then((mod) => mod.default),
  import("rehype-highlight").then((mod) => mod.default),
]).then(([remarkGfm, rehypeHighlight]) => {
  pluginsCache = { remarkGfm, rehypeHighlight };
  return pluginsCache;
});

// Hook to access shared plugins - all components share the same cache
function useMarkdownPlugins() {
  // Initialize with cache if available (avoids any async wait)
  const [plugins, setPlugins] = useState(pluginsCache);

  useEffect(() => {
    // Already have plugins (from initial state or previous load)
    if (plugins) return;

    // Subscribe to the promise - resolves immediately if already loaded
    let mounted = true;
    pluginsPromise.then((loaded) => {
      if (mounted) {
        setPlugins(loaded);
      }
    });
    return () => {
      mounted = false;
    };
  }, [plugins]);

  return plugins;
}

interface Message {
  id: string;
  content: {
    text: string;
    clientMessageId?: string;
    attachments?: ChatMediaAttachment[];
  };
  isAgent: boolean;
  createdAt: number;
}

interface MemoizedChatMessageProps {
  message: Message;
  characterName: string;
  characterAvatarUrl?: string;
  copiedMessageId: string | null;
  currentPlayingId: string | null;
  isPlaying: boolean;
  hasAudioUrl: boolean;
  isStreaming?: boolean;
  formatTimestamp: (timestamp: number) => string;
  onCopy: (
    text: string,
    messageId: string,
    attachments?: Message["content"]["attachments"],
  ) => void;
  onPlayAudio?: (messageId: string) => void;
  onImageLoad?: () => void;
  /** Chain-of-thought reasoning text to display while thinking */
  reasoningText?: string;
  /** Current phase of reasoning: planning, actions, or response */
  reasoningPhase?: "planning" | "actions" | "response" | null;
  /** Callback when typewriter animation reveals more text (for scrolling) */
  onTextReveal?: () => void;
}

// Markdown components configuration
const markdownComponents = {
  code: ({
    className,
    children,
    ...props
  }: React.ComponentPropsWithoutRef<"code"> & { className?: string }) => {
    const isInline = !className;
    return isInline ? (
      <code className="bg-white/10 px-1.5 py-0.5 rounded text-xs break-all" {...props}>
        {children}
      </code>
    ) : (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="bg-black/40 border border-white/10 rounded-lg p-3 overflow-x-auto [&>code]:whitespace-pre-wrap [&>code]:break-words">
      {children}
    </pre>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[#FF5800] hover:text-[#FF5800]/80 underline break-all"
    >
      {children}
    </a>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc list-inside">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal list-inside">{children}</ol>
  ),
};

function ChatMessageComponent(props: MemoizedChatMessageProps) {
  const {
    message,
    characterName,
    characterAvatarUrl,
    copiedMessageId,
    currentPlayingId,
    isPlaying,
    hasAudioUrl,
    isStreaming = false,
    formatTimestamp,
    onCopy,
    onPlayAudio,
    onImageLoad,
    reasoningText,
    reasoningPhase,
    onTextReveal,
  } = props;
  const isThinking = message.id.startsWith("thinking-");
  // Use shared plugins cache - no flash since plugins are pre-loaded at module level
  const plugins = useMarkdownPlugins();

  // Detect streaming from message id if not explicitly passed
  const isStreamingMessage = isStreaming || message.id.startsWith("streaming-");

  // Show reasoning for thinking messages OR streaming messages with "response" phase reasoning
  // This keeps "Composing" visible above the text while it streams
  const hasThinkingReasoning = Boolean(isThinking && reasoningText && reasoningText.length > 0);
  const hasStreamingReasoning = Boolean(
    isStreamingMessage &&
      reasoningPhase === "response" &&
      reasoningText &&
      reasoningText.length > 0,
  );
  const hasReasoning = hasThinkingReasoning || hasStreamingReasoning;

  // Typewriter effect for streaming messages
  // Reveals text at consistent speed (never jumps) - handles bursty input gracefully
  const displayText = useTypewriterText(message.content.text, isStreamingMessage, {
    onReveal: onTextReveal,
  });

  // Typewriter effect for reasoning/CoT text - active for thinking OR streaming with response phase
  const displayReasoningText = useReasoningTypewriter(
    reasoningText || "",
    hasReasoning,
    onTextReveal,
  );

  return (
    <div className={`flex ${message.isAgent ? "justify-start" : "justify-end"}`}>
      {message.isAgent ? (
        <div className="flex flex-col gap-0.5 max-w-[85%] sm:max-w-[75%] group/message">
          {/* Agent Name Row with Avatar */}
          <div className="flex items-center gap-2">
            <ElizaAvatar
              avatarUrl={characterAvatarUrl}
              name={characterName}
              className="flex-shrink-0 w-5 h-5"
              iconClassName="h-3 w-3"
              animate={isThinking}
            />
            <span className="text-sm font-medium text-white/50">{characterName}</span>
          </div>

          <div className="flex flex-col gap-0.5">
            {isThinking ? (
              <div className="py-2.5 px-3.5 bg-white/[0.02] border border-white/[0.05] rounded-lg backdrop-blur-sm">
                <style>{`
                  @keyframes reasoningFadeIn {
                    from {
                      opacity: 0;
                      transform: translateY(2px);
                    }
                    to {
                      opacity: 1;
                      transform: translateY(0);
                    }
                  }

                  @keyframes reasoningTextAppear {
                    from {
                      opacity: 0.3;
                    }
                    to {
                      opacity: 0.65;
                    }
                  }

                  @keyframes pulseGlow {
                    0%,
                    100% {
                      box-shadow: 0 0 0 0 rgba(255, 88, 0, 0);
                      border-color: rgba(255, 88, 0, 0.15);
                    }
                    50% {
                      box-shadow: 0 0 8px 2px rgba(255, 88, 0, 0.1);
                      border-color: rgba(255, 88, 0, 0.25);
                    }
                  }

                  @keyframes dotPulse {
                    0%,
                    80%,
                    100% {
                      transform: scale(0.8);
                      opacity: 0.4;
                    }
                    40% {
                      transform: scale(1);
                      opacity: 1;
                    }
                  }

                  .reasoning-container {
                    animation: reasoningFadeIn 300ms ease-out forwards;
                  }

                  .reasoning-border {
                    animation: pulseGlow 2s ease-in-out infinite;
                  }

                  .reasoning-text {
                    animation: reasoningTextAppear 200ms ease-out forwards;
                    -webkit-font-smoothing: antialiased;
                  }

                  .thinking-dots span {
                    display: inline-block;
                    animation: dotPulse 1.4s ease-in-out infinite;
                  }
                  .thinking-dots span:nth-child(1) {
                    animation-delay: 0ms;
                  }
                  .thinking-dots span:nth-child(2) {
                    animation-delay: 200ms;
                  }
                  .thinking-dots span:nth-child(3) {
                    animation-delay: 400ms;
                  }
                `}</style>
                {hasReasoning ? (
                  // Show chain-of-thought reasoning with smooth animation
                  <div className="reasoning-container space-y-2.5">
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-[#FF5800]/70" />
                        <div className="absolute inset-0 h-3.5 w-3.5 animate-ping opacity-20 rounded-full bg-[#FF5800]" />
                      </div>
                      <span className="text-xs font-medium text-[#FF5800]/70 uppercase tracking-wider">
                        {reasoningPhase === "planning" && "Planning"}
                        {reasoningPhase === "actions" && "Executing"}
                        {reasoningPhase === "response" && "Composing"}
                        {!reasoningPhase && "Thinking"}
                      </span>
                    </div>
                    <div className="reasoning-text reasoning-border text-sm text-white/85 italic leading-relaxed border-l-2 border-[#FF5800]/30 pl-3 ml-1 py-0.5">
                      {displayReasoningText}
                      <span
                        className="streaming-cursor inline-block w-[2px] h-[0.9em] bg-[#FF5800]/50 ml-0.5 rounded-sm align-text-bottom"
                        style={{ verticalAlign: "text-bottom" }}
                      />
                    </div>
                  </div>
                ) : (
                  // Default thinking indicator with animated dots
                  <div className="flex items-center gap-2.5">
                    <Loader2 className="h-4 w-4 animate-spin text-white/50" />
                    <span className="text-sm text-white/50">
                      thinking
                      <span className="thinking-dots">
                        <span>.</span>
                        <span>.</span>
                        <span>.</span>
                      </span>
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <>
                {/* Response-phase reasoning shown above streaming text (Composing indicator) */}
                {hasStreamingReasoning && (
                  <div className="mb-2 py-2 px-3 bg-white/[0.02] border border-white/[0.05] rounded-lg">
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        <Loader2 className="h-3 w-3 animate-spin text-[#FF5800]/60" />
                      </div>
                      <span className="text-[10px] font-medium text-[#FF5800]/60 uppercase tracking-wider">
                        Composing
                      </span>
                    </div>
                    <div className="text-xs text-white/70 italic leading-relaxed border-l-2 border-[#FF5800]/20 pl-2 mt-1.5 line-clamp-2">
                      {displayReasoningText}
                    </div>
                  </div>
                )}
                {/* Message Text - Always show content immediately, upgrade to markdown when ready */}
                <div className="overflow-hidden">
                  {/* Streaming text animation styles - smooth typewriter effect */}
                  <style>{`
                    @keyframes streamTextFadeIn {
                      0% {
                        opacity: 0.4;
                        filter: blur(1px);
                      }
                      100% {
                        opacity: 1;
                        filter: blur(0);
                      }
                    }

                    @keyframes cursorBlink {
                      0%,
                      50% {
                        opacity: 1;
                      }
                      51%,
                      100% {
                        opacity: 0;
                      }
                    }

                    @keyframes cursorPulse {
                      0%,
                      100% {
                        opacity: 0.9;
                        transform: scaleY(1);
                      }
                      50% {
                        opacity: 0.5;
                        transform: scaleY(0.85);
                      }
                    }

                    .streaming-text-wrapper {
                      /* Smooth text rendering for animation */
                      -webkit-font-smoothing: antialiased;
                      -moz-osx-font-smoothing: grayscale;
                      text-rendering: optimizeLegibility;
                    }

                    .streaming-text-content {
                      animation: streamTextFadeIn 200ms ease-out forwards;
                    }

                    /* Smooth transitions for text changes */
                    .streaming-text-content p,
                    .streaming-text-content span,
                    .streaming-text-content div {
                      transition: opacity 150ms ease-out;
                    }

                    .streaming-cursor {
                      animation: cursorPulse 800ms ease-in-out infinite;
                      will-change: opacity, transform;
                    }

                    /* Non-streaming messages - subtle entrance */
                    .message-text-complete {
                      animation: streamTextFadeIn 300ms ease-out forwards;
                    }
                  `}</style>
                  <div
                    className={`streaming-text-wrapper text-[15px] leading-relaxed text-white/90 prose prose-invert prose-sm max-w-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-headings:my-3 prose-pre:my-2 break-words [&_pre]:overflow-x-auto [&_pre_code]:whitespace-pre-wrap [&_pre_code]:break-words ${isStreamingMessage ? "streaming-text-content" : "message-text-complete"}`}
                  >
                    {plugins && ReactMarkdown ? (
                      <ReactMarkdown
                        remarkPlugins={[plugins.remarkGfm]}
                        rehypePlugins={[plugins.rehypeHighlight]}
                        components={markdownComponents}
                      >
                        {normalizeMarkdownLists(
                          isStreamingMessage ? displayText : message.content.text,
                        )}
                      </ReactMarkdown>
                    ) : (
                      // Plain text fallback - shown immediately while markdown loads
                      // Uses same styling to prevent layout shift
                      <div className="whitespace-pre-wrap">
                        {normalizeMarkdownLists(
                          isStreamingMessage ? displayText : message.content.text,
                        )}
                      </div>
                    )}
                    {/* Elegant blinking cursor for streaming messages */}
                    {isStreamingMessage && (
                      <span
                        className="streaming-cursor inline-block w-[3px] h-[1.1em] bg-gradient-to-b from-[#FF5800] to-[#FF5800]/60 ml-0.5 rounded-sm align-text-bottom"
                        style={{
                          verticalAlign: "text-bottom",
                          marginBottom: "2px",
                        }}
                      />
                    )}
                  </div>
                </div>

                {/* Image Attachments */}
                {message.content.attachments && message.content.attachments.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {message.content.attachments.map((attachment) => {
                      if (attachment.contentType === ContentType.IMAGE) {
                        return (
                          <div
                            key={attachment.id}
                            className="inline-block rounded-lg overflow-hidden border border-white/10 max-w-md"
                          >
                            <Image
                              src={attachment.url}
                              alt={attachment.title || "Generated image"}
                              width={512}
                              height={512}
                              className="w-full h-auto"
                              style={{ display: "block" }}
                              onLoad={onImageLoad}
                            />
                          </div>
                        );
                      }
                      return null;
                    })}
                  </div>
                )}

                {/* Time and Actions - hide during streaming */}
                {!isStreamingMessage && (
                  <div className="flex items-center gap-2 opacity-0 group-hover/message:opacity-100 transition-opacity">
                    <span className="text-xs text-white/40">
                      {formatTimestamp(message.createdAt)}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 hover:bg-white/10 rounded transition-colors"
                      onClick={() =>
                        onCopy(message.content.text, message.id, message.content.attachments)
                      }
                      title="Copy message"
                    >
                      {copiedMessageId === message.id ? (
                        <Check className="h-3.5 w-3.5 text-green-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5 text-white/50 hover:text-white/80" />
                      )}
                    </Button>
                    {hasAudioUrl && onPlayAudio && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 hover:bg-white/10 rounded transition-colors"
                        onClick={() => onPlayAudio(message.id)}
                      >
                        {currentPlayingId === message.id && isPlaying ? (
                          <Square className="h-3.5 w-3.5 text-white/50" />
                        ) : (
                          <Volume2 className="h-3.5 w-3.5 text-white/50 hover:text-white/80" />
                        )}
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col max-w-[85%] sm:max-w-[75%] group/message items-end">
          {/* User Message */}
          <div className="py-2 px-3 bg-[#FF5800]/10 border border-[#FF5800]/20 rounded-lg transition-colors hover:bg-[#FF5800]/15 hover:border-[#FF5800]/30 w-fit ml-auto">
            <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-white/95 text-left">
              {message.content.text}
            </div>
          </div>
          {/* Time and Actions */}
          <div className="flex items-center gap-2 justify-end opacity-0 group-hover/message:opacity-100 transition-opacity">
            <span className="text-xs text-white/40">{formatTimestamp(message.createdAt)}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 hover:bg-white/10 rounded transition-colors"
              onClick={() => onCopy(message.content.text, message.id, message.content.attachments)}
              title="Copy message"
            >
              {copiedMessageId === message.id ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Copy className="h-3.5 w-3.5 text-white/50 hover:text-white/80" />
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// Memoize with custom comparison function
export const MemoizedChatMessage = memo(ChatMessageComponent, (prevProps, nextProps) => {
  // Compare relevant props - streaming messages use streaming- prefix
  return (
    prevProps.message.id === nextProps.message.id &&
    prevProps.message.content.text === nextProps.message.content.text &&
    prevProps.copiedMessageId === nextProps.copiedMessageId &&
    prevProps.currentPlayingId === nextProps.currentPlayingId &&
    prevProps.isPlaying === nextProps.isPlaying &&
    prevProps.hasAudioUrl === nextProps.hasAudioUrl &&
    prevProps.isStreaming === nextProps.isStreaming &&
    prevProps.reasoningText === nextProps.reasoningText &&
    prevProps.reasoningPhase === nextProps.reasoningPhase
  );
});
