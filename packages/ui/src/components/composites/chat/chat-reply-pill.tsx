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
import { Card } from "../../ui/card";

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
    <Card
      surface={glass ? "transparent" : "raised"}
      border={glass ? "none" : "standard"}
      padding="compact"
      tone={glass ? undefined : "text"}
      flow="row"
      gap="compact"
      wallpaperText={glass}
      data-testid="chat-reply-pill"
    >
      <Reply
        className={cn(
          "size-3.5 shrink-0",
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
        variant={glass ? "outlineAccent" : "ghostMuted"}
        size="micro"
        data-testid="chat-reply-pill-cancel"
        aria-label={cancelReply}
        title={cancelReply}
        onClick={onCancel}
      >
        <X className="size-3.5" aria-hidden="true" />
      </Button>
    </Card>
  );
}
