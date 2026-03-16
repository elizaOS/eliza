import type { Meta, StoryObj } from "@storybook/react";
import { TypingIndicator } from "../components/ChatMessage";

const meta: Meta<typeof TypingIndicator> = {
  title: "Chat/TypingIndicator",
  component: TypingIndicator,
};
export default meta;
type Story = StoryObj<typeof TypingIndicator>;

export const Default: Story = {
  render: () => (
    <div style={{ maxWidth: 600 }}>
      <TypingIndicator agentName="Milady" />
    </div>
  ),
};

export const WithAvatar: Story = {
  render: () => (
    <div style={{ maxWidth: 600 }}>
      <TypingIndicator
        agentName="Milady"
        agentAvatarSrc="https://ui-avatars.com/api/?name=M&background=7c3aed&color=fff&size=64"
      />
    </div>
  ),
};
