// spec/agent/tasks/index.md, "Story: Run one task operation without losing or repeating its effect"; spec/agent/tasks/index.md, "Story: Finish a task and wait for its actuator to let go"
import { randomBytes } from "node:crypto";
import { Effect, Exit, Redacted } from "effect";
import type { TaskActionProposal, TaskObservation, TaskOutcome, TaskOwner } from "@elizaos/core";
import type { Driver, Options } from "../../gen/agent__tasks.conformance.ts";
import type { Event, TaskHost } from "../../gen/agent__tasks.ts";
import type { OperationStatus, Owner } from "../../gen/core__interactiveTask.ts";
import { createTaskHost, type TaskActuator, type TaskGoalAuthorizer, type TaskHostHandle } from "../../src/tasks/host.vibe";
import { createTaskStore, openNodeTaskDatabase, storageKeySource, type TaskDatabaseOpener } from "../../src/tasks/store.vibe";
import { scratchDirectory, type Scratch } from "../support/scratch.ts";

type Outcome = "accepted" | "refused";

interface Deferred<A> {
  readonly promise: Promise<A>;
  resolve(value: A): void;
  reject(reason: unknown): void;
}

interface World {
  readonly directory: string;
  readonly key: string;
  host: TaskHostHandle;
  clock: number;
  failing: boolean;
  generation: number;
  realId: string;
  goal: { origins: string[]; capabilities: string[]; taskId: string; authorizationId: string };
  observation: TaskObservation | undefined;
  readback: TaskOutcome;
  readonly executions: Deferred<TaskOutcome>[];
  readonly quiesces: Deferred<void>[];
  readonly inFlight: Promise<unknown>[];
  calls: number;
  waiters: (() => void)[];
}

const replies: Record<OperationStatus, string> = {
  Empty: "empty", Prepared: "prepared", Dispatched: "dispatched", Succeeded: "succeeded", Failed: "failed", Unknown: "unknown", OperationCancelled: "cancelled",
};

let scratch: Scratch | undefined;
let world: World | undefined;
let worlds = 0;

function deferred<A>(): Deferred<A> {
  let resolve: (value: A) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<A>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function called(w: World): void {
  w.calls += 1;
  const waiting = w.waiters;
  w.waiters = [];
  for (const wake of waiting) wake();
}

const originOf = (origin: string): string => origin.toLowerCase();

function ownerOf(by: unknown): TaskOwner {
  const owner = by as Owner;
  return { agentId: owner.agentId, actorId: owner.actorId, connector: { source: owner.connector, accountId: "launch" } };
}

function actuatorFor(w: () => World): TaskActuator {
  return {
    capabilities: ["read", "write"],
    async observe() {
      const seen = w().observation;
      if (seen === undefined) throw new Error("no observation scripted");
      return seen;
    },
    execute() {
      const reply = deferred<TaskOutcome>();
      w().executions.push(reply);
      called(w());
      return reply.promise;
    },
    async reconcile() {
      return w().readback;
    },
    quiesce() {
      const done = deferred<void>();
      w().quiesces.push(done);
      called(w());
      return done.promise;
    },
  };
}

function authorizerFor(w: () => World): TaskGoalAuthorizer {
  return {
    async authorize(goalRef) {
      const { goal, generation } = w();
      return {
        id: `${goal.taskId}-${generation}`, goalRef,
        authorization: { decisionId: goal.authorizationId, policyRevision: "1", decidedAt: "2026-01-01T00:00:00.000Z", state: "active", revokedAt: null },
        allowedCapabilities: goal.capabilities, allowedOrigins: goal.origins.map(originOf),
      };
    },
  };
}

function hostFor(directory: string, key: string, current: () => World): Promise<TaskHostHandle> {
  const database: TaskDatabaseOpener = (path) => {
    const db = openNodeTaskDatabase(path);
    const check = () => {
      if (current().failing) throw new Error("the disk refused the write");
    };
    return {
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          all: (...parameters) => (check(), statement.all(...parameters)),
          run: (...parameters) => (check(), statement.run(...parameters)),
        };
      },
    };
  };
  return Effect.runPromise(Effect.gen(function* () {
    const store = yield* createTaskStore({ directory, keys: storageKeySource(Redacted.make(key)), database, now: () => current().clock });
    return yield* createTaskHost({ store, now: () => current().clock, actuator: actuatorFor(current), authorizer: authorizerFor(current) });
  }));
}

function live(): World {
  if (world === undefined) throw new Error("the driver was not reset");
  return world;
}

async function enter(w: World, work: Effect.Effect<unknown, unknown>, admitted: (value: unknown) => boolean = () => true): Promise<Outcome> {
  const before = w.calls;
  const blocked = new Promise<"blocked">((resolve) => {
    w.waiters.push(() => resolve("blocked"));
  });
  const running = Effect.runPromiseExit(work);
  w.inFlight.push(running);
  const first = await Promise.race([running, blocked]);
  if (first === "blocked") return w.calls > before ? "accepted" : "refused";
  return Exit.isSuccess(first) && admitted(first.value) ? "accepted" : "refused";
}

async function quiet(w: World): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.race([Promise.allSettled(w.inFlight), new Promise<void>((resolve) => setImmediate(resolve))]);
}

function heldId(w: World): string {
  return w.realId;
}

function proposalOf(w: World, event: Extract<Event, { type: "execute" }>): TaskActionProposal {
  const { proposal } = event;
  return {
    id: proposal.id, taskId: proposal.taskId === w.goal.taskId ? w.realId : proposal.taskId, epoch: proposal.epoch, observationId: proposal.observationId,
    observationVersion: proposal.observationVersion, inputRevision: proposal.inputRevision, targetRef: "target-1", capability: proposal.capability,
    authorizationId: proposal.authorizationId, expiresAt: proposal.expiresAt,
  };
}

function outcomeOf(result: OperationStatus, evidenceRef: string): TaskOutcome {
  return { status: replies[result], ...(evidenceRef === "" ? {} : { evidenceRef }) } as unknown as TaskOutcome;
}

async function fresh(): Promise<World> {
  scratch ??= await scratchDirectory("tasks-driver");
  worlds += 1;
  const directory = scratch.file(`world-${worlds}`);
  const key = randomBytes(32).toString("base64");
  const made: World = {
    directory, key, host: undefined as unknown as TaskHostHandle, clock: 0, failing: false, generation: 0, realId: "",
    goal: { origins: [], capabilities: [], taskId: "", authorizationId: "" }, observation: undefined, readback: { status: "unknown" },
    executions: [], quiesces: [], inFlight: [], calls: 0, waiters: [],
  };
  made.host = await hostFor(directory, key, () => made);
  return made;
}

async function retire(w: World): Promise<void> {
  await Effect.runPromise(w.host.close());
  for (const pending of w.executions.splice(0)) pending.reject(new Error("the process ended"));
  for (const pending of w.quiesces.splice(0)) pending.reject(new Error("the process ended"));
  await Promise.allSettled(w.inFlight.splice(0));
}

async function answerDeferred<A>(w: World, list: Deferred<A>[], settle: (pending: Deferred<A>) => void): Promise<Outcome> {
  const pending = list.shift();
  if (pending === undefined) return "refused";
  settle(pending);
  await quiet(w);
  return "accepted";
}

async function send(event: Event, by: unknown): Promise<Outcome> {
  const w = live();
  const { host } = w;
  const state = await Effect.runPromise(host.state());
  switch (event.type) {
    case "start": return enter(w, host.start(ownerOf(by)));
    case "create": {
      w.goal = { origins: event.origins, capabilities: event.capabilities, taskId: event.taskId, authorizationId: event.authorizationId };
      w.generation += 1;
      const outcome = await enter(w, host.create("goal"), (value) => (value as { reply: { tag: string } }).reply.tag === "NewTask");
      if (outcome === "accepted") w.realId = `${event.taskId}-${w.generation}`;
      return outcome;
    }
    case "execute": return enter(w, host.execute(heldId(w), event.expectedRevision, proposalOf(w, event)));
    case "finishExecution": return answerDeferred(w, w.executions, (pending) => pending.resolve(outcomeOf(event.operationResult, event.evidenceRef)));
    case "control": {
      const id = heldId(w);
      const run = event.kind === "PauseTask" ? host.pause(id, event.expectedRevision) : event.kind === "CancelTask" ? host.cancel(id, event.expectedRevision) : host.revoke(id, event.expectedRevision);
      return enter(w, run);
    }
    case "failStorage": {
      w.failing = true;
      const trigger = state.task.status === "Absent" ? host.create("goal") : host.revoke(heldId(w), state.task.revision);
      if (state.task.status === "Absent") w.goal = { origins: ["https://origina"], capabilities: ["read"], taskId: "poisoned", authorizationId: "auth-poisoned" };
      const outcome = await enter(w, trigger);
      const after = await Effect.runPromise(host.state());
      return after.poisoned && !state.poisoned ? "accepted" : outcome === "accepted" && after.poisoned ? "accepted" : "refused";
    }
    case "restart": {
      if (!state.started) return "refused";
      await retire(w);
      w.failing = false;
      w.host = await hostFor(w.directory, w.key, () => w);
      return "accepted";
    }
    case "reconcile": {
      w.readback = outcomeOf(event.operationResult, event.evidenceRef);
      return enter(w, host.reconcile(heldId(w), event.expectedRevision));
    }
    case "acknowledgeUnknown": return enter(w, host.acknowledgeUnknown(heldId(w), event.expectedRevision));
    case "tick": {
      w.clock = Math.max(w.clock, event.wallNow);
      return "accepted";
    }
    case "observe": {
      const { observation } = event;
      w.observation = {
        id: observation.observationId, pageId: "page-1", origin: originOf(observation.origin), version: observation.observationVersion,
        inputRevision: observation.inputRevision, observedAt: observation.observedAt,
      };
      return enter(w, observation.resume ? host.resume(heldId(w), event.expectedRevision) : host.observe(heldId(w), event.expectedRevision));
    }
    case "extendOrigin": {
      const checked = event.hostChecked;
      return enter(w, host.extendOrigin(heldId(w), event.expectedRevision, originOf(event.origin), async () => checked ? "check-1" : null));
    }
    case "complete": return enter(w, host.complete(heldId(w), event.expectedRevision));
    case "confirmCleanup": return answerDeferred(w, w.quiesces, (pending) => pending.resolve());
    case "failCleanup": return answerDeferred(w, w.quiesces, (pending) => pending.reject(new Error("the guide is still shown")));
    case "retryCleanup": return enter(w, host.settle());
  }
}

function view(h: TaskHost) {
  if (!h.started) return { started: false };
  return {
    started: true, poisoned: h.poisoned, actuator: h.actuator.tag, cleanup: h.cleanup, acknowledged: h.acknowledged,
    status: h.task.status, revision: h.task.revision, authorized: h.task.authorized, observed: h.task.observed, operation: h.task.operation.status,
    origins: [...h.task.origins].sort(), capabilities: [...h.task.capabilities].sort(),
  };
}

type View = ReturnType<typeof view>;

export const driver: Driver<View> & { [Symbol.asyncDispose](): Promise<void> } = {
  async reset() {
    if (world !== undefined) await retire(world);
    world = await fresh();
  },
  dispatch: (_key, event, by) => send(event, by),
  async observe() {
    return view(await Effect.runPromise(live().host.state()));
  },
  async [Symbol.asyncDispose]() {
    if (world !== undefined) await retire(world);
    world = undefined;
    await scratch?.remove();
    scratch = undefined;
  },
};

export const options: Options<View> = {
  view: (state) => view({ ...state, task: { ...state.task, origins: state.task.origins.map(originOf) } }),
  keys: ["owner"],
};
