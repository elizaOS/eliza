import { ChatBubble } from "./chat-bubble";
import type { ChatVariant } from "./chat-types";

export interface TypingIndicatorProps {
  agentAvatarSrc?: string | null;
  agentName: string;
  className?: string;
  dotClassName?: string;
  variant?: ChatVariant;
}

export function TypingIndicator({
  agentAvatarSrc,
  agentName,
  className,
  dotClassName,
  variant = "default",
}: TypingIndicatorProps) {
  if (variant === "game-modal") {
    return (
      <div className={className ?? "flex w-full justify-start"}>
        <ChatBubble
          tone="assistant"
          className="flex max-w-[min(85%,24rem)] items-center gap-1 rounded-2xl rounded-bl-sm px-4 py-3 backdrop-blur-md"
        >
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className={
                dotClassName ??
                "h-1.5 w-1.5 rounded-full bg-[color:color-mix(in_srgb,var(--muted)_82%,transparent)] animate-bounce"
              }
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </ChatBubble>
      </div>
    );
  }

  const agentInitial = agentName.trim().charAt(0).toUpperCase() || "A";

  return (
    <div className={className ?? "mt-4 flex items-start gap-2 sm:gap-3"}>
      <div className="h-8 w-8 shrink-0 overflow-hidden rounded-full border border-border bg-bg-hover shadow-sm">
        {agentAvatarSrc ? (
          <img
            src={agentAvatarSrc}
            alt={`${agentName} avatar`}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-accent-subtle text-xs-tight font-bold text-accent">
            {agentInitial}
          </div>
        )}
      </div>

      <div className="min-w-0 max-w-[88%] sm:max-w-[80%]">
        <div className="mb-1 text-xs font-semibold text-accent">
          {agentName}
        </div>
        <div className="rounded-2xl rounded-bl-md border border-border bg-bg-accent px-4 py-3">
          <div className="flex gap-1">
            {[0, 200, 400].map((delay) => (
              <span
                key={delay}
                className={
                  dotClassName ??
                  "h-2 w-2 rounded-full bg-muted-strong animate-[typing-bounce_1.2s_ease-in-out_infinite]"
                }
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
