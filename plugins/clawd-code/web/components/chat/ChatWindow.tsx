"use client";

import { useEffect, useRef, useState } from "react";
import { useChatStore } from "@/lib/store";
import { MessageBubble } from "./MessageBubble";
import { Bot } from "lucide-react";

interface ChatWindowProps {
  conversationId: string;
}

export function ChatWindow({ conversationId }: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const { conversations } = useChatStore();
  const conversation = conversations.find((c) => c.id === conversationId);
  const messages = conversation?.messages ?? [];

  const isStreaming = messages.some((m) => m.status === "streaming");

  // Announce the last completed assistant message to screen readers
  const [announcement, setAnnouncement] = useState("");
  const prevLengthRef = useRef(messages.length);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });

    const lastMsg = messages[messages.length - 1];
    if (
      messages.length > prevLengthRef.current &&
      lastMsg?.role === "assistant" &&
      lastMsg.status === "complete"
    ) {
      // Announce a short preview so screen reader users know a reply arrived
      const preview = lastMsg.content.slice(0, 100);
      setAnnouncement("");
      setTimeout(() => setAnnouncement(`Claude replied: ${preview}`), 50);
    }
    prevLengthRef.current = messages.length;
  }, [messages.length, messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-6">
        <div
          className="w-12 h-12 rounded-full bg-brand-600/20 flex items-center justify-center"
          aria-hidden="true"
        >
          <Bot className="w-6 h-6 text-brand-400" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-surface-100">How can I help?</h2>
          <p className="text-sm text-surface-400 mt-1">
            Start a conversation with Claude Code
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex-1 overflow-y-auto"
      aria-busy={isStreaming}
      aria-label="Conversation"
    >
      {/* Polite live region — announces when Claude finishes a reply */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: "1px",
          height: "1px",
          padding: 0,
          margin: "-1px",
          overflow: "hidden",
          clip: "rect(0,0,0,0)",
          whiteSpace: "nowrap",
          borderWidth: 0,
        }}
      >
        {announcement}
      </div>

      <div className="max-w-3xl mx-auto py-6 px-4 space-y-6">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        <div ref={bottomRef} aria-hidden="true" />
      </div>
    </div>
  );
}
