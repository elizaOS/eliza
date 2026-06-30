import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import type {
  CodingAgentOrchestratorStatus,
  OrchestratorRoomRosterOverview,
} from "../../../api/client-types-cloud";
import {
  OrchestratorRoomView,
  OrchestratorRoomViewSkeleton,
} from "./agent-orchestrator-room-view";

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

/** Cheap orchestrator-wide counts that drive the always-on status line, even
 * when there are no rooms yet. */
const status: CodingAgentOrchestratorStatus = {
  taskCount: 3,
  activeTaskCount: 2,
  pausedTaskCount: 0,
  blockedTaskCount: 0,
  validatingTaskCount: 1,
  sessionCount: 4,
  activeSessionCount: 3,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    state: "measured",
    byProvider: [],
  },
  byStatus: {} as CodingAgentOrchestratorStatus["byStatus"],
};

const idleStatus: CodingAgentOrchestratorStatus = {
  ...status,
  taskCount: 0,
  activeTaskCount: 0,
  validatingTaskCount: 0,
  sessionCount: 0,
  activeSessionCount: 0,
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

/** No active rooms, zero counts: the friendly empty state that tells the user
 * how to make a room appear. This is the common first-run view. */
export const Empty: Story = {
  args: { rooms: { rooms: [] }, status: idleStatus },
};

/** Empty board but the orchestrator is clearly alive: the status line shows live
 * tasks/agents even before a room roster exists. */
export const EmptyWithLiveCounts: Story = {
  args: { rooms: { rooms: [] }, status },
};

/** First-load placeholder: a quiet skeleton inside the section frame instead of
 * the widget vanishing. */
export const Loading: Story = {
  render: () => <OrchestratorRoomViewSkeleton />,
};

/** The live board: a multi-party room and a single-agent room side by side. */
export const LiveRooms: Story = {
  args: { rooms, status },
};

/** Last poll failed but we kept the last-good roster: a subtle hint, no crash. */
export const StaleAfterError: Story = {
  args: { rooms, status, staleHint: true },
};

/** A single multi-party room with a running tool, a worker, and an idle agent. */
export const MultiPartyRoom: Story = {
  args: { rooms: { rooms: [rooms.rooms[0]] }, status },
};
