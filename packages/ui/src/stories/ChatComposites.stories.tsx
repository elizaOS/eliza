import type { Meta, StoryObj } from "@storybook/react";
import { useRef, useState } from "react";

import {
  ChatAttachmentStrip,
  ChatComposer,
  ChatComposerShell,
  ChatSidebar,
  ChatThreadLayout,
  ChatTranscript,
  TypingIndicator,
} from "../index";

const storyConversations = [
  {
    id: "ops-sync",
    title: "Ops sync",
    updatedAtLabel: "2m ago",
    source: "discord",
  },
  {
    id: "wallet-review",
    title: "Wallet approvals",
    updatedAtLabel: "12m ago",
    source: "telegram",
  },
  {
    id: "browser-tab",
    title: "Browser workspace",
    updatedAtLabel: "1h ago",
  },
];

const storyMessages = [
  {
    id: "user-1",
    role: "user",
    text: "Can you summarize the pending wallet approvals?",
    from: "Shaw",
  },
  {
    id: "assistant-1",
    role: "assistant",
    text: "There are three pending approvals. Two are browser opens, one is a wallet send above the approval threshold.",
  },
  {
    id: "user-2",
    role: "user",
    text: "What should I review first?",
    from: "Shaw",
  },
];

const translationMap: Record<string, string> = {
  "aria.attachImage": "Attach image",
  "chat.agentStarting": "Agent starting",
  "chat.inputPlaceholder": "Message the app…",
  "chat.inputPlaceholderNarrow": "Message…",
  "chat.listening": "Listening…",
  "chat.micTitleIdleEnhanced": "Start voice input",
  "chat.micTitleIdleStandard": "Start voice input",
  "chat.releaseToSend": "Release to send",
  "chat.send": "Send",
  "chat.stopGeneration": "Stop generation",
  "chat.stopListening": "Stop listening",
  "chat.stopSpeaking": "Stop speaking",
  "chat.voiceInput": "Voice input",
  "chatview.AttachImage": "Attach image",
};

function t(key: string) {
  return translationMap[key] ?? key;
}

const voiceState = {
  supported: true,
  isListening: false,
  captureMode: "idle" as const,
  interimTranscript: "",
  isSpeaking: false,
  toggleListening: () => undefined,
  startListening: () => undefined,
  stopListening: () => undefined,
};

const attachments = [
  {
    id: "att-1",
    name: "wallet-screen.png",
    alt: "Wallet screenshot",
    src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'%3E%3Crect width='96' height='96' rx='18' fill='%23dbeafe'/%3E%3Cpath d='M20 30h56v36H20z' fill='%2393c5fd'/%3E%3Cpath d='M28 38h40v4H28zm0 10h24v4H28zm0 10h32v4H28z' fill='%231e3a8a'/%3E%3C/svg%3E",
  },
];

const meta = {
  title: "Composites/Chat",
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Workspace: Story = {
  render: () => {
    const [chatInput, setChatInput] = useState(
      "Draft a short update for the wallet approvals queue.",
    );
    const [searchValue, setSearchValue] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    return (
      <div className="min-h-screen bg-bg/60 p-5">
        <div className="grid h-[760px] w-full max-w-[74rem] overflow-hidden rounded-[32px] border border-border/35 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_82%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] shadow-[0_24px_60px_-30px_rgba(15,23,42,0.18)] lg:grid-cols-[320px_minmax(0,1fr)]">
          <ChatSidebar
            activeConversationId="ops-sync"
            conversations={storyConversations}
            onCreate={() => undefined}
            onSelect={() => undefined}
            searchValue={searchValue}
            onSearchChange={(event) => setSearchValue(event.target.value)}
            onSearchClear={() => setSearchValue("")}
            unreadConversations={new Set(["wallet-review"])}
          />

          <ChatThreadLayout
            footerStack={
              <div className="px-4 pb-2 text-xs text-muted">
                Approvals required before browser opens or wallet sends can be
                executed.
              </div>
            }
            composer={
              <ChatComposerShell
                before={
                  <ChatAttachmentStrip
                    items={attachments}
                    onRemove={() => undefined}
                  />
                }
              >
                <ChatComposer
                  variant="default"
                  textareaRef={textareaRef}
                  chatInput={chatInput}
                  chatPendingImagesCount={attachments.length}
                  isComposerLocked={false}
                  isAgentStarting={false}
                  chatSending={false}
                  voice={voiceState}
                  agentVoiceEnabled
                  t={t}
                  onAttachImage={() => undefined}
                  onChatInputChange={setChatInput}
                  onKeyDown={() => undefined}
                  onSend={() => undefined}
                  onStop={() => undefined}
                  onStopSpeaking={() => undefined}
                  onToggleAgentVoice={() => undefined}
                  codingAgentsAvailable
                  onCreateTask={() => undefined}
                />
              </ChatComposerShell>
            }
          >
            <div className="mx-auto flex w-full max-w-[44rem] flex-col">
              <ChatTranscript
                agentName="the app"
                messages={storyMessages}
                typingIndicator={<TypingIndicator agentName="the app" />}
              />
            </div>
          </ChatThreadLayout>
        </div>
      </div>
    );
  },
};

export const RenameDialog: Story = {
  render: () => {
    const [value, setValue] = useState("Wallet approvals");

    return (
      <div className="min-h-screen bg-bg/60 p-6">
        <ChatSidebar.RenameDialog
          open
          title="Rename conversation"
          description="Choose a title that will make this thread easy to find later."
          inputLabel="Conversation title"
          value={value}
          onChange={setValue}
          onClose={() => undefined}
          onSave={() => undefined}
          onSuggest={() => undefined}
          saveLabel="Save"
          suggestLabel="Suggest"
        />
      </div>
    );
  },
};
