import type * as React from "react";

import { cn } from "../../../lib/utils";
import { normalizeChatSourceKey } from "./chat-source";

export type ChatBubbleTone = "assistant" | "user";

export interface ChatBubbleProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: ChatBubbleTone;
  /**
   * Source channel the message came from (e.g. "imessage", "telegram",
   * "discord", "whatsapp"). When set, the bubble renders a connector-
   * colored outline so cross-channel messages stay visually distinct
   * without adding a repeated text badge above every message.
   */
  source?: string;
}

export function ChatBubble({
  tone = "assistant",
  source,
  className,
  ...props
}: ChatBubbleProps) {
  const normalizedSource = normalizeChatSourceKey(source) ?? undefined;
  return (
    <div
      className={cn(
        "relative whitespace-pre-wrap break-words",
        tone === "user" ? "text-txt-strong" : "text-txt",
        className,
      )}
      data-chat-source={normalizedSource ?? undefined}
      {...props}
    />
  );
}
