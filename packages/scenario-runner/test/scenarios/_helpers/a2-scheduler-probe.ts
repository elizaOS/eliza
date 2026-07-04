import type { ScenarioContext } from "@elizaos/scenario-runner/schema";

export type JsonRecord = Record<string, unknown>;

export interface FireEntry {
  taskId: string;
  status: string;
  reason: string;
  occurrenceAtIso?: string;
}

export interface TimeoutEntry {
  taskId: string;
  status: string;
  reason: string;
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

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function futureDateAtUtc(
  hour: number,
  minute: number,
  daysAhead = 5,
): Date {
  const base = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  base.setUTCHours(hour, minute, 0, 0);
  return base;
}

function taskFromBody(body: unknown): JsonRecord | string {
  if (!isRecord(body) || !isRecord(body.task)) {
    return `expected {task} response, saw ${JSON.stringify(body)}`;
  }
  return body.task;
}

function taskState(task: JsonRecord): JsonRecord | string {
  if (!isRecord(task.state)) {
    return `expected task.state object, saw ${JSON.stringify(task.state)}`;
  }
  return task.state;
}

function taskListFromBody(body: unknown): JsonRecord[] | string {
  if (!isRecord(body) || !Array.isArray(body.tasks)) {
    return `expected {tasks[]} response, saw ${JSON.stringify(body)}`;
  }
  const tasks: JsonRecord[] = [];
  for (const task of body.tasks) {
    if (!isRecord(task)) {
      return `expected task object in list, saw ${JSON.stringify(task)}`;
    }
    tasks.push(task);
  }
  return tasks;
}

function readFires(body: unknown): FireEntry[] | string {
  if (!isRecord(body) || body.success !== true) {
    return `expected tick success=true, saw ${JSON.stringify(body)}`;
  }
  const raw = body.scheduledTaskFires;
  if (!Array.isArray(raw)) return "expected scheduledTaskFires array";
  const fires: FireEntry[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.taskId !== "string" ||
      typeof entry.status !== "string" ||
      typeof entry.reason !== "string"
    ) {
      return `malformed scheduledTaskFires entry: ${JSON.stringify(entry)}`;
    }
    fires.push({
      taskId: entry.taskId,
      status: entry.status,
      reason: entry.reason,
      ...(typeof entry.occurrenceAtIso === "string"
        ? { occurrenceAtIso: entry.occurrenceAtIso }
        : {}),
    });
  }
  return fires;
}

function readCompletionTimeouts(body: unknown): TimeoutEntry[] | string {
  if (!isRecord(body) || body.success !== true) {
    return `expected tick success=true, saw ${JSON.stringify(body)}`;
  }
  const raw = body.scheduledTaskCompletionTimeouts;
  if (!Array.isArray(raw)) {
    return "expected scheduledTaskCompletionTimeouts array";
  }
  const timeouts: TimeoutEntry[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.taskId !== "string" ||
      typeof entry.status !== "string" ||
      typeof entry.reason !== "string"
    ) {
      return `malformed scheduledTaskCompletionTimeouts entry: ${JSON.stringify(entry)}`;
    }
    timeouts.push({
      taskId: entry.taskId,
      status: entry.status,
      reason: entry.reason,
    });
  }
  return timeouts;
}

export function makeA2SchedulerProbe(opts: {
  scenarioId: string;
  channelKind: string;
}) {
  const taskIds = new Map<string, string>();
  const deliveryLedger: unknown[] = [];

  function taskId(slot: string): string {
    const id = taskIds.get(slot);
    return typeof id === "string" && id.length > 0
      ? id
      : `task id slot "${slot}" was not captured`;
  }

  function seedChannel(ctx: ScenarioContext): string | undefined {
    taskIds.clear();
    deliveryLedger.length = 0;

    const runtime = ctx.runtime as RuntimeLike;
    const registry = runtime.channelRegistry;
    if (!registry || typeof registry.register !== "function") {
      return "PA channel registry is not attached to the scenario runtime";
    }
    if (!registry.get(opts.channelKind)) {
      registry.register({
        kind: opts.channelKind,
        describe: { label: `${opts.scenarioId} delivery probe` },
        capabilities: {
          send: true,
          read: false,
          reminders: true,
          voice: false,
          attachments: false,
          quietHoursAware: false,
        },
        async send(payload: unknown): Promise<{ ok: true; messageId: string }> {
          deliveryLedger.push(payload);
          return {
            ok: true,
            messageId: `${opts.scenarioId}-delivery-${deliveryLedger.length}`,
          };
        },
      });
    }

    return undefined;
  }

  function captureTaskId(slot: string) {
    return (_status: number, body: unknown): string | undefined => {
      const task = taskFromBody(body);
      if (typeof task === "string") return task;
      if (typeof task.taskId !== "string" || task.taskId.length === 0) {
        return `expected task.taskId string, saw ${JSON.stringify(task.taskId)}`;
      }
      taskIds.set(slot, task.taskId);
      return undefined;
    };
  }

  function assertTaskStatus(
    expectedStatus: string,
    opts?: { lastDecisionIncludes?: string },
  ) {
    return (_status: number, body: unknown): string | undefined => {
      const task = taskFromBody(body);
      if (typeof task === "string") return task;
      const state = taskState(task);
      if (typeof state === "string") return state;
      if (state.status !== expectedStatus) {
        return `expected task status ${expectedStatus}, saw ${String(state.status)}`;
      }
      if (
        opts?.lastDecisionIncludes &&
        !String(state.lastDecisionLog ?? "").includes(opts.lastDecisionIncludes)
      ) {
        return `expected lastDecisionLog to include "${opts.lastDecisionIncludes}", saw ${String(state.lastDecisionLog ?? "")}`;
      }
      return undefined;
    };
  }

  function firesForSlot(body: unknown, slot: string): FireEntry[] | string {
    const id = taskId(slot);
    if (id.startsWith("task id slot")) return id;
    const fires = readFires(body);
    if (typeof fires === "string") return fires;
    return fires.filter((fire) => fire.taskId === id);
  }

  function assertNoFire(slot: string) {
    return (_status: number, body: unknown): string | undefined => {
      const fires = firesForSlot(body, slot);
      if (typeof fires === "string") return fires;
      const fired = fires.filter((fire) => fire.status === "fired");
      if (fired.length > 0) {
        return `expected ${slot} not to fire, saw ${JSON.stringify(fired)}`;
      }
      return undefined;
    };
  }

  function assertFiredOnce(slot: string, reasonIncludes?: string) {
    return (_status: number, body: unknown): string | undefined => {
      const fires = firesForSlot(body, slot);
      if (typeof fires === "string") return fires;
      if (fires.length !== 1 || fires[0]?.status !== "fired") {
        return `expected exactly one fired entry for ${slot}, saw ${JSON.stringify(fires)}`;
      }
      if (reasonIncludes && !String(fires[0].reason).includes(reasonIncludes)) {
        return `expected ${slot} fire reason to include "${reasonIncludes}", saw ${fires[0].reason}`;
      }
      return undefined;
    };
  }

  function assertCompletionTimeout(
    slot: string,
    expectedStatus: string,
    reasonIncludes?: string,
  ) {
    return (_status: number, body: unknown): string | undefined => {
      const id = taskId(slot);
      if (id.startsWith("task id slot")) return id;
      const timeouts = readCompletionTimeouts(body);
      if (typeof timeouts === "string") return timeouts;
      const matches = timeouts.filter((entry) => entry.taskId === id);
      if (matches.length !== 1 || matches[0]?.status !== expectedStatus) {
        return `expected one ${expectedStatus} completion timeout for ${slot}, saw ${JSON.stringify(matches)}`;
      }
      if (
        reasonIncludes &&
        !String(matches[0].reason).includes(reasonIncludes)
      ) {
        return `expected timeout reason to include "${reasonIncludes}", saw ${matches[0].reason}`;
      }
      return undefined;
    };
  }

  function assertPipelineChild(
    parentSlot: string,
    requiredPromptParts: string[],
  ) {
    return (_status: number, body: unknown): string | undefined => {
      const parentId = taskId(parentSlot);
      if (parentId.startsWith("task id slot")) return parentId;
      const tasks = taskListFromBody(body);
      if (typeof tasks === "string") return tasks;
      const child = tasks.find((task) => {
        const state = isRecord(task.state) ? task.state : {};
        return (
          state.pipelineParentId === parentId &&
          requiredPromptParts.every((part) =>
            String(task.promptInstructions ?? "")
              .toLowerCase()
              .includes(part.toLowerCase()),
          )
        );
      });
      if (!child) {
        return `expected pipeline child from ${parentId} with prompt parts ${JSON.stringify(requiredPromptParts)}, saw ${JSON.stringify(
          tasks.map((task) => ({
            taskId: task.taskId,
            parent: isRecord(task.state) ? task.state.pipelineParentId : null,
            promptInstructions: task.promptInstructions,
          })),
        )}`;
      }
      return undefined;
    };
  }

  function assertNoPipelineChild(parentSlot: string) {
    return (_status: number, body: unknown): string | undefined => {
      const parentId = taskId(parentSlot);
      if (parentId.startsWith("task id slot")) return parentId;
      const tasks = taskListFromBody(body);
      if (typeof tasks === "string") return tasks;
      const child = tasks.find((task) => {
        const state = isRecord(task.state) ? task.state : {};
        return state.pipelineParentId === parentId;
      });
      if (child) {
        return `expected no pipeline child from ${parentId}, saw ${JSON.stringify(child)}`;
      }
      return undefined;
    };
  }

  function assertListedTask(slot: string, expectedStatus?: string) {
    return (_status: number, body: unknown): string | undefined => {
      const id = taskId(slot);
      if (id.startsWith("task id slot")) return id;
      const tasks = taskListFromBody(body);
      if (typeof tasks === "string") return tasks;
      const task = tasks.find((candidate) => candidate.taskId === id);
      if (!task) {
        return `expected task ${id} to remain listed, saw ${JSON.stringify(
          tasks.map((candidate) => candidate.taskId),
        )}`;
      }
      if (expectedStatus) {
        const state = taskState(task);
        if (typeof state === "string") return state;
        if (state.status !== expectedStatus) {
          return `expected listed task ${id} status ${expectedStatus}, saw ${String(state.status)}`;
        }
      }
      return undefined;
    };
  }

  function assertDeliveryCount(expectedCount: number) {
    return (): string | undefined => {
      if (deliveryLedger.length !== expectedCount) {
        return `expected ${expectedCount} delivery event(s), saw ${deliveryLedger.length}`;
      }
      return undefined;
    };
  }

  function assertDeliveryIncludes(requiredParts: string[]) {
    return (): string | undefined => {
      const haystack = JSON.stringify(deliveryLedger).toLowerCase();
      const missing = requiredParts.filter(
        (part) => !haystack.includes(part.toLowerCase()),
      );
      if (missing.length > 0) {
        return `delivery ledger missing ${JSON.stringify(missing)} in ${JSON.stringify(deliveryLedger)}`;
      }
      return undefined;
    };
  }

  return {
    deliveryLedger,
    seedChannel,
    captureTaskId,
    assertTaskStatus,
    assertNoFire,
    assertFiredOnce,
    assertCompletionTimeout,
    assertPipelineChild,
    assertNoPipelineChild,
    assertListedTask,
    assertDeliveryCount,
    assertDeliveryIncludes,
  };
}
