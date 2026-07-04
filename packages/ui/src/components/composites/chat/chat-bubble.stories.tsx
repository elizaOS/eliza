/**
 * Storybook states for the Chat Bubble chat composite used by shared
 * conversation and composer surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ChatBubble } from "./chat-bubble";

const meta = {
  title: "Composites/Chat/ChatBubble",
  component: ChatBubble,
  tags: ["autodocs"],
  argTypes: {
    tone: { control: "select", options: ["assistant", "user"] },
    source: {
      control: "select",
      options: [undefined, "imessage", "telegram", "discord", "whatsapp"],
    },
    children: { control: "text" },
  },
  args: {
    tone: "assistant",
    children: "Hey, I pulled up the schedule — you are free after 3pm today.",
  },
} satisfies Meta<typeof ChatBubble>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Assistant: Story = {};

export const User: Story = {
  args: {
    tone: "user",
    children: "Perfect, book the 3:30 slot then.",
  },
};

export const FromTelegram: Story = {
  args: {
    tone: "user",
    source: "telegram",
    children: "Can you forward that to the team channel?",
  },
};

export const FromDiscord: Story = {
  args: {
    tone: "assistant",
    source: "discord",
    children: "Posted it to #general and pinned the summary.",
  },
};

export const Multiline: Story = {
  args: {
    children:
      "Here is the plan:\n\n1. Confirm the venue\n2. Send invites\n3. Lock the menu by Friday",
  },
};
