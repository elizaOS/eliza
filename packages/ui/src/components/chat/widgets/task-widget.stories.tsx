/**
 * Storybook states for the Task Widget chat widget across populated, empty,
 * and interaction-focused render states.
 */
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { client } from "../../../api/client";
import type {
  CodingAgentTaskThreadDetail,
  CodingAgentTaskUsageSummary,
} from "../../../api/client-types-cloud";
import { TaskWidget } from "./task-widget";

/**
 * The inline TaskWidget renders an orchestrator task thread from a
 * `[TASK:<threadId>]` chat marker. It fetches the live detail via
 * `client.getCodingAgentTaskThread(threadId)`; before that resolves it shows
 * the `fallbackTitle` with an "open" status. There is no backend in Storybook,
 * so each story stubs `getCodingAgentTaskThread` (restored after render) to
 * resolve to a specific status, return `null` (removed), or reject (frozen on
 * the optimistic fallback). Relative activity timestamps offset from the
 * story-gate's frozen epoch so they render the same byte-for-byte every run.
 */
const FROZEN_EPOCH_MS = 1_748_779_200_000; // matches the story-gate frozen clock

const THREAD_ID = "0123abcd-1234-5678-9abc-deadbeefcafe";

function usage(
  over: Partial<CodingAgentTaskUsageSummary> = {},
): CodingAgentTaskUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    state: "estimated",
    byProvider: [],
    ...over,
  };
}

function detail(
  over: Partial<CodingAgentTaskThreadDetail> = {},
): CodingAgentTaskThreadDetail {
  return {
    id: THREAD_ID,
    title: "Build the planner loop",
    kind: "coding",
    status: "active",
    priority: "normal",
    paused: false,
    originalRequest: "",
    sessionCount: 2,
    activeSessionCount: 2,
    latestSessionId: null,
    latestSessionLabel: null,
    latestWorkdir: null,
    latestRepo: null,
    latestActivityAt: FROZEN_EPOCH_MS - 5 * 60_000,
    decisionCount: 0,
    usage: usage({ totalTokens: 1234, state: "estimated" }),
    createdAt: "2025-06-01T11:00:00.000Z",
    updatedAt: "2025-06-01T11:55:00.000Z",
    closedAt: null,
    goal: "",
    roomId: null,
    taskRoomId: null,
    worldId: null,
    ownerUserId: null,
    parentTaskId: null,
    acceptanceCriteria: [],
    currentPlan: null,
    providerPolicy: null,
    lastUserTurnAt: null,
    lastCoordinatorTurnAt: null,
    metadata: {},
    sessions: [],
    decisions: [],
    events: [],
    artifacts: [],
    messages: [],
    transcripts: [],
    planRevisions: [],
    ...over,
  };
}

// The widget renders the optimistic fallback synchronously, then fetches the
// detail in an effect (after the decorator returns) to fill in the real status.
// The stub therefore must stay installed for the render lifetime — a
// synchronous try/finally restore would revert it before the fetch runs,
// collapsing every story to the "open" fallback. Each story re-installs its
// own stub before rendering.

/** Resolve the detail fetch to a fixed thread. */
function resolvesTo(value: CodingAgentTaskThreadDetail | null): Decorator {
  return (Story) => {
    client.getCodingAgentTaskThread = async () => value;
    return <Story />;
  };
}

/** Reject the detail fetch so the widget stays on the optimistic fallback. */
function rejects(): Decorator {
  return (Story) => {
    client.getCodingAgentTaskThread = async () => {
      throw new Error("network down");
    };
    return <Story />;
  };
}

const meta = {
  title: "Chat/Widgets/TaskWidget",
  component: TaskWidget,
  tags: ["autodocs"],
  args: { threadId: THREAD_ID, fallbackTitle: "Optimistic title" },
} satisfies Meta<typeof TaskWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Fetch never resolves — the optimistic fallback title + "open" status. */
export const Loading: Story = {
  decorators: [
    (Story) => {
      client.getCodingAgentTaskThread = () => new Promise(() => undefined);
      return <Story />;
    },
  ],
};

/** An active task with agents, recent activity, and a token count. */
export const Active: Story = {
  decorators: [resolvesTo(detail())],
};

/** A task waiting on the user — the warn-toned "waiting on you" status. */
export const WaitingOnUser: Story = {
  decorators: [
    resolvesTo(
      detail({
        title: "Confirm the deploy target",
        status: "waiting_on_user",
        activeSessionCount: 0,
      }),
    ),
  ],
};

/** A completed task — terminal status, no pulse animation. */
export const Done: Story = {
  decorators: [
    resolvesTo(
      detail({
        title: "Refactor the message parser",
        status: "done",
        activeSessionCount: 0,
        usage: usage({ totalTokens: 1_450_000, state: "measured" }),
      }),
    ),
  ],
};

/** A failed task — danger-toned status. */
export const Failed: Story = {
  decorators: [
    resolvesTo(
      detail({
        title: "Migrate the schema",
        status: "failed",
        activeSessionCount: 0,
      }),
    ),
  ],
};

/** The thread was deleted server-side — the muted "Task removed." row. */
export const Removed: Story = {
  decorators: [resolvesTo(null)],
};

/** The fetch failed — the widget freezes on the optimistic fallback. */
export const FetchError: Story = {
  decorators: [rejects()],
};

/** A long title must truncate within the card. */
export const LongTitle: Story = {
  decorators: [
    resolvesTo(
      detail({
        title:
          "Implement the end-to-end migration runbook for the multi-region database failover including verification of every downstream consumer",
      }),
    ),
  ],
};

/** A non-ASCII title must render without mojibake. */
export const UnicodeTitle: Story = {
  decorators: [
    resolvesTo(
      detail({ title: "パーサーをリファクタリングする 🛠️ — مهمة عاجلة" }),
    ),
  ],
};
