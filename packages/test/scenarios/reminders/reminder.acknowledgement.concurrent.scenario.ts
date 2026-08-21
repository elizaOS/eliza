/** Proves concurrent acknowledgements converge on one durable non-terminal acknowledgement state. */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

let taskId: string | null = null;

function captureTaskId(_status: number, body: unknown): string | undefined {
  const task =
    body && typeof body === "object"
      ? (body as { task?: { taskId?: unknown } }).task
      : undefined;
  if (typeof task?.taskId !== "string" || task.taskId.length === 0) {
    return `expected task.taskId, saw ${JSON.stringify(body)}`;
  }
  taskId = task.taskId;
}

async function assertConcurrentAcknowledgement(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  if (!ctx.apiBaseUrl || !taskId)
    return "scenario API base URL or captured task id is unavailable";
  const endpoint = `${ctx.apiBaseUrl}/api/lifeops/scheduled-tasks/${encodeURIComponent(taskId)}/acknowledge`;
  const responses = await Promise.all([
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  ]);
  const statuses = responses.map((response) => response.status);
  if (statuses.some((status) => status !== 200)) {
    return `expected both concurrent acknowledgements to succeed, saw HTTP ${statuses.join(", ")}`;
  }
  const bodies = await Promise.all(
    responses.map((response) => response.json()),
  );
  for (const body of bodies) {
    const task =
      body && typeof body === "object"
        ? (
            body as {
              task?: {
                taskId?: unknown;
                state?: { status?: unknown; acknowledgedAt?: unknown };
              };
            }
          ).task
        : undefined;
    if (
      task?.taskId !== taskId ||
      task.state?.status !== "acknowledged" ||
      typeof task.state.acknowledgedAt !== "string"
    ) {
      return `concurrent acknowledgement returned malformed state: ${JSON.stringify(body)}`;
    }
  }
  const listed = await fetch(
    `${ctx.apiBaseUrl}/api/lifeops/scheduled-tasks?kind=reminder`,
  );
  if (!listed.ok)
    return `durable reminder readback failed with HTTP ${listed.status}`;
  const payload = (await listed.json()) as {
    tasks?: Array<{
      taskId?: string;
      state?: { status?: string; acknowledgedAt?: string };
    }>;
  };
  const matching =
    payload.tasks?.filter((task) => task.taskId === taskId) ?? [];
  if (matching.length !== 1)
    return `expected one durable task after concurrent acknowledgement, saw ${matching.length}`;
  if (
    matching[0]?.state?.status !== "acknowledged" ||
    typeof matching[0]?.state?.acknowledgedAt !== "string"
  ) {
    return `durable acknowledgement state was not preserved: ${JSON.stringify(matching[0])}`;
  }
}

export default scenario({
  id: "reminder.acknowledgement.concurrent",
  title: "Concurrent reminder acknowledgements converge safely",
  domain: "reminders",
  lane: "pr-deterministic",
  evidenceScope: "domain-contract",
  tags: ["pr", "deterministic", "reminders", "concurrency", "acknowledgement"],
  description:
    "Two simultaneous acknowledgement requests target one canonical ScheduledTask. Both requests must observe a valid acknowledgement and durable readback must contain exactly one task in the acknowledged state.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-scheduling"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Concurrent Reminder Ack",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "reset captured acknowledgement task",
      apply: () => {
        taskId = null;
      },
    },
  ],
  turns: [
    {
      kind: "api",
      name: "create reminder for concurrent acknowledgement",
      method: "POST",
      path: "/api/lifeops/scheduled-tasks",
      body: {
        kind: "reminder",
        promptInstructions: "Review the concurrent acknowledgement contract",
        trigger: { kind: "manual" },
        priority: "medium",
        respectsGlobalPause: true,
        source: "user_chat",
        createdBy: "reminder.acknowledgement.concurrent",
        ownerVisible: true,
        idempotencyKey: "scenario:reminder:concurrent-acknowledgement",
      },
      expectedStatus: 201,
      assertResponse: captureTaskId,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "concurrent acknowledgement durable convergence",
      predicate: assertConcurrentAcknowledgement,
    },
  ],
});
