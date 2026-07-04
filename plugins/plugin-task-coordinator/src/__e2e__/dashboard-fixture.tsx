/**
 * Render-only fixture for the redesigned orchestrator dashboard. Mounts the real
 * shared card primitives (TaskListHeader, TaskCard, TaskMetaChip, TaskEmptyState)
 * with deterministic data so the esbuild + playwright harness can screenshot the
 * actual components — no app server, no data layer. The agent-surface hook is
 * stubbed by the runner's esbuild resolver.
 */

import { Bot, ListChecks, Terminal } from "lucide-react";
import { createRoot } from "react-dom/client";
import {
  TaskCard,
  TaskCountChip,
  TaskEmptyState,
  TaskListHeader,
  TaskMetaChip,
} from "../TaskCardList";

const t = (_k: string, v?: Record<string, unknown>) =>
  String(v?.defaultValue ?? _k);

function chips(sessions: number, decisions: number, age: string) {
  return (
    <>
      {sessions > 0 ? (
        <TaskMetaChip icon={<Bot className="h-3 w-3" />}>
          {`${sessions} sessions`}
        </TaskMetaChip>
      ) : null}
      {decisions > 0 ? (
        <TaskMetaChip icon={<ListChecks className="h-3 w-3" />}>
          {`${decisions} decisions`}
        </TaskMetaChip>
      ) : null}
      <TaskMetaChip icon={<Terminal className="h-3 w-3" />}>
        coding
      </TaskMetaChip>
      <span className="text-2xs text-muted/80">{age}</span>
    </>
  );
}

const TASKS = [
  {
    id: "a1",
    title: "Refactor the auth pipeline",
    subtitle: "Collapse the three login paths into one validated entry.",
    status: "active",
    sessions: 2,
    decisions: 5,
    age: "2m ago",
  },
  {
    id: "a2",
    title: "Fix the flaky test suite",
    subtitle: "Reclaim the orphaned pglite port before each batch.",
    status: "validating",
    sessions: 1,
    decisions: 3,
    age: "8m ago",
  },
  {
    id: "a3",
    title: "Wire the x402 earnings binding",
    subtitle: "Record app-scoped payment earnings on settle.",
    status: "waiting_on_user",
    sessions: 1,
    decisions: 1,
    age: "21m ago",
  },
  {
    id: "a4",
    title: "Ship the homepage downloads gate",
    subtitle: "Use the effective release so eliza.app always gets assets.",
    status: "done",
    sessions: 3,
    decisions: 7,
    age: "1h ago",
    forked: true,
  },
  {
    id: "a5",
    title: "Migrate Neon → Railway",
    subtitle: "Cut over DB + cache with parity validation.",
    status: "failed",
    sessions: 2,
    decisions: 4,
    age: "3h ago",
  },
];

function Dashboard() {
  return (
    <div className="relative mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-4">
      <TaskListHeader
        icon={<ListChecks className="h-5 w-5" />}
        title="Orchestrator"
        counts={
          <>
            <TaskCountChip value={5} label="total" />
            <TaskCountChip value={1} label="active" tone="active" />
            <TaskCountChip value={1} label="done" tone="accent" />
          </>
        }
      />
      <div className="flex flex-col gap-2.5">
        {TASKS.map((task) => (
          <TaskCard
            key={task.id}
            id={task.id}
            title={task.title}
            subtitle={task.subtitle}
            status={task.status}
            forked={task.forked}
            chips={chips(task.sessions, task.decisions, task.age)}
            onOpen={() => {}}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

function EmptyDashboard() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-4">
      <TaskListHeader
        icon={<ListChecks className="h-5 w-5" />}
        title="Orchestrator"
        counts={<TaskCountChip value={0} label="total" />}
      />
      <TaskEmptyState
        title="No tasks yet"
        hint="Ask in chat to start a coding task and it will appear here."
      />
    </div>
  );
}

const root = createRoot(document.getElementById("root") as HTMLElement);
const params = new URLSearchParams(window.location.search);
root.render(
  <div data-testid="dashboard-fixture" className="min-h-screen bg-bg text-txt">
    {params.has("empty") ? <EmptyDashboard /> : <Dashboard />}
  </div>,
);
