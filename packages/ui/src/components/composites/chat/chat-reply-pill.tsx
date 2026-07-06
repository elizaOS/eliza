/**
 * The "Replying to …" pill shown above the composer while a reply target is
 * armed. Two chromes match the two composer chromes: `panel` (ChatView / detached
 * windows) uses theme tokens; `glass` (the continuous overlay) uses the dark
 * floating treatment. Presentation only — the surface owns the reply-target state
 * and passes the cancel handler; the id it references is what stamps
 * `replyToMessageId` on the next turn (→ REPLY_CONTEXT).
 */
import { Reply, X } from "lucide-react";

import { cn } from "../../../lib/utils";
import type { ChatReplyTarget } from "../../../state/ChatComposerContext.hooks";
import { Button } from "../../ui/button";

export interface ChatReplyPillProps {
  target: ChatReplyTarget;
  onCancel: () => void;
  appearance?: "panel" | "glass";
  /** Localized "Replying to" verb + cancel aria-label. */
  labels?: { replyingTo?: string; cancelReply?: string };
}

export function ChatReplyPill({
  target,
  onCancel,
  appearance = "panel",
  labels = {},
}: ChatReplyPillProps) {
  const replyingTo = labels.replyingTo ?? "Replying to";
  const cancelReply = labels.cancelReply ?? "Cancel reply";
  const glass = appearance === "glass";

  return (
    <div
      data-testid="chat-reply-pill"
      className={cn(
        "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs",
        glass
          ? "bg-white/10 text-white/85"
          : "border border-border bg-bg-accent text-txt",
      )}
    >
      <Reply
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          glass ? "text-white/70" : "text-accent",
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold">
          {replyingTo} {target.senderName}
        </span>
        {target.snippet ? (
          <span
            className={cn("ml-1.5", glass ? "text-white/60" : "text-muted")}
          >
            {target.snippet}
          </span>
        ) : null}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="chat-reply-pill-cancel"
        aria-label={cancelReply}
        title={cancelReply}
        onClick={onCancel}
        className={cn(
          "h-6 w-6 shrink-0 rounded-full p-0 transition-colors",
          glass
            ? "bg-white/10 text-white/70 hover:bg-white/20"
            : "text-muted hover:bg-bg hover:text-txt-strong",
        )}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}
