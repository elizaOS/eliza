import type { Meta, StoryObj } from "@storybook/react";
import { ConnectionStatus } from "./connection-status";

const meta = {
  title: "Primitives/ConnectionStatus",
  component: ConnectionStatus,
  tags: ["autodocs"],
  argTypes: {
    state: {
      control: "select",
      options: ["connected", "disconnected", "error"],
    },
    label: { control: "text" },
  },
  args: { state: "connected" },
} satisfies Meta<typeof ConnectionStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Connected: Story = { args: { state: "connected" } };
export const Disconnected: Story = { args: { state: "disconnected" } };
export const ErrorState: Story = { args: { state: "error" } };

export const CustomLabel: Story = {
  args: { state: "error", label: "Connection lost — retrying" },
};

/** Every state in one view. */
export const AllStates: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-3">
      <ConnectionStatus {...args} state="connected" />
      <ConnectionStatus {...args} state="disconnected" />
      <ConnectionStatus {...args} state="error" />
    </div>
  ),
};
