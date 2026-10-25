/** Storybook fixture exercising the EmptyState composite (icon + copy + action); also feeds the story-gate render check. */
import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./button";
import { EmptyState } from "./empty-state";

const Icon = () => (
  <svg
    aria-hidden="true"
    fill="none"
    height="24"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 24 24"
    width="24"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
);

const meta = {
  title: "Primitives/EmptyState",
  component: EmptyState,
  tags: ["autodocs"],
  argTypes: {
    variant: { control: "select", options: ["default", "dashed", "minimal"] },
    title: { control: "text" },
    description: { control: "text" },
  },
  args: {
    title: "No conversations yet",
    description: "Start a new chat to see your message history here.",
    variant: "default",
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dashed: Story = { args: { variant: "dashed" } };

export const Minimal: Story = { args: { variant: "minimal" } };

export const WithIcon: Story = { args: { icon: <Icon /> } };

export const WithAction: Story = {
  args: {
    icon: <Icon />,
    action: <Button>New chat</Button>,
  },
};

export const TitleOnly: Story = {
  args: { description: undefined, variant: "minimal" },
};
