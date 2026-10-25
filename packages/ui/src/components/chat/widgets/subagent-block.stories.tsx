/**
 * Storybook states for the inline `SubagentBlock` (#13536 §(a),(c)): one
 * sub-agent under a task — its status, current streamed line, tool-call step
 * rows, live plan, and the indented nested-child variant. Renders the shapes
 * `task-activity-store` derives from the WS stream, without a socket.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type {
  SubagentActivity,
  TaskActivityStep,
} from "../../../state/task-activity-store";
import { SubagentBlock } from "./task-pipeline";

const FROZEN_EPOCH_MS = 1_748_779_200_000;

function step(
  id: string,
  tool: TaskActivityStep["tool"],
  seq = 1,
): TaskActivityStep {
  return { id, seq, timestamp: FROZEN_EPOCH_MS, tool };
}

function agent(over: Partial<SubagentActivity>): SubagentActivity {
  return {
    sessionId: "sess-1234abcd",
    status: "running",
    steps: [],
    updatedAt: FROZEN_EPOCH_MS,
    firstSeq: 1,
    ...over,
  };
}

const meta = {
  title: "Chat/Widgets/SubagentBlock",
  component: SubagentBlock,
} satisfies Meta<typeof SubagentBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A running sub-agent with a current line and two tool steps. */
export const Running: Story = {
  args: {
    agent: agent({
      label: "builder",
      currentText: "Wiring the planner loop into the runtime",
      steps: [
        step("t1", {
          status: "success",
          title: "read",
          rawInput: { path: "src/runtime/planner-loop.ts" },
        }),
        step(
          "t2",
          {
            status: "running",
            title: "edit",
            rawInput: { path: "src/runtime/planner-loop.ts" },
          },
          2,
        ),
      ],
    }),
  },
};

/** A running sub-agent with a live plan checklist. */
export const WithPlan: Story = {
  args: {
    agent: agent({
      label: "planner",
      currentReasoning: "Breaking the task into steps",
      plan: [
        { content: "Read the failing test", status: "completed" },
        { content: "Patch the reducer", status: "in_progress" },
        { content: "Re-run the suite", status: "pending" },
      ],
    }),
  },
};

/** A nested child session — indented under its parent. */
export const NestedChild: Story = {
  args: {
    agent: agent({
      sessionId: "child-9f8e",
      parentSessionId: "sess-1234abcd",
      label: "reviewer",
      currentReasoning: "Checking the diff for missed edge cases",
    }),
  },
};

/** A sub-agent that finished successfully. */
export const Done: Story = {
  args: {
    agent: agent({
      label: "builder",
      status: "success",
      currentText: "All tests green",
      steps: [step("t1", { status: "success", title: "bash" })],
    }),
  },
};

/** A failed sub-agent — danger tone, failed tool step. */
export const Failed: Story = {
  args: {
    agent: agent({
      label: "builder",
      status: "failure",
      steps: [
        step("t1", {
          status: "failure",
          title: "bash",
          output: "exit code 1: type error in planner-loop.ts",
        }),
      ],
    }),
  },
};

/** A sub-agent blocked waiting on the user / a login. */
export const Waiting: Story = {
  args: {
    agent: agent({ label: "deployer", status: "waiting" }),
  },
};
