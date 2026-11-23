// spec/workflow/admission.md, "Story: Run the version I reviewed and recover an ambiguous response"; spec/workflow/lifecycle.md, "Story: Remove a workflow only when its runs are settled and restore it safely"; spec/workflow/execution.md, "Story: Recover a parked workflow without creating a second execution"; spec/workflow/approvals.md, "Story: Decide one reviewed approval once and run its device step only as reviewed"
import { PGlite } from "@electric-sql/pglite";
import { computeNextCronRunAtMs } from "@elizaos/core";
import { Effect } from "effect";
import { openWorkflows, type WorkflowService } from "../../src/service/workflows.vibe";
import type { WorkflowHost } from "../../src/service/host.vibe";

export interface OpenedService {
  readonly service: WorkflowService;
  close(): Promise<void>;
}

export async function openDriverService(owner = "owner"): Promise<OpenedService> {
  const db = new PGlite();
  const wakeups = new Map<string, number>();
  const host: WorkflowHost = {
    sql: { transaction: (work) => db.transaction((tx) => work(tx)) },
    owner, agentId: "agent", origin: "agent:conformance",
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

export async function outcome<A>(step: Effect.Effect<A, { readonly _tag: string }>): Promise<"accepted" | "refused"> {
  const result = await Effect.runPromise(Effect.result(step));
  if (result._tag === "Success") return "accepted";
  if (result.failure._tag === "Rejected") return "refused";
  throw new Error(`The shell failed a step: ${result.failure._tag}`);
}

export function serviceDriver<E, S>(
  prefix: string,
  step: (service: WorkflowService, id: string, event: E, by: string) => Effect.Effect<unknown, { readonly _tag: string }>,
  state: (service: WorkflowService, id: string) => Effect.Effect<S, unknown>,
) {
  let opened: Promise<OpenedService> | undefined;
  let generation = 0;
  const open = () => (opened ??= openDriverService());
  const id = (key: string) => `${prefix}-${generation}-${key}`;
  return {
    reset() {
      generation += 1;
    },
    async dispatch(key: string, event: E, by?: unknown) {
      const { service } = await open();
      return outcome(step(service, id(key), event, String(by as string | undefined ?? "")));
    },
    async observe(key: string) {
      const { service } = await open();
      return Effect.runPromise(state(service, id(key)));
    },
    async [Symbol.asyncDispose]() {
      const done = opened;
      opened = undefined;
      if (done !== undefined) await (await done).close();
    },
  };
}
