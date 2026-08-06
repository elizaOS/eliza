"use client";

import { useRef, useEffect, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Message } from "@/lib/types";
import { MessageBubble } from "./MessageBubble";

/**
 * Estimated heights used for initial layout. The virtualizer measures actual
 * heights after render and updates scroll positions accordingly.
 */
const ESTIMATED_HEIGHT = {
  short: 80,   // typical user message
  medium: 160, // short assistant reply
  tall: 320,   // code blocks / long replies
};

function estimateMessageHeight(message: Message): number {
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");

  if (text.length < 100) return ESTIMATED_HEIGHT.short;
  if (text.length < 500 || text.includes("```")) return ESTIMATED_HEIGHT.medium;
  return ESTIMATED_HEIGHT.tall;
}

interface VirtualMessageListProps {
  messages: Message[];
  /** Whether streaming is in progress — suppresses smooth-scroll so the
   *  autoscroll keeps up with incoming tokens. */
  isStreaming: boolean;
}

export function VirtualMessageList({ messages, isStreaming }: VirtualMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateMessageHeight(messages[index]),
    overscan: 5,
  });

  // Track whether the user has scrolled away from the bottom
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distanceFromBottom < 80;
  }, []);

  // Auto-scroll to bottom when new messages arrive (if already at bottom)
  useEffect(() => {
    if (!isAtBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    if (isStreaming) {
      // Instant scroll during streaming to keep up with tokens
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages.length, isStreaming]);

  // Also scroll when the last streaming message content changes
  useEffect(() => {
    if (!isStreaming || !isAtBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto"
      onScroll={handleScroll}
    >
      {/* Spacer that gives the virtualizer its total height */}
      <div
        style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        className="max-w-3xl mx-auto px-4 py-6"
      >
        {items.map((virtualItem) => {
          const message = messages[virtualItem.index];
          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${virtualItem.start}px)`,
              }}
              className="pb-6"
            >
              <MessageBubble message={message} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
