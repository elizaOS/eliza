// spec/agent/schedule/scheduledTasks.md, "Story: Keep a recurring task exact through retries, races and restarts"
import type { IDatabaseAdapter } from "@elizaos/core";
import { Effect } from "effect";
import type { Driver } from "../../gen/agent__schedule__scheduledTasks.conformance.ts";
import type { Event, ScheduledTask } from "../../gen/agent__schedule__scheduledTasks.ts";
import { scheduledTaskService, type ScheduledTasks } from "../../src/schedule/scheduled-tasks.vibe";
import { getScheduledTask } from "../../src/schedule/store.vibe";
import { openDeviceStorage } from "../../src/storage/index.vibe";
import { scratchDirectory, type Scratch } from "../support/scratch.ts";

const firstInstant = new Date(1).toISOString();

interface Open {
  readonly scratch: Scratch;
  readonly adapter: IDatabaseAdapter;
  readonly tasks: ScheduledTasks;
}

let opened: Promise<Open> | undefined;
let generation = 0;
const rows = new Map<string, string>();

function open(): Promise<Open> {
  opened ??= (async () => {
    const scratch = await scratchDirectory("scheduled-tasks-driver");
    const { adapter } = await openDeviceStorage({ stateDirectory: scratch.path, persistMemory: false, account: null, embeddingDimensions: 0 });
    const tasks = scheduledTaskService({
      adapter, processStart: 0, defaultDelivery: () => Promise.resolve({ kind: "delivered" }),
    });
    return { scratch, adapter, tasks };
  })();
  return opened;
}

async function row(key: string): Promise<{ readonly at: Open; readonly taskId: string }> {
  const at = await open();
  const known = rows.get(key);
  if (known !== undefined) return { at, taskId: known };
  const made = await Effect.runPromise(at.tasks.create({
    kind: "reminder", ownerVisible: true, promptInstructions: `Remind ${key}`,
    trigger: { kind: "once", atIso: firstInstant }, idempotencyKey: `${generation}:${key}`,
  }));
  rows.set(key, made.task.taskId);
  return { at, taskId: made.task.taskId };
}

export const driver: Driver<ScheduledTask> & AsyncDisposable = {
  reset() {
    generation += 1;
    rows.clear();
  },
  async dispatch(key: string, event: Event) {
    const { at, taskId } = await row(key);
    return Effect.runPromise(at.tasks.step(taskId, event).pipe(
      Effect.as("accepted" as const),
      Effect.catchTag("Rejected", () => Effect.succeed("refused" as const)),
    ));
  },
  async observe(key: string) {
    const { at, taskId } = await row(key);
    const stored = await Effect.runPromise(getScheduledTask(at.adapter, taskId));
    if (stored === undefined) throw new Error(`The scheduled task ${taskId} for ${key} is gone`);
    return stored.state;
  },
  async [Symbol.asyncDispose]() {
    const done = opened;
    opened = undefined;
    if (done === undefined) return;
    const { adapter, scratch } = await done;
    await adapter.close();
    await scratch.remove();
  },
};

export const options = { keys: ["a", "b"] };
