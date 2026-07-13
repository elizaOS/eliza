/**
 * Visual-state catalog for the live orchestrator task rail: populated lineage,
 * loading, designed empty, and explicit transport failure.
 */

import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import type { OrchestratorWidgetSnapshot } from "../../../api/client-types-cloud";
import {
  assert,
  waitForTestId,
} from "../../../storybook/home-widget-decorator";
import { OrchestratorTaskWidgetView } from "./orchestrator-task-widget";

function Sidebar({ children }: { children: ReactNode }) {
  return (
    <div className="w-[320px] rounded-lg border border-border/40 bg-bg/95 p-3">
      {children}
    </div>
  );
}

const snapshot: OrchestratorWidgetSnapshot = {
  version: "orchestrator.widgets.v1",
  generatedAt: "2026-07-13T00:00:00.000Z",
  totalTaskCount: 5,
  tasks: [
    {
      taskId: "task-parent",
      label: "Ship the orchestration rail",
      status: "running",
      model: "claude-opus-4-7",
      account: { label: "Claude — Work" },
      progressSummary: "Rendering the live SSE state",
      evidenceLinks: [],
      timestamps: {
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:01:00.000Z",
      },
      childTaskIds: ["task-child-a", "task-child-b"],
    },
    {
      taskId: "task-child-a",
      label: "Verify the browser consumer",
      status: "needs_input",
      progressSummary: "Waiting for screenshot review",
      evidenceLinks: [],
      timestamps: {
        createdAt: "2026-07-13T00:00:30.000Z",
        updatedAt: "2026-07-13T00:01:30.000Z",
      },
      parentTaskId: "task-parent",
      childTaskIds: [],
    },
    {
      taskId: "task-done",
      label: "Exercise the real HTTP route",
      status: "completed",
      progressSummary: "Real Node server and durable store passed",
      evidenceLinks: [],
      timestamps: {
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:02:00.000Z",
        completedAt: "2026-07-13T00:02:00.000Z",
      },
      childTaskIds: [],
    },
  ],
};

const noop = () => undefined;
const openedTasks: string[] = [];

const meta = {
  title: "Chat/Widgets/OrchestratorTasks",
  component: OrchestratorTaskWidgetView,
  decorators: [
    (Story) => (
      <Sidebar>
        <Story />
      </Sidebar>
    ),
  ],
  args: {
    snapshot,
    loading: false,
    error: null,
    onOpenTask: (taskId) => openedTasks.push(taskId),
    onOpenAll: noop,
    onRetry: noop,
  },
} satisfies Meta<typeof OrchestratorTaskWidgetView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  play: async ({ canvasElement }) => {
    openedTasks.length = 0;
    const widget = await waitForTestId(
      canvasElement,
      "chat-widget-orchestrator-tasks",
    );
    const task = widget.querySelector<HTMLButtonElement>(
      'button[aria-label^="Ship the orchestration rail."]',
    );
    assert(task, "the first live task is an accessible button");
    task.click();
    assert(
      openedTasks[0] === "task-parent",
      "clicking a task opens its exact durable task id",
    );
    assert(widget.textContent?.includes("2 children"), "lineage is rendered");
    assert(
      widget.textContent?.includes("3 of 5"),
      "the display bound is explicit",
    );
  },
};

export const Loading: Story = {
  args: { snapshot: null, loading: true },
};

export const Empty: Story = {
  args: {
    snapshot: { ...snapshot, totalTaskCount: 0, tasks: [] },
  },
};

export const Unavailable: Story = {
  args: {
    snapshot: null,
    error: "Task store unavailable",
  },
};
