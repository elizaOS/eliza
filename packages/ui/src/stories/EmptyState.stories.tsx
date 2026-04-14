import type { Meta, StoryObj } from "@storybook/react";
import { Inbox } from "lucide-react";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";

const meta = {
  title: "UI/EmptyState",
  component: EmptyState,
  tags: ["autodocs"],
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Minimal: Story = {
  args: {
    title: "No items found",
  },
};

export const Full: Story = {
  args: {
    icon: <Inbox className="h-8 w-8" />,
    title: "No messages yet",
    description:
      "Your inbox is empty. Start a conversation to see messages here.",
    action: <Button>New Message</Button>,
  },
};

export const WithDescription: Story = {
  args: {
    title: "No agents configured",
    description: "Create your first agent to get started with the app.",
  },
};
