import type { Meta, StoryObj } from "@storybook/react";
import { Inbox, MessageSquare, Users } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { DataListEmptyState } from "./data-list-empty-state";

const meta = {
  title: "CloudUI/DataList/DataListEmptyState",
  component: DataListEmptyState,
  tags: ["autodocs"],
  args: {
    title: "No items yet",
    description: "When you create your first item it will show up here.",
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 640, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DataListEmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithIcon: Story = {
  args: {
    title: "Your inbox is empty",
    description: "New messages from your agents will appear here.",
    icon: Inbox,
  },
};

export const WithAction: Story = {
  args: {
    title: "No conversations yet",
    description: "Start a chat with your agent to see it show up in this list.",
    icon: MessageSquare,
    action: (
      <Button onClick={() => {}} size="sm">
        Start a conversation
      </Button>
    ),
  },
};

export const TitleOnly: Story = {
  args: {
    title: "Nothing here",
    description: undefined,
  },
};

export const TeamMembers: Story = {
  args: {
    title: "Invite your team",
    description:
      "You have not added any teammates yet. Invite collaborators to share agents and workflows.",
    icon: Users,
    action: (
      <Button onClick={() => {}} variant="outline" size="sm">
        Send invite
      </Button>
    ),
  },
};
