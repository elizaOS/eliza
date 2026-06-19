import type { Meta, StoryObj } from "@storybook/react";
import { ContentType } from "../../types/chat-media";
import { MemoizedChatMessage } from "./memoized-chat-message";

const noop = () => {};
const formatTimestamp = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const baseTimestamp = new Date("2026-06-05T10:30:00Z").getTime();

const meta = {
  title: "CloudUI/AiElements/MemoizedChatMessage",
  component: MemoizedChatMessage,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
    backgrounds: { default: "dark" },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          background: "#0a0a0a",
          padding: "24px",
          minWidth: "600px",
          maxWidth: "800px",
        }}
      >
        <Story />
      </div>
    ),
  ],
  args: {
    characterName: "Eliza",
    characterAvatarUrl: undefined,
    copiedMessageId: null,
    currentPlayingId: null,
    isPlaying: false,
    hasAudioUrl: false,
    formatTimestamp,
    onCopy: noop,
    onPlayAudio: noop,
    onImageLoad: noop,
    onTextReveal: noop,
  },
} satisfies Meta<typeof MemoizedChatMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AgentMessage: Story = {
  args: {
    message: {
      id: "msg-1",
      content: {
        text: "Hello! I am Eliza. I can help you plan your day, manage tasks, and keep track of your goals. What would you like to work on?",
      },
      isAgent: true,
      createdAt: baseTimestamp,
    },
  },
};

export const UserMessage: Story = {
  args: {
    message: {
      id: "msg-2",
      content: {
        text: "Can you summarize my unread emails from this morning?",
      },
      isAgent: false,
      createdAt: baseTimestamp,
    },
  },
};

export const AgentMarkdownList: Story = {
  args: {
    message: {
      id: "msg-3",
      content: {
        text: "Here is your plan for today:\n\n1. **Review PR #8258** — containers route merge follow-up\n2. **Standup at 10:30** — three quick updates\n3. **Lunch with Alex** — 12:30 at the usual spot\n4. **Deep work block** — 2pm to 4pm on the cloud-ui refactor",
      },
      isAgent: true,
      createdAt: baseTimestamp,
    },
  },
};

export const ThinkingIndicator: Story = {
  args: {
    message: {
      id: "thinking-msg-4",
      content: { text: "" },
      isAgent: true,
      createdAt: baseTimestamp,
    },
  },
};

export const ThinkingWithReasoning: Story = {
  args: {
    message: {
      id: "thinking-msg-5",
      content: { text: "" },
      isAgent: true,
      createdAt: baseTimestamp,
    },
    reasoningText:
      "Let me check the calendar for available slots after 3pm, then cross-reference with the meeting list to suggest the best time...",
    reasoningPhase: "planning",
  },
};

export const StreamingResponse: Story = {
  args: {
    isStreaming: true,
    message: {
      id: "streaming-msg-6",
      content: {
        text: "I found three open slots this afternoon. The best one looks like 3:30 — it has the longest uninterrupted window before your next call.",
      },
      isAgent: true,
      createdAt: baseTimestamp,
    },
    reasoningText: "Drafting the response with the calendar findings.",
    reasoningPhase: "response",
  },
};

export const AgentWithImageAttachment: Story = {
  args: {
    message: {
      id: "msg-7",
      content: {
        text: "Here is the chart you asked for:",
        attachments: [
          {
            id: "att-1",
            url: "https://placehold.co/512x512/FF5800/ffffff?text=Generated+Image",
            contentType: ContentType.IMAGE,
            title: "Generated chart",
          },
        ],
      },
      isAgent: true,
      createdAt: baseTimestamp,
    },
  },
};

export const CopiedState: Story = {
  args: {
    message: {
      id: "msg-8",
      content: { text: "This message has just been copied to your clipboard." },
      isAgent: true,
      createdAt: baseTimestamp,
    },
    copiedMessageId: "msg-8",
  },
};

export const WithAudioPlaying: Story = {
  args: {
    hasAudioUrl: true,
    isPlaying: true,
    message: {
      id: "msg-9",
      content: {
        text: "Playing back the audio version of this response right now.",
      },
      isAgent: true,
      createdAt: baseTimestamp,
    },
    currentPlayingId: "msg-9",
  },
};
