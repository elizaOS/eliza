// spec/agent/schedule/triggers.md, "Story: Run a trigger now or on schedule without losing my edits"; spec/agent/schedule/triggers.md, "Story: Deliver a prompt only to the conversation I chose"
import { Clock, Effect } from "effect";
import type { IDatabaseAdapter, UUID } from "@elizaos/core";
import type { Driver, Options } from "../../gen/agent__schedule__triggers.conformance.ts";
import type { Event, RunOutcome, Trigger, TriggerType } from "../../gen/agent__schedule__triggers.ts";
import type { Delivery } from "../../src/schedule/trigger-delivery.vibe";
import type { TriggerDraft, TriggerTiming } from "../../src/schedule/trigger-routes.vibe";
import { promptTriggers, type Fired, type PromptTriggers, type ScheduleFacts, type TriggerHost } from "../../src/schedule/triggers.vibe";
import { openDeviceStorage } from "../../src/storage/index.vibe";
import { scratchDirectory, type Scratch } from "../support/scratch.ts";

type Observed =
  | { readonly life: "Unsaved" }
  | { readonly life: "Removed"; readonly running: boolean }
  | Omit<Trigger, "now">;

interface Sql {
  query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

const cronExpression = "0 * * * *";
const cancelled: Delivery = { kind: "Turn", turn: "Cancelled", reason: "aborted" };

let now = 0;
const clock: Clock.Clock = {
  currentTimeMillisUnsafe: () => now,
  currentTimeMillis: Effect.sync(() => now),
  currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
  monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
  sleep: () => Effect.void,
};

const facts = { processStartedAt: 0, next: 0 };
const scheduleFacts: ScheduleFacts = {
  get processStartedAt() { return facts.processStartedAt; },
  nextInstant: () => facts.next,
};

const rooms = { exists: true, fallback: "" };
const takers = new Map<string, (delivery: Delivery) => void>();

let opened: { readonly scratch: Scratch; readonly adapter: IDatabaseAdapter; readonly agentId: UUID } | undefined;
let triggers: PromptTriggers | undefined;
const ids = new Map<string, string>();
const started = new Set<string>();

const run = <A>(work: Effect.Effect<A>): Promise<A> => Effect.runPromise(Effect.provideService(work, Clock.Clock, clock));

async function sql<R>(text: string, params: unknown[] = []): Promise<R[]> {
  const adapter = opened!.adapter;
  return await adapter.transaction(async (tx) => (((await tx.getConnection()) as Sql).query<R>(text, params)).then((found) => found.rows));
}

async function store(): Promise<IDatabaseAdapter> {
  if (opened === undefined) {
    const scratch = await scratchDirectory("triggers-driver");
    const { adapter, agentId } = await openDeviceStorage({ stateDirectory: scratch.file("memory"), persistMemory: false, account: null, embeddingDimensions: 0 });
    opened = { scratch, adapter, agentId };
  }
  return opened.adapter;
}

function hostOver(adapter: IDatabaseAdapter): TriggerHost {
  return {
    adapter,
    getTasks: (params) => adapter.getTasks({ ...params, agentIds: [opened!.agentId] }),
    createTasks: (tasks) => adapter.createTasks(tasks),
    updateTasks: (updates) => adapter.updateTasks(updates),
    deleteTasks: (taskIds) => adapter.deleteTasks(taskIds),
    registerTaskWorker: () => undefined,
    unregisterTaskWorker: () => true,
  };
}

function service(adapter: IDatabaseAdapter): PromptTriggers {
  return promptTriggers({
    host: hostOver(adapter),
    facts: scheduleFacts,
    listen: () => ({ idle: () => Promise.resolve(), stop: () => Promise.resolve() }),
    delivery: {
      resolveRoom: (requested) => Promise.resolve(
        rooms.exists ? { kind: "Resolved", conversationId: requested ?? rooms.fallback } : { kind: "Missing" },
      ),
      deliver: (_conversationId, _prompt, triggerId, signal) => new Promise<Delivery>((resolve) => {
        if (signal.aborted) return resolve(cancelled);
        signal.addEventListener("abort", () => resolve(cancelled), { once: true });
        takers.set(triggerId, resolve);
      }),
    },
  });
}

function timing(schedule: TriggerType, eventKind: string, at: number): TriggerTiming {
  switch (schedule) {
    case "OnceAt": return { kind: "once", at };
    case "CronSchedule": return { kind: "cron", expression: cronExpression };
    case "OnRuntimeEvent": return { kind: "event", eventKind };
  }
}

function draft(event: Extract<Event, { type: "create" | "edit" }>): TriggerDraft {
  facts.next = event.at;
  rooms.exists = event.roomExists;
  return {
    displayName: "Hourly check-in", instructions: "Summarize what changed", timezone: "UTC",
    timing: timing(event.schedule, event.eventKind, event.at),
    deliveryConversationId: event.requested === "" ? undefined : event.requested,
  };
}

async function activeOthers(count: number) {
  await sql("DELETE FROM schedule_triggers WHERE id LIKE 'filler-%'");
  if (count <= 0) return;
  const state: Trigger = {
    life: "Saved", schedule: "OnRuntimeEvent", enabled: true, revision: 1, room: "filler-room", eventKind: "MESSAGE_RECEIVED",
    nextAt: 0, activity: { tag: "Idle" }, seenEvents: [], history: [], now, lastFiredAt: 0,
  };
  const details = { displayName: "Filler", instructions: "Filler", triggerType: "event", timezone: "UTC", eventKind: "MESSAGE_RECEIVED" };
  await sql(
    "INSERT INTO schedule_triggers (id, revision, data) SELECT 'filler-' || n, 1, $1::jsonb FROM generate_series(1, $2::int) AS n",
    [JSON.stringify({ state, details }), count],
  );
}

async function takerFor(id: string): Promise<((delivery: Delivery) => void) | undefined> {
  for (let waited = 0; waited < 2_000; waited++) {
    const taker = takers.get(id);
    if (taker !== undefined) return taker;
    await Effect.runPromise(Effect.sleep(1));
  }
  return undefined;
}

const firing = (fired: Fired, id: string): "accepted" | "refused" => {
  if (fired === "started") started.add(id);
  return fired === "started" || fired === "missed" ? "accepted" : "refused";
};

async function finishRun(id: string, roomExists: boolean, turn: RunOutcome): Promise<"accepted" | "refused"> {
  if (!started.has(id) || turn === "RoomUnavailable") return "refused";
  const take = await takerFor(id);
  if (take === undefined) throw new Error(`The run of trigger ${id} never reached its delivery`);
  takers.delete(id);
  started.delete(id);
  take(roomExists ? { kind: "Turn", turn } : { kind: "RoomGone" });
  await run(triggers!.idle());
  return "accepted";
}

async function send(key: string, event: Event): Promise<"accepted" | "refused"> {
  const live = triggers!;
  const id = ids.get(key);
  switch (event.type) {
    case "create": {
      if (id !== undefined) return "refused";
      rooms.fallback = event.defaultRoom;
      const written = await run(live.port.create(draft(event)));
      if (written.kind !== "saved") return "refused";
      ids.set(key, written.trigger.id);
      return "accepted";
    }
    case "tick":
      if (event.dt <= 0) return "refused";
      now += event.dt;
      return "accepted";
  }
  if (id === undefined) return "refused";
  switch (event.type) {
    case "edit": return (await run(live.port.edit(id, draft(event), event.expected))).kind === "saved" ? "accepted" : "refused";
    case "remove": return (await run(live.port.remove(id, event.expected))).kind === "removed" ? "accepted" : "refused";
    case "setEnabled": {
      await activeOthers(event.activeOthers);
      facts.next = event.at;
      return (await run(live.port.setEnabled(id, event.on, event.expected))).kind === "saved" ? "accepted" : "refused";
    }
    case "runNow":
    case "receiveEvent":
      return firing(await run(live.startRun(id, event)), id);
    case "fire":
      facts.processStartedAt = event.processStartedAt;
      facts.next = event.nextInstant;
      return firing(await run(live.fire(id)), id);
    case "finishRun": return await finishRun(id, event.roomExists, event.turn);
  }
}

async function observe(key: string): Promise<Observed> {
  const id = ids.get(key);
  if (id === undefined) return { life: "Unsaved" };
  const [row] = await sql<{ data: { state: Trigger } }>("SELECT data FROM schedule_triggers WHERE id = $1", [id]);
  if (row === undefined) return { life: "Removed", running: false };
  const { now: _kept, ...state } = row.data.state;
  return state.life === "Removed" ? { life: "Removed", running: state.activity.tag === "Running" } : state;
}

export const driver: Driver<Observed> & { [Symbol.asyncDispose](): Promise<void> } = {
  async reset() {
    if (triggers !== undefined) await run(triggers.stop());
    const adapter = await store();
    await sql("DELETE FROM schedule_trigger_runs");
    await sql("DELETE FROM schedule_triggers");
    const armed = await adapter.getTasks({ tags: ["prompt-trigger"], agentIds: [opened!.agentId] });
    await adapter.deleteTasks(armed.flatMap((task) => task.id === undefined ? [] : [task.id]));
    now = 0;
    facts.processStartedAt = 0;
    facts.next = 0;
    rooms.exists = true;
    rooms.fallback = "";
    takers.clear();
    ids.clear();
    started.clear();
    triggers = service(adapter);
  },
  dispatch: (key, event) => send(key, event),
  observe,
  async [Symbol.asyncDispose]() {
    if (triggers !== undefined) await run(triggers.stop());
    triggers = undefined;
    const held = opened;
    opened = undefined;
    if (held === undefined) return;
    await held.adapter.close();
    await held.scratch.remove();
  },
};

export const options: Options<Observed> = {
  view: (state) => {
    if (state.life === "Unsaved") return { life: "Unsaved" };
    if (state.life === "Removed") return { life: "Removed", running: state.activity.tag === "Running" };
    const { now: _clock, ...kept } = state;
    return kept;
  },
  keys: ["trigger"],
};
