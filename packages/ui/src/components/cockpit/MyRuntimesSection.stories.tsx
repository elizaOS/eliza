/** Storybook stories for the "My Runtimes" runtime-switcher section. */
import type { Meta, StoryObj } from "@storybook/react";

import type { AgentProfile } from "../../state/agent-profile-types";
import { MyRuntimesSection } from "./MyRuntimesSection";

const RUNTIMES: AgentProfile[] = [
  {
    id: "local-1",
    label: "This device",
    kind: "local",
    createdAt: "2026-06-01T00:00:00.000Z",
  },
  {
    id: "cloud-1",
    label: "Cloud agent",
    kind: "cloud",
    cloudAgentId: "agt_abc123",
    apiBase: "https://agt_abc123.agent.elizacloud.ai",
    createdAt: "2026-06-02T00:00:00.000Z",
  },
  {
    id: "vps-1",
    label: "My VPS",
    kind: "remote",
    apiBase: "http://100.72.1.4:3000",
    createdAt: "2026-06-03T00:00:00.000Z",
  },
];

const noop = () => {};

const meta = {
  title: "Cockpit/MyRuntimesSection",
  component: MyRuntimesSection,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="w-[380px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MyRuntimesSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LocalActive: Story = {
  args: {
    runtimes: RUNTIMES,
    activeId: "local-1",
    onSwitch: noop,
    onAddRemote: noop,
  },
};

export const CloudActive: Story = {
  args: {
    runtimes: RUNTIMES,
    activeId: "cloud-1",
    onSwitch: noop,
    onAddRemote: noop,
  },
};

export const NoAddForm: Story = {
  args: { runtimes: RUNTIMES, activeId: "vps-1", onSwitch: noop },
};
