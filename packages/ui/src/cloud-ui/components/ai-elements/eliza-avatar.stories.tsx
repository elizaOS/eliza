import type { Meta, StoryObj } from "@storybook/react";
import { ElizaAvatar } from "./eliza-avatar";

const meta = {
  title: "CloudUI/AiElements/ElizaAvatar",
  component: ElizaAvatar,
  tags: ["autodocs"],
  argTypes: {
    avatarUrl: { control: "text" },
    name: { control: "text" },
    className: { control: "text" },
    animate: { control: "boolean" },
    priority: { control: "boolean" },
  },
  args: {
    name: "Eliza",
    className: "h-16 w-16",
  },
  decorators: [
    (Story) => (
      <div className="flex items-center justify-center p-6 bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ElizaAvatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithCustomUrl: Story = {
  args: {
    avatarUrl: "https://placehold.co/128x128/orange/white?text=AI",
    name: "Custom Agent",
  },
};

export const NameDerived: Story = {
  args: {
    avatarUrl: undefined,
    name: "Amara",
  },
};

export const Animated: Story = {
  args: {
    name: "Luna",
    animate: true,
  },
};

export const Large: Story = {
  args: {
    name: "Professor Ada",
    className: "h-32 w-32",
    priority: true,
  },
};

export const Small: Story = {
  args: {
    name: "Wellness Coach",
    className: "h-8 w-8",
  },
};
