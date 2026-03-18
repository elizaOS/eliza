import type { Meta, StoryObj } from "@storybook/react";
import { ChatEmptyState } from "../components/ChatMessage";
import { withAppMock } from "./AppMockProvider";

const meta: Meta<typeof ChatEmptyState> = {
  title: "Chat/ChatEmptyState",
  component: ChatEmptyState,
  decorators: [withAppMock],
};
export default meta;
type Story = StoryObj<typeof ChatEmptyState>;

export const Default: Story = {
  render: () => (
    <div style={{ maxWidth: 500, minHeight: 400, display: "flex" }}>
      <ChatEmptyState agentName="Milady" />
    </div>
  ),
};

export const CustomAgentName: Story = {
  render: () => (
    <div style={{ maxWidth: 500, minHeight: 400, display: "flex" }}>
      <ChatEmptyState agentName="Aiko" />
    </div>
  ),
};
