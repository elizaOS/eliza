/**
 * Shared scaffolding for the elderly week-1 loop structural scenarios
 * (`elderly-week1-*`). These scenarios drive the REAL LifeOps ScheduledTask
 * spine — create through the REST surface, fire/timeout through logical-clock
 * ticks — and assert STRUCTURAL outcomes read back off the persisted store, the
 * same seams the low-activation packs exercise. Nothing here branches on
 * `promptInstructions`; the runner keys only on structural fields.
 *
 * A scenario-owned delivery channel is registered so a fired task has a real
 * surface to accept the dispatch (without one the fire honestly defers as
 * `dispatch_deferred(disconnected)` and never reaches `fired`, so the
 * completion-timeout pass would have nothing to time out).
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";

export type JsonRecord = Record<string, unknown>;

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A UTC instant `daysAhead` in the future at the given wall-clock time. All
 * ticks are far in the future so ONLY the injected `now` decides dueness, and
 * UTC keeps the window math host-timezone independent (run under `TZ=UTC`).
 */
export function futureUtc(
  hour: number,
  minute: number,
  daysAhead: number,
): Date {
  const base = new Date(Date.now() + daysAhead * DAY_MS);
  base.setUTCHours(hour, minute, 0, 0);
  return base;
}

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface ChannelContributionLike {
  kind: string;
  describe: { label: string };
  capabilities: {
    send: boolean;
    read: boolean;
    reminders: boolean;
    voice: boolean;
    attachments: boolean;
    quietHoursAware: boolean;
  };
  send?(payload: unknown): Promise<{ ok: true; messageId: string }>;
}

interface ChannelRegistryLike {
  register(contribution: ChannelContributionLike): void;
  get(kind: string): ChannelContributionLike | null;
}

interface RuntimeLike {
  channelRegistry?: ChannelRegistryLike;
}

/**
 * Register (idempotently) an always-delivering probe channel and clear the
 * per-run delivery ledger. Callers pass a stable `channelKind` and the shared
 * ledger array so `output.target = "<channelKind>:owner"` has somewhere to land.
 */
export function registerDeliveryChannel(
  ctx: ScenarioContext,
  channelKind: string,
  ledger: unknown[],
): string | undefined {
  ledger.length = 0;
  const registry = (ctx.runtime as RuntimeLike).channelRegistry;
  if (!registry || typeof registry.register !== "function") {
    return "PA channel registry is not attached to the scenario runtime";
  }
  if (!registry.get(channelKind)) {
    registry.register({
      kind: channelKind,
      describe: { label: `Elderly week-1 delivery probe (${channelKind})` },
      capabilities: {
        send: true,
        read: false,
        reminders: true,
        voice: false,
        attachments: false,
        quietHoursAware: false,
      },
      async send(payload: unknown): Promise<{ ok: true; messageId: string }> {
        ledger.push(payload);
        return {
          ok: true,
          messageId: `${channelKind}-delivered-${ledger.length}`,
        };
      },
    });
  }
  return undefined;
}

export interface TickEntry {
  taskId: string;
  status: string;
  reason: string;
  occurrenceAtIso?: string;
}

function parseEntries(value: unknown, taskId: string | null): TickEntry[] {
  return (Array.isArray(value) ? value : [])
    .filter(isRecord)
    .filter((entry) => taskId === null || entry.taskId === taskId)
    .map((entry) => ({
      taskId: String(entry.taskId),
      status: String(entry.status),
      reason: typeof entry.reason === "string" ? entry.reason : "",
      ...(typeof entry.occurrenceAtIso === "string"
        ? { occurrenceAtIso: entry.occurrenceAtIso }
        : {}),
    }));
}

/**
 * Split a scheduler tick body into the fires and completion-timeouts recorded
 * for one task (or all tasks when `taskId` is null). Returns the failure string
 * when the tick itself did not succeed.
 */
export function readTick(
  body: unknown,
  taskId: string | null,
): { fires: TickEntry[]; timeouts: TickEntry[] } | string {
  if (!isRecord(body) || body.success !== true) {
    return `expected tick success=true, saw ${JSON.stringify(body)}`;
  }
  const failures = Array.isArray(body.subsystemFailures)
    ? body.subsystemFailures.filter(isRecord)
    : [];
  const scheduledFailure = failures.find(
    (failure) => failure.subsystem === "scheduled_tasks",
  );
  if (scheduledFailure) {
    return `scheduled_tasks subsystem failed: ${JSON.stringify(scheduledFailure)}`;
  }
  return {
    fires: parseEntries(body.scheduledTaskFires, taskId),
    timeouts: parseEntries(body.scheduledTaskCompletionTimeouts, taskId),
  };
}

/**
 * Capture the created task id from a `POST /scheduled-tasks` (201) body into a
 * caller-owned slot — `assertResponse` receives only `(status, body)`, so the
 * id has to live in module state that the create turn writes and later turns
 * read (the same pattern the persona-scheduling proofs use).
 */
export function captureTaskId(slot: {
  id: string | null;
}): (status: number, body: unknown) => string | undefined {
  return (_status: number, body: unknown): string | undefined => {
    if (!isRecord(body) || !isRecord(body.task)) {
      return `expected {task} response, saw ${JSON.stringify(body)}`;
    }
    const task = body.task;
    if (typeof task.taskId !== "string" || task.taskId.length === 0) {
      return `expected task.taskId string, saw ${JSON.stringify(task.taskId)}`;
    }
    slot.id = task.taskId;
    return undefined;
  };
}

/** Find a task by id in a `GET /scheduled-tasks` (`{tasks[]}`) body. */
export function findTask(
  body: unknown,
  taskId: string | null,
): JsonRecord | string {
  if (!isRecord(body) || !Array.isArray(body.tasks)) {
    return `expected {tasks[]} response, saw ${JSON.stringify(body)}`;
  }
  const task = body.tasks.find((t) => isRecord(t) && t.taskId === taskId);
  return isRecord(task) ? task : `task ${taskId} not found in list`;
}

/** Read the `metadata.noReplyState` record off a persisted task, or a message. */
export function noReplyState(task: JsonRecord): JsonRecord | string {
  const metadata = isRecord(task.metadata) ? task.metadata : null;
  const state = isRecord(metadata?.noReplyState) ? metadata.noReplyState : null;
  return (
    state ??
    `expected metadata.noReplyState, saw ${JSON.stringify(task.metadata)}`
  );
}
