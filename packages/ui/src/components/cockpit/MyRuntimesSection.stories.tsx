/** Storybook stories for the Settings > Devices & Runtimes surface. */
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
    apiBase: "https://agt_abc123.cloud.eliza.app",
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
const createPairing = async () => ({
  code: "482731",
  qrPayload: "elizaos://pair?session=storybook&code=482731",
  expiresAt: "2026-06-01T00:05:00.000Z",
});
const devices = [
  {
    id: "mac-1",
    name: "Nubs's MacBook Pro",
    platform: "mac" as const,
    role: "this-device" as const,
    status: "online" as const,
    lastSeenLabel: "Online now",
  },
  {
    id: "iphone-1",
    name: "Nubs's iPhone",
    platform: "iphone" as const,
    role: "controller" as const,
    status: "online" as const,
    lastSeenLabel: "Online now",
  },
];

const meta = {
  title: "Settings/DevicesAndRuntimes",
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
    devices,
    onSwitch: noop,
    onCreatePairing: createPairing,
    onRedeemPairing: async () => {},
    onAddSshHost: noop,
    onAddRemote: noop,
  },
};

export const CloudActive: Story = {
  args: {
    runtimes: RUNTIMES,
    activeId: "cloud-1",
    devices,
    onSwitch: noop,
    onCreatePairing: createPairing,
    onRedeemPairing: async () => {},
    onAddSshHost: noop,
    onAddRemote: noop,
  },
};

export const NoAddForm: Story = {
  args: { runtimes: RUNTIMES, activeId: "vps-1", onSwitch: noop },
};
