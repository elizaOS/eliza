"use client";

import { cn } from "@feed/shared";
import { X } from "lucide-react";
import type { ReplyToMessage } from "./types";

interface ReplyPreviewProps {
  replyToMessage: ReplyToMessage;
  onDismiss: () => void;
  density?: "default" | "compact";
}

/**
 * Reply preview banner displayed above the message input when replying to a message.
 * Shows the sender name and a truncated preview of the message content.
 * Telegram-style left accent bar.
 */
export function ReplyPreview({
  replyToMessage,
  onDismiss,
  density = "default",
}: ReplyPreviewProps) {
  const compact = density === "compact";
  const truncatedContent =
    replyToMessage.content.length > 120
      ? `${replyToMessage.content.slice(0, 120)}...`
      : replyToMessage.content;

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border-primary/50 border-l-2 bg-muted/50",
        compact ? "mb-2 px-2.5 py-1.5" : "mb-2 px-3 py-2",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium text-primary text-xs">
          Replying to {replyToMessage.senderName || "Unknown"}
        </p>
        <p className="truncate text-muted-foreground text-xs">
          {truncatedContent}
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Cancel reply"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
