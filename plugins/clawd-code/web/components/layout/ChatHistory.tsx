"use client";

import { MessageSquare } from "lucide-react";
import { useChatStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Minimal conversation list — placeholder for the full search/tag/pin UI. */
export function ChatHistory() {
  const { conversations, activeConversationId, setActiveConversation } = useChatStore();

  if (conversations.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-surface-500 px-4 text-center">
        No conversations yet
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
      {conversations.map((c) => (
        <button
          key={c.id}
          onClick={() => setActiveConversation(c.id)}
          className={cn(
            "w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left text-xs transition-colors",
            c.id === activeConversationId
              ? "bg-surface-800 text-surface-100"
              : "text-surface-400 hover:text-surface-200 hover:bg-surface-800/50"
          )}
        >
          <MessageSquare className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate">{c.title}</span>
        </button>
      ))}
    </div>
  );
}
