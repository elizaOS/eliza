import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { ConnectionStatus } from "../components/ui/connection-status";

const meta: Meta<typeof ConnectionStatus> = {
  title: "Atoms/ConnectionStatus",
  component: ConnectionStatus,
};
export default meta;

export const AllStates: StoryObj = {
  render: () => (
    <div className="flex items-center gap-4">
      <ConnectionStatus state="connected" />
      <ConnectionStatus state="disconnected" />
      <ConnectionStatus state="error" />
    </div>
  ),
};
