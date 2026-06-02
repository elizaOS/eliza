// odysseus main column (static/index.html main.chat-container): top bar, the
// message log (or the welcome screen when empty), and the composer.

import { Eye } from "lucide-react";
import type { ReactNode } from "react";
import type { ConversationBlock } from "../orchestrator-stream";
import { ChatMessages } from "./ChatMessages";
import { ChatTopBar } from "./ChatTopBar";
import { Composer } from "./Composer";

export function ChatContainer({
  title,
  conversation,
  locale,
  input,
  onInput,
  onSubmit,
  onStop,
  sending,
  isActive,
  modelLabel,
  onNewChat,
  onSearch,
  onOpenPanel,
  onOpenModels,
}: {
  title: string;
  conversation: ConversationBlock[];
  locale?: string;
  input: string;
  onInput: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  sending: boolean;
  isActive: boolean;
  modelLabel: string;
  onNewChat: () => void;
  onSearch: () => void;
  onOpenPanel: (
    panel: "theme" | "memory" | "skills" | "notes" | "settings",
  ) => void;
  onOpenModels?: () => void;
}): ReactNode {
  return (
    <main className="od-chat-container" aria-label="Chat area">
      <ChatTopBar title={title} />
      {conversation.length === 0 ? (
        <div className="od-welcome">
          <div className="od-welcome-title">
            <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
              <path d="M16 4L16 22L6 22Z" fill="currentColor" />
              <path d="M16 8L16 22L24 22Z" fill="currentColor" opacity="0.6" />
              <path
                d="M4 24Q10 20 16 24Q22 28 28 24"
                stroke="currentColor"
                strokeWidth="2.5"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
            Orchestrator
          </div>
          <div className="od-welcome-sub">
            Message the orchestrator to start a task.
          </div>
          <p className="od-welcome-hint">
            Describe the work and the orchestrator will plan it, spin up coding
            agents, and report back here.
          </p>
          <div className="od-welcome-presence">
            <Eye size={12} aria-hidden="true" />
            <span>Nobody</span>
          </div>
        </div>
      ) : (
        <ChatMessages conversation={conversation} locale={locale} />
      )}
      <Composer
        input={input}
        onInput={onInput}
        onSubmit={onSubmit}
        onStop={onStop}
        sending={sending}
        isActive={isActive}
        modelLabel={modelLabel}
        onNewChat={onNewChat}
        onSearch={onSearch}
        onOpenPanel={onOpenPanel}
        onOpenModels={onOpenModels}
      />
    </main>
  );
}
