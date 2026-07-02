/**
 * Memoized chat message component for performance optimization.
 * Prevents re-renders of messages that haven't changed.
 */

"use client";

import { Check, Copy, Loader2, Square, Volume2 } from "lucide-react";
import { lazy, memo, type ReactNode, Suspense, useEffect } from "react";
import { Button } from "../../../components/ui/button";
import Image from "../../runtime/image";
import { type ChatMediaAttachment, ContentType } from "../../types/chat-media";
import { ElizaAvatar } from "./eliza-avatar";
import {
  useReasoningTypewriter,
  useTypewriterText,
} from "./hooks/use-typewriter-text";

/**
 * Plain-text fallback used when the lazy `streamdown` chunk fails to load
 * (#11351). Renders the raw markdown source as pre-wrapped text so a stale
 * deploy or offline/transient chunk-load rejection degrades to the same
 * unstyled text the Suspense pending fallback shows — never a thrown error that
 * blanks the message.
 */
function StreamdownTextFallback({ children }: { children?: ReactNode }) {
  return <span className="whitespace-pre-wrap">{children}</span>;
}

/**
 * Lazily load the markdown/shiki/katex render stack (#11351). The `streamdown`
 * dependency (~372 KB) previously sat on the eager boot graph via a top-level
 * import even though it only renders once the first rich message appears. A
 * `React.lazy` boundary defers the whole stack until a message body actually
 * renders; the Suspense fallback below shows the raw message text immediately,
 * preserving the existing "show content now, upgrade to markdown when ready"
 * behavior. `streamdown` is ESM-only with a named `Streamdown` export, so it is
 * normalized to the `default` shape `lazy()` expects. A `.catch` resolves the
 * import to the plain-text fallback instead of rejecting, so a chunk-load
 * failure never throws out of `Suspense` and blanks the chat message.
 */
const Streamdown = lazy(() =>
  import("streamdown")
    .then((m) => ({ default: m.Streamdown }))
    .catch(() => ({
      // Cast keeps the two `lazy()` resolution branches assignable: on
      // chunk-load failure we render the raw-text fallback in place of the
      // real component, which only ever receives `children` here.
      default:
        StreamdownTextFallback as unknown as typeof import("streamdown").Streamdown,
    })),
);

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

// Static keyframe/class definitions shared by every chat message. These were
// previously rendered as an inline <style> inside each message, duplicating the
// same CSS once per message in a conversation. They are fully static, so we
// inject each stylesheet into the document head exactly once.
const REASONING_ANIMATION_CSS = `
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
`;

const STREAMING_ANIMATION_CSS = `
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
`;

function ensureStyleInjected(id: string, css: string): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}

function useChatMessageAnimationStyles(): void {
  useEffect(() => {
    ensureStyleInjected(
      "eliza-chat-reasoning-animations",
      REASONING_ANIMATION_CSS,
    );
    ensureStyleInjected(
      "eliza-chat-streaming-animations",
      STREAMING_ANIMATION_CSS,
    );
  }, []);
}

export interface MemoizedChatMessageMessage {
  id: string;
  content: {
    text: string;
    clientMessageId?: string;
    attachments?: ChatMediaAttachment[];
  };
  isAgent: boolean;
  createdAt: number;
}

export interface MemoizedChatMessageProps {
  message: MemoizedChatMessageMessage;
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
    attachments?: MemoizedChatMessageMessage["content"]["attachments"],
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

function getAttachmentSignature(
  attachments: ChatMediaAttachment[] | undefined,
): string {
  return (
    attachments
      ?.map((attachment) =>
        [
          attachment.id,
          attachment.url,
          attachment.contentType,
          attachment.title,
          attachment.description,
          attachment.source,
          attachment.text,
        ].join("\u0000"),
      )
      .join("\u0001") ?? ""
  );
}

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

  useChatMessageAnimationStyles();

  // Detect streaming from message id if not explicitly passed
  const isStreamingMessage = isStreaming || message.id.startsWith("streaming-");

  // Show reasoning for thinking messages OR streaming messages with "response" phase reasoning
  // This keeps "Composing" visible above the text while it streams
  const hasThinkingReasoning = Boolean(
    isThinking && reasoningText && reasoningText.length > 0,
  );
  const hasStreamingReasoning = Boolean(
    isStreamingMessage &&
      reasoningPhase === "response" &&
      reasoningText &&
      reasoningText.length > 0,
  );
  const hasReasoning = hasThinkingReasoning || hasStreamingReasoning;

  // Typewriter effect for streaming messages
  // Reveals text at consistent speed (never jumps) - handles bursty input gracefully
  const displayText = useTypewriterText(
    message.content.text,
    isStreamingMessage,
    {
      onReveal: onTextReveal,
    },
  );

  // Typewriter effect for reasoning/CoT text - active for thinking OR streaming with response phase
  const displayReasoningText = useReasoningTypewriter(
    reasoningText || "",
    hasReasoning,
    onTextReveal,
  );

  return (
    <div
      className={`flex ${message.isAgent ? "justify-start" : "justify-end"}`}
    >
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
            <span className="text-sm font-medium text-white/50">
              {characterName}
            </span>
          </div>

          <div className="flex flex-col gap-0.5">
            {isThinking ? (
              <div className="py-2.5 px-3.5 bg-white/[0.02] border border-white/[0.05] rounded-sm">
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
                  <div className="mb-2 py-2 px-3 bg-white/[0.02] border border-white/[0.05] rounded-sm">
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
                  <div
                    className={`streaming-text-wrapper text-[15px] leading-relaxed text-white/90 prose prose-invert prose-sm max-w-none prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-headings:my-3 prose-pre:my-2 break-words [&_pre]:overflow-x-auto [&_pre_code]:whitespace-pre-wrap [&_pre_code]:break-words ${isStreamingMessage ? "streaming-text-content" : "message-text-complete"}`}
                  >
                    <Suspense
                      fallback={
                        <span className="whitespace-pre-wrap">
                          {isStreamingMessage
                            ? displayText
                            : message.content.text}
                        </span>
                      }
                    >
                      <Streamdown>
                        {normalizeMarkdownLists(
                          isStreamingMessage
                            ? displayText
                            : message.content.text,
                        )}
                      </Streamdown>
                    </Suspense>
                    {/* Elegant blinking cursor for streaming messages */}
                    {isStreamingMessage && (
                      <span
                        className="streaming-cursor inline-block w-[3px] h-[1.1em] bg-[#FF5800] ml-0.5 rounded-sm align-text-bottom"
                        style={{
                          verticalAlign: "text-bottom",
                          marginBottom: "2px",
                        }}
                      />
                    )}
                  </div>
                </div>

                {/* Image Attachments */}
                {message.content.attachments &&
                  message.content.attachments.length > 0 && (
                    <div className="mt-2 space-y-2">
                      {message.content.attachments.map((attachment) => {
                        if (attachment.contentType === ContentType.IMAGE) {
                          return (
                            <div
                              key={attachment.id}
                              className="inline-block rounded-sm overflow-hidden border border-white/10 max-w-md"
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
                      className="h-6 w-6 p-0 hover:bg-white/10 rounded-sm transition-colors"
                      onClick={() =>
                        onCopy(
                          message.content.text,
                          message.id,
                          message.content.attachments,
                        )
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
                        className="h-6 w-6 p-0 hover:bg-white/10 rounded-sm transition-colors"
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
          <div className="py-2 px-3 bg-[#FF5800]/10 border border-[#FF5800]/20 rounded-sm transition-colors hover:bg-[#FF5800]/15 hover:border-[#FF5800]/30 w-fit ml-auto">
            <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-white/95 text-left">
              {message.content.text}
            </div>
          </div>
          {/* Time and Actions */}
          <div className="flex items-center gap-2 justify-end opacity-0 group-hover/message:opacity-100 transition-opacity">
            <span className="text-xs text-white/40">
              {formatTimestamp(message.createdAt)}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 hover:bg-white/10 rounded-sm transition-colors"
              onClick={() =>
                onCopy(
                  message.content.text,
                  message.id,
                  message.content.attachments,
                )
              }
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
export const MemoizedChatMessage = memo(
  ChatMessageComponent,
  (prevProps, nextProps) => {
    // Compare relevant props - streaming messages use streaming- prefix
    return (
      prevProps.message.id === nextProps.message.id &&
      prevProps.message.content.text === nextProps.message.content.text &&
      getAttachmentSignature(prevProps.message.content.attachments) ===
        getAttachmentSignature(nextProps.message.content.attachments) &&
      prevProps.characterName === nextProps.characterName &&
      prevProps.characterAvatarUrl === nextProps.characterAvatarUrl &&
      prevProps.copiedMessageId === nextProps.copiedMessageId &&
      prevProps.currentPlayingId === nextProps.currentPlayingId &&
      prevProps.isPlaying === nextProps.isPlaying &&
      prevProps.hasAudioUrl === nextProps.hasAudioUrl &&
      prevProps.isStreaming === nextProps.isStreaming &&
      prevProps.reasoningText === nextProps.reasoningText &&
      prevProps.reasoningPhase === nextProps.reasoningPhase
    );
  },
);
