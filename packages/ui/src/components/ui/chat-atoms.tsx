/**
 * Chat sub-components that have no app-level context dependency.
 *
 * These complement the full `ChatMessage` component (which stays in
 * `apps/app` because it uses `useApp()` for i18n and the `MessageContent`
 * renderer). Extracted here so they can be reused by any app.
 */

import { Button } from "./button";

/* ── TypingIndicator ─────────────────────────────────────────────────── */

export function TypingIndicator({
  agentName,
  agentAvatarSrc,
}: {
  agentName: string;
  agentAvatarSrc?: string | null;
}) {
  const agentInitial = agentName.trim().charAt(0).toUpperCase() || "A";

  return (
    <div className="flex items-start gap-2 sm:gap-3 mt-4">
      <div className="w-8 h-8 shrink-0 rounded-full overflow-hidden border border-border bg-bg-hover shadow-sm">
        {agentAvatarSrc ? (
          <img
            src={agentAvatarSrc}
            alt={`${agentName} avatar`}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[11px] font-bold text-accent bg-accent-subtle">
            {agentInitial}
          </div>
        )}
      </div>

      <div className="max-w-[88%] sm:max-w-[80%] min-w-0">
        <div className="text-[12px] font-semibold text-accent mb-1">
          {agentName}
        </div>
        <div className="px-4 py-3 bg-bg-accent border border-border rounded-2xl rounded-bl-md">
          <div className="flex gap-1">
            <span
              className="w-2 h-2 rounded-full bg-muted-strong animate-[typing-bounce_1.2s_ease-in-out_infinite]"
              style={{ animationDelay: "0ms" }}
            />
            <span
              className="w-2 h-2 rounded-full bg-muted-strong animate-[typing-bounce_1.2s_ease-in-out_infinite]"
              style={{ animationDelay: "200ms" }}
            />
            <span
              className="w-2 h-2 rounded-full bg-muted-strong animate-[typing-bounce_1.2s_ease-in-out_infinite]"
              style={{ animationDelay: "400ms" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── ChatEmptyState ──────────────────────────────────────────────────── */

export interface ChatEmptyStateProps {
  agentName: string;
  /** Starter suggestions shown as quick-reply chips. */
  suggestions?: string[];
  onSuggestionClick?: (suggestion: string) => void;
  /** i18n labels — all have sensible English defaults. */
  labels?: {
    startConversation?: string;
    sendMessageTo?: string;
    toBeginChatting?: string;
    chatIconLabel?: string;
  };
}

export function ChatEmptyState({
  agentName,
  suggestions = ["Hello!", "How are you?", "Tell me a joke", "Help me with..."],
  onSuggestionClick,
  labels = {},
}: ChatEmptyStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
      <div className="w-16 h-16 rounded-2xl bg-accent-subtle flex items-center justify-center mb-4">
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-accent"
          aria-label={labels.chatIconLabel ?? "Chat icon"}
        >
          <title>{labels.chatIconLabel ?? "Chat"}</title>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <h3 className="text-lg font-semibold text-txt-strong mb-2">
        {labels.startConversation ?? "Start a Conversation"}
      </h3>
      <p
        className="text-sm text-muted max-w-sm mb-6"
        style={{ fontFamily: "var(--font-chat)" }}
      >
        {labels.sendMessageTo ?? "Send a message to"} {agentName}{" "}
        {labels.toBeginChatting ?? "to begin chatting."}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {suggestions.map((suggestion) => (
          <Button
            key={suggestion}
            variant="outline"
            size="sm"
            className="px-3 py-1.5 h-7 text-xs rounded-full text-muted border-border bg-bg hover:border-accent hover:text-accent transition-colors"
            onClick={() => onSuggestionClick?.(suggestion)}
          >
            {suggestion}
          </Button>
        ))}
      </div>
    </div>
  );
}
