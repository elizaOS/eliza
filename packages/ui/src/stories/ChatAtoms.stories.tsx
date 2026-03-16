import type { Meta, StoryObj } from "@storybook/react";
import React, { useState } from "react";
import { ChatEmptyState, TypingIndicator } from "../components/ui/chat-atoms";

const meta: Meta = { title: "Molecules/ChatAtoms" };
export default meta;

export const Typing: StoryObj = {
  render: () => <TypingIndicator agentName="Eliza" />,
};

export const TypingWithAvatar: StoryObj = {
  render: () => (
    <TypingIndicator
      agentName="Eliza"
      agentAvatarSrc="https://ui-avatars.com/api/?name=Eliza&background=random"
    />
  ),
};

export const EmptyState: StoryObj = {
  render: () => {
    const [lastClicked, setLastClicked] = useState<string | null>(null);
    return (
      <div className="w-[440px] h-[400px] border rounded-lg overflow-hidden">
        <ChatEmptyState agentName="Eliza" onSuggestionClick={setLastClicked} />
        {lastClicked && (
          <p className="text-xs text-center text-muted mt-2">
            Clicked: &ldquo;{lastClicked}&rdquo;
          </p>
        )}
      </div>
    );
  },
};

export const EmptyStateCustomLabels: StoryObj = {
  render: () => (
    <div className="w-[440px] h-[400px] border rounded-lg overflow-hidden">
      <ChatEmptyState
        agentName="Assistant"
        suggestions={["What's the weather?", "Book a meeting"]}
        labels={{
          startConversation: "Let's Chat",
          sendMessageTo: "Talk to",
          toBeginChatting: "to get started.",
        }}
      />
    </div>
  ),
};
