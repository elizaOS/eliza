/**
 * Message bubble surface for a single chat line, toned for assistant vs user.
 * When a connector `source` is set it draws a source-colored outline so
 * cross-channel messages stay visually distinct without a repeated text badge.
 */
import type * as React from "react";

import { cn } from "../../../lib/utils";
import {
  getChatSourceMeta,
  normalizeChatSourceKey,
} from "./chat-source.helpers";

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
  const sourceBorderClassName = normalizedSource
    ? getChatSourceMeta(normalizedSource).borderClassName
    : "border-transparent";

  return (
    <div
      className={cn(
        "relative inline-block max-w-full whitespace-pre-wrap break-words rounded-sm border px-3 py-2",
        tone === "user"
          ? "bg-[color:color-mix(in_srgb,var(--accent-subtle)_70%,var(--bg)_30%)] text-txt-strong"
          : "bg-[color:color-mix(in_srgb,var(--card)_82%,var(--text)_12%)] text-txt",
        sourceBorderClassName,
        className,
      )}
      data-chat-source={normalizedSource ?? undefined}
      {...props}
    />
  );
}
