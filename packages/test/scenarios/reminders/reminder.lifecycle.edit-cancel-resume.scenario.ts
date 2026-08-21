/** Exercises edit, terminal dismissal, and reopen against one durable canonical ScheduledTask record. */

import { scenario } from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function assertTask(expected: {
  status: string;
  priority: string;
  promptInstructions: string;
}) {
  return (_status: number, body: unknown): string | undefined => {
    const task = record(record(body)?.task);
    const state = record(task?.state);
    if (!task || !state)
      return `expected {task:{state}}, saw ${JSON.stringify(body)}`;
    if (state.status !== expected.status) {
      return `expected state.status=${expected.status}, saw ${String(state.status)}`;
    }
    if (task.priority !== expected.priority) {
      return `expected priority=${expected.priority}, saw ${String(task.priority)}`;
    }
    if (task.promptInstructions !== expected.promptInstructions) {
      return `expected exact reminder text ${JSON.stringify(expected.promptInstructions)}, saw ${JSON.stringify(task.promptInstructions)}`;
    }
  };
}

const ORIGINAL = "Submit the production readiness packet";
const EDITED = "Submit the reviewed production readiness packet";

export default scenario({
  id: "reminder.lifecycle.edit-cancel-resume",
  title: "Reminder edit, cancel, and resume preserve one durable record",
  domain: "reminders",
  lane: "pr-deterministic",
  evidenceScope: "domain-contract",
  tags: ["pr", "deterministic", "reminders", "lifecycle", "durable-readback"],
  description:
    "Creates one canonical ScheduledTask, edits it in place, dismisses it as the supported terminal cancel operation, reopens it within the lifecycle window, and reads back the same task id and edited payload.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-scheduling"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Reminder Lifecycle",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "create reminder lifecycle record",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: ORIGINAL,
        trigger: { kind: "manual" },
        priority: "medium",
        respectsGlobalPause: true,
        source: "user_chat",
        createdBy: "reminder.lifecycle.edit-cancel-resume",
        ownerVisible: true,
        idempotencyKey: "scenario:reminder:lifecycle:edit-cancel-resume",
      },
      expectedStatus: 201,
      captures: { taskId: "task.taskId" },
      assertResponse: assertTask({
        status: "scheduled",
        priority: "medium",
        promptInstructions: ORIGINAL,
      }),
    },
    {
      kind: "api",
      name: "edit reminder in place",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks/{{capture:taskId}}/edit",
      body: { promptInstructions: EDITED, priority: "high" },
      expectedStatus: 200,
      assertResponse: assertTask({
        status: "scheduled",
        priority: "high",
        promptInstructions: EDITED,
      }),
    },
    {
      kind: "api",
      name: "cancel reminder through terminal dismiss",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks/{{capture:taskId}}/dismiss",
      body: { reason: "owner cancelled before delivery" },
      expectedStatus: 200,
      assertResponse: assertTask({
        status: "dismissed",
        priority: "high",
        promptInstructions: EDITED,
      }),
    },
    {
      kind: "api",
      name: "resume cancelled reminder",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks/{{capture:taskId}}/reopen",
      body: { reason: "owner resumed the edited reminder" },
      expectedStatus: 200,
      assertResponse: assertTask({
        status: "scheduled",
        priority: "high",
        promptInstructions: EDITED,
      }),
    },
    {
      kind: "api",
      name: "read durable resumed reminder",
      method: "GET",
      path: "/api/lifeops/scheduled-tasks?kind=reminder",
      expectedStatus: 200,
      assertResponse: (_status, body) => {
        const tasks = record(body)?.tasks;
        if (!Array.isArray(tasks)) return "expected tasks array";
        const matching = tasks.filter(
          (task) =>
            record(task)?.idempotencyKey ===
            "scenario:reminder:lifecycle:edit-cancel-resume",
        );
        if (matching.length !== 1)
          return `expected exactly one lifecycle task, saw ${matching.length}`;
        const task = record(matching[0]);
        const state = record(task?.state);
        if (
          task?.promptInstructions !== EDITED ||
          task.priority !== "high" ||
          state?.status !== "scheduled"
        ) {
          return `durable readback did not preserve edited reopened state: ${JSON.stringify(task)}`;
        }
      },
    },
  ],
});
