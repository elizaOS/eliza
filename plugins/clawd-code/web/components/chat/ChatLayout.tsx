"use client";

import { useEffect } from "react";
import { useChatStore } from "@/lib/store";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { ChatWindow } from "./ChatWindow";
import { ChatInput } from "./ChatInput";
import { SkipToContent } from "@/components/a11y/SkipToContent";
import { AnnouncerProvider } from "@/components/a11y/Announcer";
import { SettingsModal } from "@/components/settings/SettingsModal";

export function ChatLayout() {
  const { conversations, createConversation, activeConversationId } = useChatStore();

  useEffect(() => {
    if (conversations.length === 0) {
      createConversation();
    }
  }, []);

  return (
    <AnnouncerProvider>
      <SkipToContent />
      <div className="flex h-screen bg-surface-950 text-surface-100">
        <Sidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <Header />
          <main
            id="main-content"
            aria-label="Chat"
            className="flex flex-col flex-1 min-h-0"
          >
            {activeConversationId ? (
              <>
                <ChatWindow conversationId={activeConversationId} />
                <ChatInput conversationId={activeConversationId} />
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-surface-500">
                Select or create a conversation
              </div>
            )}
          </main>
        </div>
      </div>
      <SettingsModal />
    </AnnouncerProvider>
  );
}
