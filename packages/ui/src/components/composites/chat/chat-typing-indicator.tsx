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

  return (
    <div className={className ?? "mt-1.5 flex min-w-0 flex-col"}>
      <div className="mb-0.5 text-xs font-semibold text-accent">
        {agentName}
      </div>
      <div className="flex gap-1 py-1">
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
  );
}
