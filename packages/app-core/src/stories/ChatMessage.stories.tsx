import type { Meta, StoryObj } from "@storybook/react";
import { ChatMessage } from "../components/ChatMessage";
import { withAppMock } from "./AppMockProvider";

const meta: Meta<typeof ChatMessage> = {
  title: "Chat/ChatMessage",
  component: ChatMessage,
  decorators: [withAppMock],
};
export default meta;
type Story = StoryObj<typeof ChatMessage>;

const userMsg = {
  id: "msg-1",
  role: "user" as const,
  text: "Hey, how are you doing today? I wanted to ask about the weather forecast for this weekend.",
  timestamp: Date.now(),
};

const agentMsg = {
  id: "msg-2",
  role: "assistant" as const,
  text: "I'm doing great, thanks for asking! The weekend forecast looks sunny with temperatures around 72°F. Perfect weather for outdoor activities.",
  timestamp: Date.now(),
};

const longMsg = {
  id: "msg-3",
  role: "assistant" as const,
  text: "Here's a detailed breakdown of the forecast:\n\n**Saturday**: Sunny, high of 74°F, low of 58°F. Light winds from the southwest at 5-10 mph. UV index: 7 (high).\n\n**Sunday**: Partly cloudy, high of 71°F, low of 55°F. Winds shifting to the northwest at 8-12 mph. 20% chance of afternoon showers.\n\nOverall, it's a great weekend to be outdoors. I'd recommend sunscreen for Saturday and perhaps a light jacket for Sunday evening.",
  timestamp: Date.now(),
};

const interruptedMsg = {
  id: "msg-4",
  role: "assistant" as const,
  text: "I was starting to explain the concept of—",
  timestamp: Date.now(),
  interrupted: true,
};

export const UserMessage: Story = {
  render: () => (
    <div style={{ maxWidth: 600 }}>
      <ChatMessage message={userMsg} agentName="Milady" />
    </div>
  ),
};

export const AgentMessage: Story = {
  render: () => (
    <div style={{ maxWidth: 600 }}>
      <ChatMessage message={agentMsg} agentName="Milady" />
    </div>
  ),
};

export const GroupedMessages: Story = {
  render: () => (
    <div style={{ maxWidth: 600 }}>
      <ChatMessage message={agentMsg} agentName="Milady" />
      <ChatMessage
        message={{
          ...agentMsg,
          id: "msg-2b",
          text: "Would you like more details?",
        }}
        agentName="Milady"
        isGrouped
      />
    </div>
  ),
};

export const LongMessage: Story = {
  render: () => (
    <div style={{ maxWidth: 600 }}>
      <ChatMessage message={longMsg} agentName="Milady" />
    </div>
  ),
};

export const Interrupted: Story = {
  render: () => (
    <div style={{ maxWidth: 600 }}>
      <ChatMessage message={interruptedMsg} agentName="Milady" />
    </div>
  ),
};

export const Conversation: Story = {
  name: "Full Conversation",
  render: () => (
    <div style={{ maxWidth: 600 }}>
      <ChatMessage message={userMsg} agentName="Milady" />
      <ChatMessage message={agentMsg} agentName="Milady" />
      <ChatMessage
        message={{
          ...userMsg,
          id: "msg-5",
          text: "Thanks! Any rain expected?",
        }}
        agentName="Milady"
      />
      <ChatMessage
        message={{
          ...agentMsg,
          id: "msg-6",
          text: "Only a 20% chance on Sunday afternoon. You should be fine!",
        }}
        agentName="Milady"
      />
    </div>
  ),
};
