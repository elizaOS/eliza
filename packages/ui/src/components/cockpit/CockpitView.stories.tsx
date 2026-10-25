/** Storybook stories for the coding cockpit view (deck + spawn form). */
import type { Meta, StoryObj } from "@storybook/react";

import type { OrchestratorRoomRosterOverview } from "../../api/client-types-cloud";
import { CockpitView } from "./CockpitView";

const ROSTER: OrchestratorRoomRosterOverview = {
  rooms: [
    {
      taskId: "t1",
      taskTitle: "Fix the failing auth tests and open a PR",
      status: "active",
      activeAgentCount: 1,
      multiParty: true,
      participants: [
        { kind: "orchestrator", id: "o1", label: "Eliza", active: true },
        {
          kind: "sub_agent",
          id: "a1",
          label: "claude-1",
          framework: "claude",
          status: "running",
          active: true,
          activeTool: "edit_file",
          totalTokens: 12030,
          usageState: "measured",
        },
        { kind: "user", id: "u1", label: "You" },
      ],
    },
    {
      taskId: "t2",
      taskTitle: "Port the pricing table to the new schema",
      status: "active",
      activeAgentCount: 2,
      multiParty: true,
      participants: [
        { kind: "orchestrator", id: "o2", label: "Eliza", active: true },
        {
          kind: "sub_agent",
          id: "a2",
          label: "opencode-1",
          framework: "opencode",
          status: "running",
          active: true,
          activeTool: "bash",
          totalTokens: 4200,
          usageState: "measured",
        },
        {
          kind: "sub_agent",
          id: "a3",
          label: "eliza-code-1",
          framework: "elizaos",
          status: "ready",
          active: false,
          totalTokens: 880,
          usageState: "estimated",
        },
      ],
    },
  ],
};

const noop = () => {};

const meta = {
  title: "Cockpit/CockpitView",
  component: CockpitView,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[860px] w-[420px] bg-bg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CockpitView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithSessions: Story = {
  args: { rooms: ROSTER, onCreateSession: noop },
};

export const Empty: Story = {
  args: { rooms: { rooms: [] }, onCreateSession: noop },
};

export const ExperimentalArmed: Story = {
  args: { rooms: ROSTER, onCreateSession: noop, experimentalEnabled: true },
};

export const WithError: Story = {
  args: {
    rooms: { rooms: [] },
    onCreateSession: noop,
    error: "Couldn't reach the orchestrator. Retrying…",
  },
};
