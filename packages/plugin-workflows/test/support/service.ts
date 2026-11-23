// spec/workflow/admission.md, "Story: Run the version I reviewed and recover an ambiguous response"; spec/workflow/lifecycle.md, "Story: Remove a workflow only when its runs are settled and restore it safely"; spec/workflow/execution.md, "Story: Recover a parked workflow without creating a second execution"; spec/workflow/approvals.md, "Story: Decide one reviewed approval once and run its device step only as reviewed"
import { PGlite } from "@electric-sql/pglite";
import { computeNextCronRunAtMs } from "@elizaos/core";
import { Effect } from "effect";
import type { Driver as ConformanceDriver } from "../../gen/_conformance.ts";
import { openWorkflows, type WorkflowService } from "../../src/service/workflows.vibe";
import type { WorkflowHost } from "../../src/service/host.vibe";

interface OpenedService {
  readonly service: WorkflowService;
  close(): Promise<void>;
}

async function openDriverService(): Promise<OpenedService> {
  const db = new PGlite();
  const wakeups = new Map<string, number>();
  const host: WorkflowHost = {
    sql: { transaction: (work) => db.transaction((tx) => work(tx)) },
    owner: "owner", agentId: "agent", origin: "agent:conformance",
    worker: undefined, device: undefined, draft: undefined, nativeDigests: undefined, google: undefined,
    notify: () => Effect.void,
    scheduler: {
      set: (key, dueAt) => Effect.sync(() => { wakeups.set(key, dueAt); }),
      clear: (key) => Effect.sync(() => { wakeups.delete(key); }),
      keys: Effect.sync(() => [...wakeups.keys()]),
    },
    nextCron: (expression, after, timeZone) => computeNextCronRunAtMs(expression, after, timeZone) ?? undefined,
    processStartedAt: 0,
  };
  const service = await Effect.runPromise(openWorkflows(host));
  return { service, close: () => db.close() };
}

interface WorkflowDriverDefinition<Event, View> {
  readonly step: (event: Event, actor: string) => Effect.Effect<unknown, { readonly _tag: string }>;
  readonly observe: () => Effect.Effect<View, unknown>;
}

interface WorkflowDriverSetup<Event, View> {
  readonly namespace: string;
  readonly bind: (service: WorkflowService, id: string) => WorkflowDriverDefinition<Event, View>;
}

export function workflowDriver<Event, View>({ namespace, bind }: WorkflowDriverSetup<Event, View>) {
  let opened: Promise<OpenedService> | undefined;
  let generation = 0;
  const definitions = new Map<string, Promise<WorkflowDriverDefinition<Event, View>>>();

  function definition(key: string) {
    const existing = definitions.get(key);
    if (existing !== undefined) return existing;
    const id = `${namespace}-${generation}-${key}`;
    const bound = (opened ??= openDriverService()).then(({ service }) => bind(service, id));
    definitions.set(key, bound);
    return bound;
  }

  const driver: ConformanceDriver<Event, View> & AsyncDisposable = {
    reset() {
      generation += 1;
      definitions.clear();
    },
    async dispatch(key, event, by) {
      const { step } = await definition(key);
      return outcome(step(event, typeof by === "string" ? by : ""));
    },
    async observe(key) {
      const { observe } = await definition(key);
      return Effect.runPromise(observe());
    },
    async [Symbol.asyncDispose]() {
      const done = opened;
      opened = undefined;
      definitions.clear();
      if (done !== undefined) await (await done).close();
    },
  };
  return { driver, options: { keys: ["a", "b"] } };
}

export async function outcome<A>(step: Effect.Effect<A, { readonly _tag: string }>): Promise<"accepted" | "refused"> {
  const result = await Effect.runPromise(Effect.result(step));
  if (result._tag === "Success") return "accepted";
  if (result.failure._tag === "Rejected") return "refused";
  throw new Error(`The shell failed a step: ${result.failure._tag}`);
}
