import type { Meta, StoryObj } from "@storybook/react";
import { ChatTranscript } from "./chat-transcript";
import type { ChatMessageData } from "./chat-types";

const baseMessages: ChatMessageData[] = [
  {
    id: "m1",
    role: "user",
    text: "Hey, what's on my calendar this afternoon?",
  },
  {
    id: "m2",
    role: "assistant",
    text: "You have a sync with Maya at 2pm and a dentist appointment at 4:30.",
  },
  {
    id: "m3",
    role: "user",
    text: "Can you push the dentist to next week?",
  },
  {
    id: "m4",
    role: "assistant",
    text: "Rescheduled the dentist to next Tuesday at 4:30pm. Sent the confirmation to your email.",
  },
];

const groupedMessages: ChatMessageData[] = [
  { id: "g1", role: "user", text: "Three things I need today:" },
  { id: "g2", role: "user", text: "1. Finish the design doc" },
  { id: "g3", role: "user", text: "2. Review the PR from Alex" },
  { id: "g4", role: "user", text: "3. Call the bank about the wire" },
  {
    id: "g5",
    role: "assistant",
    text: "Got it. I'll remind you about the bank at 3pm — they close at 5.",
  },
  {
    id: "g6",
    role: "assistant",
    text: "Want me to draft notes for the design doc while you start on the PR?",
  },
];

const replyMessages: ChatMessageData[] = [
  {
    id: "r1",
    role: "assistant",
    text: "I scheduled the call for Thursday at 11am.",
  },
  {
    id: "r2",
    role: "user",
    text: "Actually can we move it to Friday?",
    replyToMessageId: "r1",
  },
  {
    id: "r3",
    role: "assistant",
    text: "Moved to Friday at 11am.",
  },
];

const carryoverMessages: ChatMessageData[] = [
  { id: "c1", role: "user", text: "Earlier we were talking about the trip." },
  {
    id: "c2",
    role: "assistant",
    text: "Right — Lisbon, end of October.",
  },
];

const meta = {
  title: "Composites/Chat/ChatTranscript",
  component: ChatTranscript,
  tags: ["autodocs"],
  argTypes: {
    variant: { control: "select", options: ["default", "game-modal"] },
    userMessagesOnRight: { control: "boolean" },
    agentName: { control: "text" },
    carryoverOpacity: { control: { type: "range", min: 0, max: 1, step: 0.1 } },
  },
  args: {
    agentName: "Eliza",
    messages: baseMessages,
    userMessagesOnRight: true,
    variant: "default",
    onCopy: () => {},
    onDelete: () => {},
    onEdit: () => true,
    onSpeak: () => {},
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 640, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChatTranscript>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Grouped: Story = {
  args: {
    messages: groupedMessages,
  },
};

export const WithReply: Story = {
  args: {
    messages: replyMessages,
  },
};

export const Empty: Story = {
  args: {
    messages: [],
  },
};

export const GameModalVariant: Story = {
  args: {
    variant: "game-modal",
    messages: baseMessages.slice(0, 2),
    carryoverMessages,
    carryoverOpacity: 0.5,
  },
};
