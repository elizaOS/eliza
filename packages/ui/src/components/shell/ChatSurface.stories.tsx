import type { Meta, StoryObj } from "@storybook/react";
import { ChatSurface } from "./ChatSurface";
import type { ShellMessage } from "./shell-state";

// ChatSurface is the homescreen glass mini-chat. These stories exercise its
// canonical message row (shared ChatBubble), the shared TypingIndicator for the
// in-flight assistant placeholder, and the empty greeting state. The
// jump-to-latest control only appears once a real scroller has scrolled up, so
// it is not visible in a short static story — its behaviour is unit-tested.

const NOW = 1780000000000;
const MESSAGES: ShellMessage[] = [
  {
    id: "u1",
    role: "user",
    content: "Remind me to call Alex at 3pm",
    createdAt: NOW - 20000,
  },
  {
    id: "a1",
    role: "assistant",
    content: "Done — reminder set for 3:00 PM.",
    createdAt: NOW - 19000,
  },
  {
    id: "u2",
    role: "user",
    content: "and add a note to prep the deck first",
    createdAt: NOW - 10000,
  },
  {
    id: "a2",
    role: "assistant",
    content: "Noted. I'll surface both at 2:45 so you have a runway.",
    createdAt: NOW - 9000,
  },
];

const meta = {
  title: "Shell/ChatSurface",
  component: ChatSurface,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ height: 420, width: 360, margin: "0 auto" }}>
        <Story />
      </div>
    ),
  ],
  args: {
    onSend: () => {},
    canSend: true,
  },
} satisfies Meta<typeof ChatSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Conversation: Story = {
  args: { messages: MESSAGES },
};

export const Empty: Story = {
  args: { messages: [], greeting: "Ask Eliza anything." },
};

export const AssistantTyping: Story = {
  args: {
    messages: [
      ...MESSAGES,
      { id: "u3", role: "user", content: "what's next?", createdAt: NOW },
      { id: "a3", role: "assistant", content: "", createdAt: NOW + 1 },
    ],
  },
};
