/**
 * Storybook states for the Agent Orchestrator Room View chat widget across
 * populated, empty, and interaction-focused render states.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import type { OrchestratorRoomRosterOverview } from "../../../api/client-types-cloud";
import { OrchestratorRoomView } from "./agent-orchestrator-room-view";

// The widget lives in the chat sidebar, render stories in a matching column.
function Sidebar({ children }: { children: ReactNode }) {
  return (
    <div className="w-[320px] rounded-lg border border-border/40 bg-bg/40 p-3">
      {children}
    </div>
  );
}

/** Two live rooms with a mixed swarm: a multi-party room with three sub-agents
 * (one running a tool, one working, one idle/ready) and a single-agent room. */
const rooms: OrchestratorRoomRosterOverview = {
  rooms: [
    {
      taskId: "task-parser",
      taskTitle: "Refactor the streaming parser",
      status: "active",
      roomId: "room-1",
      activeAgentCount: 2,
      multiParty: true,
      participants: [
        { kind: "orchestrator", id: "orchestrator", label: "Orchestrator" },
        { kind: "user", id: "owner", label: "You" },
        {
          kind: "sub_agent",
          id: "s1",
          label: "Ada",
          framework: "claude",
          status: "tool_running",
          active: true,
          activeTool: "edit_file",
          accountProviderId: "anthropic-subscription",
          accountId: "claude-work",
          accountLabel: "Claude — Work",
          totalTokens: 48200,
          usageState: "measured",
        },
        {
          kind: "sub_agent",
          id: "s2",
          label: "Cody",
          framework: "codex",
          status: "running",
          active: true,
          accountProviderId: "openai-codex",
          accountId: "codex-main",
          accountLabel: "Codex — Main",
          totalTokens: 13800,
          usageState: "measured",
        },
        {
          kind: "sub_agent",
          id: "s3",
          label: "Mara",
          framework: "opencode",
          status: "stopped",
          active: false,
          accountProviderId: "cerebras-api",
          accountId: "cerebras-1",
          accountLabel: "Cerebras — Team",
          totalTokens: 6100,
          usageState: "estimated",
        },
      ],
    },
    {
      taskId: "task-migration",
      taskTitle: "Migrate the room view to react-query",
      status: "waiting_on_user",
      roomId: "room-2",
      activeAgentCount: 1,
      multiParty: false,
      participants: [
        { kind: "orchestrator", id: "orchestrator", label: "Orchestrator" },
        { kind: "user", id: "owner", label: "You" },
        {
          kind: "sub_agent",
          id: "s4",
          label: "Vera",
          framework: "claude",
          status: "ready",
          active: true,
          accountProviderId: "anthropic-subscription",
          accountId: "claude-personal",
          accountLabel: "Claude — Personal",
          totalTokens: 2300,
          usageState: "measured",
        },
      ],
    },
  ],
};

const meta = {
  title: "Chat/Widgets/OrchestratorRooms",
  component: OrchestratorRoomView,
  decorators: [
    (Story) => (
      <Sidebar>
        <Story />
      </Sidebar>
    ),
  ],
  args: { rooms: null },
} satisfies Meta<typeof OrchestratorRoomView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No active rooms: the empty state that explains where rooms come from. */
export const Empty: Story = {
  args: { rooms: { rooms: [] } },
};

/** The live board: a multi-party room and a single-agent room side by side. */
export const LiveRooms: Story = {
  args: { rooms },
};

/** A single multi-party room with a running tool, a worker, and an idle agent. */
export const MultiPartyRoom: Story = {
  args: { rooms: { rooms: [rooms.rooms[0]] } },
};
