/**
 * Storybook states for the Chat Composer chat composite used by shared
 * conversation and composer surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { useRef } from "react";
import { ChatComposer, type ChatComposerVoiceState } from "./chat-composer";

const translate = (key: string) => {
  const map: Record<string, string> = {
    "common.send": "Send",
    "common.message": "Message",
    "chat.stopGeneration": "Stop generation",
    "chat.stopSpeaking": "Stop speaking",
    "chat.stopListening": "Stop listening",
    "chat.releaseToSend": "Release to send",
    "chat.agentStarting": "Agent starting…",
    "chat.listening": "Listening…",
    "chat.voiceInput": "Voice input",
    "chat.agentVoiceOn": "Agent voice on",
    "chat.agentVoiceOff": "Agent voice off",
    "chat.micTitleIdleEnhanced": "Tap to speak (enhanced)",
    "chat.micTitleIdleStandard": "Tap to speak",
    "aria.attachImage": "Attach image",
    "aria.agentVoiceOn": "Agent voice on",
    "aria.agentVoiceOff": "Agent voice off",
  };
  return map[key] ?? key;
};

const idleVoice: ChatComposerVoiceState = {
  assistantTtsQuality: "standard",
  captureMode: "idle",
  interimTranscript: "",
  isListening: false,
  isSpeaking: false,
  startListening: () => {},
  stopListening: () => {},
  supported: true,
};

function ComposerHarness(props: React.ComponentProps<typeof ChatComposer>) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  return (
    <div className="w-full max-w-2xl p-4">
      <ChatComposer {...props} textareaRef={ref} />
    </div>
  );
}

const meta = {
  title: "Composites/Chat/ChatComposer",
  component: ChatComposer,
  tags: ["autodocs"],
  render: (args) => <ComposerHarness {...args} />,
  argTypes: {
    variant: { control: "select", options: ["default", "game-modal"] },
    layout: { control: "select", options: ["default", "inline"] },
    chatInput: { control: "text" },
    chatPendingImagesCount: { control: { type: "number", min: 0 } },
    chatSending: { control: "boolean" },
    isAgentStarting: { control: "boolean" },
    isComposerLocked: { control: "boolean" },
    agentVoiceEnabled: { control: "boolean" },
    showAgentVoiceToggle: { control: "boolean" },
    hideAttachButton: { control: "boolean" },
    placeholder: { control: "text" },
  },
  args: {
    variant: "default",
    layout: "default",
    chatInput: "",
    chatPendingImagesCount: 0,
    chatSending: false,
    isAgentStarting: false,
    isComposerLocked: false,
    agentVoiceEnabled: false,
    showAgentVoiceToggle: true,
    hideAttachButton: false,
    voice: idleVoice,
    t: translate,
    textareaRef: { current: null },
    onAttachImage: () => {},
    onChatInputChange: () => {},
    onSend: () => {},
    onStop: () => {},
    onStopSpeaking: () => {},
    onToggleAgentVoice: () => {},
  },
} satisfies Meta<typeof ChatComposer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithDraft: Story = {
  args: {
    chatInput: "Can you summarize the meeting notes from this morning?",
  },
};

export const Sending: Story = {
  args: {
    chatSending: true,
  },
};

export const Listening: Story = {
  args: {
    voice: {
      ...idleVoice,
      isListening: true,
      captureMode: "compose",
      interimTranscript: "remind me to call sam at three",
    },
  },
};

export const AgentVoiceOn: Story = {
  args: {
    agentVoiceEnabled: true,
    chatInput: "Read me the latest update.",
  },
};

export const InlineLayout: Story = {
  args: {
    layout: "inline",
    chatInput: "Quick reply from the inline composer.",
    showAgentVoiceToggle: false,
  },
};

export const GameModal: Story = {
  args: {
    variant: "game-modal",
    chatInput: "Move the rook to e5.",
  },
};
