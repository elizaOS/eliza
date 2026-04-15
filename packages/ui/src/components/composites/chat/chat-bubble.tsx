import type * as React from "react";

import { cn } from "../../../lib/utils";
import { getChatSourceMeta, normalizeChatSourceKey } from "./chat-source";

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
  const sourceBorderClass = normalizedSource
    ? getChatSourceMeta(normalizedSource).borderClassName
    : null;
  return (
    <div
      className={cn(
        "relative border whitespace-pre-wrap break-words",
        tone === "user"
          ? "border border-accent/24 bg-[linear-gradient(180deg,rgba(var(--accent-rgb),0.14),rgba(var(--accent-rgb),0.05))] text-txt-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_18px_26px_-24px_rgba(var(--accent-rgb),0.18)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_20px_28px_-24px_rgba(0,0,0,0.22)]"
          : "border border-border/32 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_96%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_18px_26px_-24px_rgba(15,23,42,0.1)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_20px_28px_-24px_rgba(0,0,0,0.22)]",
        sourceBorderClass ? `border-2 ${sourceBorderClass}` : null,
        className,
      )}
      data-chat-source={normalizedSource ?? undefined}
      {...props}
    />
  );
}
