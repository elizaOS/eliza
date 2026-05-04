import type { Meta, StoryObj } from "@storybook/react";
import { TypingIndicator } from "../components/composites/chat";

const meta = {
  title: "UI/ChatAtoms/TypingIndicator",
  component: TypingIndicator,
  tags: ["autodocs"],
  argTypes: {
    agentName: { control: "text" },
    agentAvatarSrc: { control: "text" },
  },
} satisfies Meta<typeof TypingIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { agentName: "Eliza" },
};

export const WithAvatar: Story = {
  args: {
    agentName: "Eliza",
    agentAvatarSrc: "https://api.dicebear.com/7.x/bottts/svg?seed=eliza",
  },
};
