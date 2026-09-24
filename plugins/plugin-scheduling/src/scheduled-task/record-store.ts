/**
 * Persists scheduling records and receipts in the runtime adapter's own database.
 * Every read/claim/mutation uses its durable transaction capability; no resident
 * map is an authority and PostgreSQL migrations are never reported as applied.
 */
import {
  type DurableRecordStore,
  ElizaError,
  type IAgentRuntime,
  stableStringify,
} from "@elizaos/core";
import type { ScheduledTaskDefinition, ScheduledTaskStore } from "./runner.js";
import type { ScheduledTaskLogStore } from "./state-log.js";
import type { ScheduledTask, ScheduledTaskLogEntry } from "./types.js";

const TASKS = "plugin_scheduling_tasks_v1";
const LOGS = "plugin_scheduling_logs_v1";
const SCHEMA = "plugin_scheduling_schema";
interface TaskRecord {
  task: ScheduledTask;
  nextFireAtIso: string | null;
  createdAtIso: string;
  updatedAtIso: string;
  revision: number;
  transferStatus: string | null;
}
function failure(message: string): ElizaError {
  return new ElizaError(message, { code: "SCHEDULING_RECORD_STORE_INVALID" });
}
function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  throw failure(
    "Scheduling receipt, intent and transfer metadata must be an object when present",
  );
}

function reserved(task: ScheduledTask): boolean {
  return object(task.metadata?.sharedCutoverImport).status === "reserved";
}
function projected(row: TaskRecord): ScheduledTask {
  const task = structuredClone(row.task);
  task.metadata = {
    ...task.metadata,
    createdAtIso:
      typeof task.metadata?.createdAtIso === "string"
        ? task.metadata.createdAtIso
        : row.createdAtIso,
  };
  return task;
}

interface AdmissionExpectation {
  expectedState?: ScheduledTask["state"];
  expectedMetadata?: NonNullable<ScheduledTask["metadata"]>;
  expectedDefinition?: ScheduledTaskDefinition;
}

function definition(task: ScheduledTaskDefinition): ScheduledTaskDefinition {
  return {
    taskId: task.taskId,
    kind: task.kind,
    promptInstructions: task.promptInstructions,
    contextRequest: task.contextRequest,
    trigger: task.trigger,
    priority: task.priority,
    shouldFire: task.shouldFire,
    completionCheck: task.completionCheck,
    escalation: task.escalation,
    output: task.output,
    pipeline: task.pipeline,
    subject: task.subject,
    idempotencyKey: task.idempotencyKey,
    respectsGlobalPause: task.respectsGlobalPause,
    source: task.source,
    createdBy: task.createdBy,
    ownerVisible: task.ownerVisible,
    executionProfile: task.executionProfile,
  };
}

/** Compare the same projected record callers read, including its creation timestamp. */
function matchesExpectation(
  row: TaskRecord,
  expected: AdmissionExpectation,
): boolean {
  const task = projected(row);
  return (
    (expected.expectedState === undefined ||
      stableStringify(task.state) ===
        stableStringify(expected.expectedState)) &&
    (expected.expectedMetadata === undefined ||
      stableStringify(task.metadata ?? {}) ===
        stableStringify(expected.expectedMetadata)) &&
    (expected.expectedDefinition === undefined ||
      stableStringify(definition(task)) ===
        stableStringify(definition(expected.expectedDefinition)))
  );
}

function mutationRaced(taskId: string): ElizaError {
  return new ElizaError(
    "Scheduled task changed before the mutation committed; retry against the current task",
    {
      code: "SCHEDULED_TASK_MUTATION_RACED",
      context: { taskId, retryable: true },
    },
  );
}

export function getSchedulingRecordStore(
  runtime: IAgentRuntime,
): DurableRecordStore | null {
  const store = runtime.adapter?.recordStore;
  if (!store) return null;
  if (store.version !== 1 || store.agentId !== runtime.agentId)
    throw failure(
      "Scheduling requires an agent-bound version 1 durable record store",
    );
  return store;
}

export async function ensureSchedulingRecordSchema(
  storage: DurableRecordStore,
): Promise<void> {
  await storage.transaction(async () => {
    const version = await storage.get<number>(SCHEMA, "version");
    if (version !== null && version !== 1)
      throw failure("Scheduling record schema requires an explicit migration");
    if (version === null) await storage.set(SCHEMA, "version", 1);
  });
}

export function createSchedulingRecordStores(
  storage: DurableRecordStore,
  agentId: string,
): { store: ScheduledTaskStore; logStore: ScheduledTaskLogStore } {
  if (storage.version !== 1 || storage.agentId !== agentId)
    throw failure(
      "Scheduling record store belongs to another agent or unsupported version",
    );
  const transaction = <T>(operation: () => Promise<T>): Promise<T> =>
    storage.transaction(async () => {
      const version = await storage.get<number>(SCHEMA, "version");
      if (version !== null && version !== 1)
        throw failure(
          "Scheduling record schema requires an explicit migration",
        );
      if (version === null) await storage.set(SCHEMA, "version", 1);
      return operation();
    });
  const assertLog = (entry: ScheduledTaskLogEntry) => {
    if (entry.agentId !== agentId)
      throw failure("Scheduling log targets another agent");
  };
  const write = async (
    task: ScheduledTask,
    nextFireAtIso: string | null | undefined,
    existing: TaskRecord | null,
  ) => {
    const now = new Date().toISOString();
    if (task.idempotencyKey) {
      const duplicate = (await storage.getAll<TaskRecord>(TASKS)).find(
        (row) =>
          row.task.taskId !== task.taskId &&
          row.task.idempotencyKey === task.idempotencyKey,
      );
      if (duplicate)
        throw failure("Scheduling idempotency key belongs to another task");
    }
    const row: TaskRecord = {
      task: structuredClone(task),
      nextFireAtIso: nextFireAtIso || null,
      createdAtIso: existing?.createdAtIso ?? now,
      updatedAtIso: now,
      revision: (existing?.revision ?? 0) + 1,
      transferStatus: existing?.transferStatus ?? null,
    };
    await storage.set(TASKS, task.taskId, row);
    return row;
  };
  const store: ScheduledTaskStore = {
    upsert: (task, options) =>
      transaction(async () => {
        const existing = await storage.get<TaskRecord>(TASKS, task.taskId);
        if (existing?.transferStatus)
          throw failure("Transferred scheduling rows cannot be overwritten");
        await write(task, options?.nextFireAtIso, existing);
      }),
    upsertIfStatus: (task, options) =>
      transaction(async () => {
        const existing = await storage.get<TaskRecord>(TASKS, task.taskId);
        if (
          !existing ||
          existing.transferStatus ||
          existing.task.state.status !== options.expectedStatus ||
          !matchesExpectation(existing, options)
        )
          return false;
        await write(task, options.nextFireAtIso, existing);
        return true;
      }),
    claimForFire: (args) =>
      transaction(async () => {
        if (
          args.claimedMetadata !== undefined &&
          (args.expectedState === undefined ||
            args.expectedMetadata === undefined ||
            args.expectedDefinition === undefined)
        ) {
          throw new ElizaError(
            "Claim metadata requires the observed state, metadata, and definition",
            {
              code: "SCHEDULED_TASK_CLAIM_EXPECTATION_REQUIRED",
              context: { taskId: args.taskId },
            },
          );
        }
        const existing = await storage.get<TaskRecord>(TASKS, args.taskId);
        if (!existing || existing.transferStatus || reserved(existing.task))
          return { kind: "raced" };
        const task = projected(existing);
        if (!matchesExpectation(existing, args)) return { kind: "raced" };
        if (
          args.expected
            ? task.state.status !== args.expected.status ||
              (task.state.firedAt ?? null) !== args.expected.firedAtIso
            : task.state.status !== "scheduled"
        )
          return { kind: "raced" };
        task.state = {
          ...task.state,
          status: "fired",
          firedAt: args.firedAtIso,
        };
        if (args.claimedMetadata !== undefined)
          task.metadata = structuredClone(args.claimedMetadata);
        return {
          kind: "fired",
          task: projected(await write(task, null, existing)),
        };
      }),
    commitApply: (args) =>
      transaction(async () => {
        assertLog(args.commit);
        if (args.commit.taskId !== args.task.taskId)
          throw failure("Scheduling receipt belongs to another task");
        const existing = await storage.get<TaskRecord>(TASKS, args.task.taskId);
        const guarded =
          args.expectedState !== undefined ||
          args.expectedMetadata !== undefined ||
          args.expectedDefinition !== undefined;
        if (!existing) {
          if (guarded) throw mutationRaced(args.task.taskId);
          throw failure("Cannot commit a receipt for a missing scheduled task");
        }
        const receipts = object(
          existing.task.metadata?.schedulingApplyReceipts,
        );
        const log = await storage.get<ScheduledTaskLogEntry>(
          LOGS,
          args.commit.logId,
        );
        if (Object.hasOwn(receipts, args.receiptKey)) {
          if (
            !log ||
            log.agentId !== agentId ||
            log.taskId !== args.task.taskId ||
            log.detail?.receiptKey !== args.receiptKey
          )
            throw failure(
              "Scheduling receipt marker has no matching durable log",
            );
          return { kind: "replayed", task: projected(existing), commit: log };
        }
        if (
          !matchesExpectation(existing, args) ||
          (guarded && existing.transferStatus)
        )
          throw mutationRaced(args.task.taskId);
        if (existing.transferStatus || log)
          throw failure(
            "Scheduling receipt conflicts with a transfer or existing log",
          );
        const task = structuredClone(args.task);
        task.metadata = {
          ...task.metadata,
          schedulingApplyReceipts: {
            ...receipts,
            [args.receiptKey]:
              object(task.metadata?.schedulingApplyReceipts)[args.receiptKey] ??
              true,
          },
        };
        const committed = await write(task, args.nextFireAtIso, existing);
        if (args.commit.detail?.receiptKey !== args.receiptKey)
          throw failure("Scheduling log must bind the exact receipt key");
        await storage.set(LOGS, args.commit.logId, args.commit);
        return {
          kind: "applied",
          task: projected(committed),
          commit: structuredClone(args.commit),
        };
      }),
    reserveApplyIntent: (args) =>
      transaction(async () => {
        const existing = await storage.get<TaskRecord>(TASKS, args.task.taskId);
        if (!existing)
          throw failure("Cannot reserve intent for a missing scheduled task");
        const intents = object(existing.task.metadata?.schedulingApplyIntents);
        if (Object.hasOwn(intents, args.intentKey))
          return { kind: "replayed", task: projected(existing) };
        if (existing.transferStatus || reserved(existing.task))
          throw failure(
            "Cannot reserve intent while scheduling transfer is pending",
          );
        const task = structuredClone(existing.task);
        task.metadata = {
          ...task.metadata,
          schedulingApplyIntents: {
            ...intents,
            [args.intentKey]:
              object(args.task.metadata?.schedulingApplyIntents)[
                args.intentKey
              ] ?? true,
          },
        };
        return {
          kind: "reserved",
          task: projected(await write(task, existing.nextFireAtIso, existing)),
        };
      }),
    get: (taskId) =>
      transaction(async () => {
        const row = await storage.get<TaskRecord>(TASKS, taskId);
        return row ? projected(row) : null;
      }),
    findByIdempotencyKey: (key) =>
      transaction(async () => {
        const row = (await storage.getAll<TaskRecord>(TASKS)).find(
          (row) => row.task.idempotencyKey === key,
        );
        return row ? projected(row) : null;
      }),
    list: (filter) =>
      transaction(async () => {
        const rows = (await storage.getAll<TaskRecord>(TASKS)).sort(
          (a, b) =>
            a.createdAtIso.localeCompare(b.createdAtIso) ||
            a.task.taskId.localeCompare(b.task.taskId),
        );
        return rows.map(projected).filter((task) => {
          if (filter?.kind && task.kind !== filter.kind) return false;
          if (
            filter?.subject?.kind &&
            task.subject?.kind !== filter.subject.kind
          )
            return false;
          if (filter?.subject?.id && task.subject?.id !== filter.subject.id)
            return false;
          if (filter?.source && task.source !== filter.source) return false;
          if (filter?.ownerVisibleOnly && !task.ownerVisible) return false;
          if (
            filter?.status &&
            !(
              Array.isArray(filter.status) ? filter.status : [filter.status]
            ).includes(task.state.status)
          )
            return false;
          if (
            filter?.firedSince &&
            (!task.state.firedAt || task.state.firedAt < filter.firedSince)
          )
            return false;
          return true;
        });
      }),
    delete: (taskId) =>
      transaction(async () => {
        await storage.delete(TASKS, taskId);
        for (const row of await storage.getAll<ScheduledTaskLogEntry>(LOGS))
          if (row.taskId === taskId) await storage.delete(LOGS, row.logId);
      }),
  };
  const logStore: ScheduledTaskLogStore = {
    append: (entry) =>
      transaction(async () => {
        assertLog(entry);
        if (await storage.get(LOGS, entry.logId))
          throw failure("Scheduling log identity already exists");
        await storage.set(LOGS, entry.logId, entry);
      }),
    list: (args) =>
      transaction(async () => {
        if (args.agentId !== agentId)
          throw failure("Scheduling log query targets another agent");
        let rows = (await storage.getAll<ScheduledTaskLogEntry>(LOGS))
          .filter(
            (row) =>
              row.taskId === args.taskId &&
              (!args.sinceIso || row.occurredAtIso >= args.sinceIso) &&
              (!args.untilIso || row.occurredAtIso < args.untilIso) &&
              (!args.excludeRollups || !row.rolledUp),
          )
          .sort(
            (a, b) =>
              a.occurredAtIso.localeCompare(b.occurredAtIso) ||
              a.logId.localeCompare(b.logId),
          );
        if (args.limit !== undefined) {
          if (!Number.isSafeInteger(args.limit) || args.limit < 0)
            throw failure("Scheduling log limit must be a nonnegative integer");
          if (args.limit > 0) rows = rows.slice(0, args.limit);
        }
        return rows;
      }),
    rollupOlderThan: (args) =>
      transaction(async () => {
        if (args.agentId !== agentId)
          throw failure("Scheduling maintenance targets another agent");
        const expired = (
          await storage.getAll<ScheduledTaskLogEntry>(LOGS)
        ).filter(
          (row) =>
            (args.taskIds === undefined || args.taskIds.includes(row.taskId)) &&
            !row.rolledUp &&
            row.transition !== "scheduled" &&
            !Object.hasOwn(row.detail ?? {}, "receiptKey") &&
            row.occurredAtIso < args.olderThanIso,
        );
        const groups = new Map<
          string,
          { entry: ScheduledTaskLogEntry; count: number }
        >();
        for (const row of expired) {
          const day = row.occurredAtIso.slice(0, 10);
          const key = JSON.stringify([row.taskId, day, row.transition]);
          const group = groups.get(key);
          if (group) group.count++;
          else
            groups.set(key, {
              entry: {
                ...row,
                logId: `rollup:${key}`,
                occurredAtIso: `${day}T00:00:00.000Z`,
                rolledUp: true,
              },
              count: 1,
            });
        }
        for (const { entry, count } of groups.values()) {
          const previous = await storage.get<ScheduledTaskLogEntry>(
            LOGS,
            entry.logId,
          );
          if (
            previous &&
            (!previous.rolledUp ||
              previous.taskId !== entry.taskId ||
              previous.transition !== entry.transition)
          )
            throw failure(
              "Scheduling rollup identity collides with another log",
            );
          const previousCount = previous?.detail?.rollupCount;
          if (
            previousCount !== undefined &&
            (typeof previousCount !== "number" ||
              !Number.isSafeInteger(previousCount) ||
              previousCount < 0)
          )
            throw failure("Scheduling rollup count is corrupt");
          await storage.set(LOGS, entry.logId, {
            ...entry,
            detail: {
              rollupCount:
                count + (typeof previousCount === "number" ? previousCount : 0),
            },
          });
        }
        for (const row of expired) await storage.delete(LOGS, row.logId);
        return { rolledUp: groups.size, deletedRaw: expired.length };
      }),
  };
  return { store, logStore };
}
