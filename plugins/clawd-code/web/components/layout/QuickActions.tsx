"use client";

import { Plus, Send } from "lucide-react";
import { useChatStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Sidebar footer actions: new conversation + jump to Telegram relay setup. */
export function QuickActions() {
  const { createConversation, openSettings } = useChatStore();

  return (
    <div className="flex-shrink-0 flex items-center gap-1 px-2 py-2 border-t border-surface-800">
      <button
        onClick={() => createConversation()}
        className={cn(
          "flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors",
          "text-surface-300 hover:text-surface-100 hover:bg-surface-800"
        )}
      >
        <Plus className="w-3.5 h-3.5" />
        New chat
      </button>
      <button
        onClick={openSettings}
        title="Configure Telegram relay"
        aria-label="Configure Telegram relay"
        className="p-1.5 rounded-md text-surface-400 hover:text-surface-100 hover:bg-surface-800 transition-colors"
      >
        <Send className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
