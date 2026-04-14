import type { Meta, StoryObj } from "@storybook/react";
import { ConnectionStatus } from "../components/ui/connection-status";

const meta = {
  title: "UI/ConnectionStatus",
  component: ConnectionStatus,
  tags: ["autodocs"],
  argTypes: {
    state: {
      control: "select",
      options: ["connected", "disconnected", "error"],
    },
    label: { control: "text" },
  },
} satisfies Meta<typeof ConnectionStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = {
  args: { state: "connected" },
};

export const Disconnected: Story = {
  args: { state: "disconnected" },
};

export const ErrorState: Story = {
  args: { state: "error" },
};

export const CustomLabel: Story = {
  args: { state: "connected", label: "Agent Online" },
};

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <ConnectionStatus state="connected" />
      <ConnectionStatus state="disconnected" />
      <ConnectionStatus state="error" />
      <ConnectionStatus state="connected" label="Agent Online" />
    </div>
  ),
};
