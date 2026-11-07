/** Host-authorized origin extension of a running task; real SQLite journal. */
import { DatabaseSync } from "node:sqlite";
import {
  type InteractiveTask,
  MAX_TASK_ORIGIN_CHAIN,
  MAX_TASK_ORIGIN_GRANTS,
  mergeTaskEvents,
  type TaskObservation,
  transitionInteractiveTask,
  validateInteractiveTask,
} from "@elizaos/core/protocol";
import { describe, expect, it } from "vitest";
import {
  type InteractiveTaskActuator,
  InteractiveTaskRuntime,
} from "../src/services/interactive-task-runtime.ts";
import { SqliteInteractiveTaskStore } from "../src/services/interactive-task-store.ts";

const SSA = "https://www.ssa.gov";
const LOGIN = "https://secure.login.gov";
const owner = {
  actorId: "actor",
  agentId: "agent",
  connector: { source: "browser", accountId: "account" },
};
const goal = {
  id: "task-1",
  goalRef: "goal-1",
  authorization: {
    decisionId: "grant",
    policyRevision: "policy",
    state: "active" as const,
    decidedAt: new Date(1000).toISOString(),
    revokedAt: null,
  },
  allowedCapabilities: ["browser.click"],
  allowedOrigins: [SSA],
};

function setup(
  options: {
    scopeFails?: boolean;
    slowQuiesce?: boolean;
    holdScope?: Promise<void>;
  } = {},
) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA synchronous = FULL");
  const store = new SqliteInteractiveTaskStore(db);
  let clock = 1000;
  let page = SSA;
  let version = 0;
  const scopes: { epoch: number; allowedOrigins: readonly string[] }[] = [];
  const quiesced: string[] = [];
  let release: (() => void) | undefined;
  let quiescing = 0;
  let scopeCalls = 0;
  const actuator: InteractiveTaskActuator = {
    capabilities: ["browser.click"],
    async quiesce({ taskId }) {
      quiescing++;
      // A real guidance hide waits for the browser's acknowledgement.
      if (options.slowQuiesce)
        await new Promise((resolve) => setTimeout(resolve, 5));
      quiescing--;
      quiesced.push(taskId);
    },
    async observe() {
      version++;
      return {
        id: `view-${version}`,
        pageId: `page-${version}`,
        origin: page,
        version,
        inputRevision: 0,
        observedAt: clock,
      };
    },
    async scopeChanged({ epoch, allowedOrigins }) {
      if (options.scopeFails) throw new Error("surface gone");
      // The browser actuator hides guidance here too; a concurrent hide from
      // the fence's cleanup would supersede its revision and fail the change.
      if (options.slowQuiesce)
        await new Promise((resolve) => setTimeout(resolve, 1));
      if (quiescing > 0) throw new Error("guidance hide raced");
      // The page acknowledges this apply late; the list is written on return.
      if (options.holdScope && scopeCalls++ === 0) await options.holdScope;
      scopes.push({ epoch, allowedOrigins: [...allowedOrigins] });
    },
    async execute() {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: "succeeded", evidenceRef: "evidence-1" };
    },
  };
  const runtime = new InteractiveTaskRuntime({
    owner,
    store,
    actuator,
    now: () => ++clock,
  });
  return {
    runtime,
    store,
    scopes,
    quiesced,
    goTo: (origin: string) => {
      page = origin;
    },
    release: () => release?.(),
  };
}

const allEvents = (runtime: InteractiveTaskRuntime, id: string) =>
  runtime.events(id).events;

describe("host-authorized task origin extension", () => {
  it("keeps a task bound to its starting origin until the host extends it", async () => {
    const { runtime, goTo } = setup();
    let task = runtime.create(goal);
    task = await runtime.observe(task.id, task.revision);
    expect(task.originGrants).toBeUndefined();
    expect(task.originChain).toBeUndefined();
    goTo(LOGIN);
    await expect(runtime.observe(task.id, task.revision)).rejects.toMatchObject(
      { code: "TASK_SCOPE_CHANGED" },
    );
    // Single-origin events keep their original shape.
    expect(allEvents(runtime, task.id).some((event) => "origin" in event)).toBe(
      false,
    );
  });

  it("extends only after the host check, records the origin chain and audits each origin", async () => {
    const { runtime, scopes, goTo } = setup();
    let task = runtime.create(goal);
    task = await runtime.observe(task.id, task.revision);
    const checked: string[] = [];
    await expect(
      runtime.extendOrigin(task.id, task.revision, LOGIN, async (origin) => {
        checked.push(origin);
        return null;
      }),
    ).rejects.toMatchObject({ code: "TASK_ORIGIN_REFUSED" });
    expect(runtime.get(task.id).allowedOrigins).toEqual([SSA]);

    const epoch = task.epoch;
    task = await runtime.extendOrigin(
      task.id,
      task.revision,
      LOGIN,
      async (origin) => {
        checked.push(origin);
        return "check-login-1";
      },
    );
    expect(checked).toEqual([LOGIN, LOGIN]);
    expect(task.epoch).toBe(epoch + 1);
    expect(task.allowedOrigins).toEqual([SSA, LOGIN]);
    // A new epoch needs a fresh observation before any action.
    expect(task.observation).toBeNull();
    expect(task.originGrants).toEqual([
      {
        origin: LOGIN,
        checkRef: "check-login-1",
        epoch: epoch + 1,
        grantedAt: task.updatedAt,
        retractedAt: null,
      },
    ]);
    expect(task.originChain?.map((step) => step.origin)).toEqual([SSA]);
    expect(scopes).toEqual([
      { epoch: epoch + 1, allowedOrigins: [SSA, LOGIN] },
    ]);

    goTo(LOGIN);
    task = await runtime.observe(task.id, task.revision);
    goTo(SSA);
    task = await runtime.observe(task.id, task.revision);
    task = await runtime.observe(task.id, task.revision);
    expect(task.originChain?.map((step) => step.origin)).toEqual([
      SSA,
      LOGIN,
      SSA,
    ]);
    const audited = allEvents(runtime, task.id)
      .filter((event) => event.origin)
      .map((event) => [event.kind, event.origin]);
    expect(audited).toEqual([
      ["extend-origin", LOGIN],
      ["observe", LOGIN],
      ["observe", SSA],
      ["observe", SSA],
    ]);
    // A paged reader admits the new kinds and the origin field.
    expect(
      mergeTaskEvents(task.id, [], allEvents(runtime, task.id)).length,
    ).toBe(task.revision + 1);
  });

  it("never extends a task with an unresolved action or an already-allowed origin", async () => {
    const { runtime, release } = setup();
    let task = runtime.create(goal);
    task = await runtime.observe(task.id, task.revision);
    await expect(
      runtime.extendOrigin(task.id, task.revision, SSA, async () => "check"),
    ).rejects.toThrow(/already in task scope/);
    await expect(
      runtime.extendOrigin(
        task.id,
        task.revision,
        "https://login.gov/path",
        async () => "check",
      ),
    ).rejects.toThrow(/exact HTTPS origin/);
    const running = runtime.execute(task.id, task.revision, {
      id: "op-1",
      taskId: task.id,
      epoch: task.epoch,
      observationId: task.observation?.id ?? "",
      observationVersion: task.observation?.version ?? 0,
      inputRevision: 0,
      targetRef: "target",
      capability: "browser.click",
      authorizationId: "grant",
      expiresAt: 10_000_000,
    });
    await Promise.resolve();
    const waiting = runtime.get(task.id);
    expect(waiting.status).toBe("waiting");
    await expect(
      runtime.extendOrigin(
        task.id,
        waiting.revision,
        LOGIN,
        async () => "check",
      ),
    ).rejects.toMatchObject({ code: "TASK_NOT_ACTIVE" });
    release();
    await running;
  });

  it("retracts a granted origin, fences in-flight work and returns to the starting origin", async () => {
    const { runtime, scopes, quiesced, goTo, release } = setup();
    let task = runtime.create(goal);
    task = await runtime.observe(task.id, task.revision);
    task = await runtime.extendOrigin(
      task.id,
      task.revision,
      LOGIN,
      async () => "check-login-1",
    );
    goTo(LOGIN);
    task = await runtime.observe(task.id, task.revision);
    await expect(
      runtime.retractOrigin(task.id, task.revision, SSA),
    ).rejects.toThrow(/not granted/);

    const running = runtime.execute(task.id, task.revision, {
      id: "op-1",
      taskId: task.id,
      epoch: task.epoch,
      observationId: task.observation?.id ?? "",
      observationVersion: task.observation?.version ?? 0,
      inputRevision: 0,
      targetRef: "target",
      capability: "browser.click",
      authorizationId: "grant",
      expiresAt: 10_000_000,
    });
    await Promise.resolve();
    const waiting = runtime.get(task.id);
    const retracted = await runtime.retractOrigin(
      task.id,
      waiting.revision,
      LOGIN,
    );
    release();
    await running;
    expect(retracted.allowedOrigins).toEqual([SSA]);
    expect(retracted.epoch).toBe(waiting.epoch + 1);
    expect(retracted.observation).toBeNull();
    expect(retracted.status).toBe("paused");
    expect(retracted.operations[0]?.status).toBe("unknown");
    expect(retracted.originGrants?.[0]?.retractedAt).toBe(retracted.updatedAt);
    expect(scopes.at(-1)).toEqual({
      epoch: retracted.epoch,
      allowedOrigins: [SSA],
    });
    expect(quiesced).toContain(task.id);
    // A late result cannot overwrite the fence.
    expect(runtime.get(task.id).operations[0]?.status).toBe("unknown");

    // The page is still on the retracted origin: no observation there.
    await expect(
      runtime.observe(task.id, runtime.get(task.id).revision, true),
    ).rejects.toMatchObject({ code: "TASK_UNKNOWN_OUTCOME" });
  });

  it("returns to the starting origin after retraction and can extend again", async () => {
    const { runtime, goTo } = setup();
    let task = runtime.create(goal);
    task = await runtime.observe(task.id, task.revision);
    task = await runtime.extendOrigin(
      task.id,
      task.revision,
      LOGIN,
      async () => "check-1",
    );
    goTo(LOGIN);
    task = await runtime.observe(task.id, task.revision);
    task = await runtime.retractOrigin(task.id, task.revision, LOGIN);
    expect(task.status).toBe("active");
    expect(task.observation).toBeNull();
    await expect(runtime.observe(task.id, task.revision)).rejects.toMatchObject(
      { code: "TASK_SCOPE_CHANGED" },
    );
    goTo(SSA);
    task = await runtime.observe(task.id, task.revision);
    expect(task.originChain?.map((step) => step.origin)).toEqual([
      SSA,
      LOGIN,
      SSA,
    ]);
    task = await runtime.extendOrigin(
      task.id,
      task.revision,
      LOGIN,
      async () => "check-2",
    );
    expect(task.originGrants?.map((grant) => grant.checkRef)).toEqual([
      "check-1",
      "check-2",
    ]);
    expect(
      allEvents(runtime, task.id)
        .filter((event) => event.kind.endsWith("-origin"))
        .map((event) => `${event.kind} ${event.origin}`),
    ).toEqual([
      `extend-origin ${LOGIN}`,
      `retract-origin ${LOGIN}`,
      `extend-origin ${LOGIN}`,
    ]);
    // Narrowing still works after the task ended.
    task = await runtime.complete(task.id, task.revision, async () => true);
    task = await runtime.retractOrigin(task.id, task.revision, LOGIN);
    expect(task.status).toBe("completed");
    expect(task.allowedOrigins).toEqual([SSA]);
  });

  it("applies a retraction only after the fence's cleanup finished", async () => {
    const { runtime, scopes, goTo } = setup({ slowQuiesce: true });
    let task = runtime.create(goal);
    task = await runtime.observe(task.id, task.revision);
    task = await runtime.extendOrigin(
      task.id,
      task.revision,
      LOGIN,
      async () => "check-login-1",
    );
    goTo(LOGIN);
    task = await runtime.observe(task.id, task.revision);
    task = await runtime.retractOrigin(task.id, task.revision, LOGIN);
    expect(task.allowedOrigins).toEqual([SSA]);
    expect(scopes.at(-1)).toEqual({ epoch: task.epoch, allowedOrigins: [SSA] });
  });

  it("never writes an older origin list after a newer scope change", async () => {
    let releaseScope: () => void = () => undefined;
    const holdScope = new Promise<void>((resolve) => {
      releaseScope = resolve;
    });
    const { runtime, scopes } = setup({ holdScope });
    let task = runtime.create(goal);
    const extending = runtime.extendOrigin(
      task.id,
      task.revision,
      LOGIN,
      async () => "check-login-1",
    );
    // Wait until the extension committed and its page apply is in flight.
    while (runtime.get(task.id).allowedOrigins.length < 2)
      await new Promise((resolve) => setTimeout(resolve, 1));
    task = runtime.get(task.id);
    const retracting = runtime.retractOrigin(task.id, task.revision, LOGIN);
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseScope();
    await extending;
    task = await retracting;
    expect(task.allowedOrigins).toEqual([SSA]);
    expect(scopes.at(-1)).toEqual({ epoch: task.epoch, allowedOrigins: [SSA] });
  });

  it("reports an unconfirmed page policy and can re-apply the persisted scope", async () => {
    const { runtime } = setup({ scopeFails: true });
    let task = runtime.create(goal);
    await expect(
      runtime.extendOrigin(task.id, task.revision, LOGIN, async () => "check"),
    ).rejects.toMatchObject({ code: "TASK_SCOPE_UNCONFIRMED" });
    task = runtime.get(task.id);
    expect(task.allowedOrigins).toEqual([SSA, LOGIN]);
    await expect(runtime.syncScope(task.id)).rejects.toMatchObject({
      code: "TASK_SCOPE_UNCONFIRMED",
    });
  });
});

describe("origin scope journal validation", () => {
  const observation = (origin: string, version: number): TaskObservation => ({
    id: `view-${version}`,
    pageId: `page-${version}`,
    origin,
    version,
    inputRevision: 0,
    observedAt: 1000 + version,
  });
  const base = (): InteractiveTask => ({
    schemaVersion: 1,
    id: "task-1",
    owner,
    goalRef: "goal-1",
    revision: 0,
    epoch: 0,
    status: "active",
    authorization: goal.authorization,
    allowedCapabilities: ["browser.click"],
    allowedOrigins: [SSA],
    observation: null,
    operations: [],
    updatedAt: 1000,
  });
  const step = (
    task: InteractiveTask,
    change: Parameters<typeof transitionInteractiveTask>[2],
  ) =>
    transitionInteractiveTask(
      task,
      { owner, expectedRevision: task.revision, now: task.updatedAt + 100 },
      change,
    ).task;

  it("rejects persisted scope that disagrees with its grants", () => {
    const extended = step(base(), {
      type: "extend-origin",
      origin: LOGIN,
      checkRef: "check",
    });
    validateInteractiveTask(extended);
    expect(() =>
      validateInteractiveTask({ ...extended, originChain: undefined }),
    ).toThrow(/disagree/);
    expect(() =>
      validateInteractiveTask({ ...extended, allowedOrigins: [SSA] }),
    ).toThrow(/outside task scope/);
    const retracted = step(extended, {
      type: "retract-origin",
      origin: LOGIN,
    });
    expect(() =>
      validateInteractiveTask({
        ...retracted,
        allowedOrigins: [SSA, LOGIN],
      }),
    ).toThrow(/still in task scope/);
    expect(() =>
      validateInteractiveTask({
        ...extended,
        originChain: [
          { origin: SSA, epoch: 0, at: 1000 },
          { origin: SSA, epoch: 1, at: 1001 },
        ],
      }),
    ).toThrow(/origin chain/);
  });

  it("keeps the origin chain ordered when an observation clock goes back", () => {
    let task = step(base(), {
      type: "observe",
      observation: observation(SSA, 1),
    });
    task = step(task, {
      type: "extend-origin",
      origin: LOGIN,
      checkRef: "check",
    });
    task = step(task, {
      type: "observe",
      observation: { ...observation(LOGIN, 2), observedAt: 900 },
    });
    validateInteractiveTask(task);
    expect(task.originChain?.map((item) => item.at)).toEqual([1001, 1001]);
    task = step(task, {
      type: "observe",
      observation: { ...observation(SSA, 3), observedAt: 950 },
    });
    validateInteractiveTask(task);
    expect(task.originChain?.map((item) => item.origin)).toEqual([
      SSA,
      LOGIN,
      SSA,
    ]);
  });

  it("bounds grants and keeps the latest chain steps", () => {
    let task = base();
    for (let index = 0; index < MAX_TASK_ORIGIN_GRANTS; index++) {
      const origin = `https://idp-${index}.example`;
      task = step(task, { type: "extend-origin", origin, checkRef: "check" });
      task = step(task, { type: "retract-origin", origin });
    }
    expect(() =>
      step(task, {
        type: "extend-origin",
        origin: LOGIN,
        checkRef: "check",
      }),
    ).toThrow(/Too many origin grants/);

    task = step(base(), {
      type: "extend-origin",
      origin: LOGIN,
      checkRef: "check",
    });
    for (let version = 1; version <= MAX_TASK_ORIGIN_CHAIN + 10; version++)
      task = step(task, {
        type: "observe",
        observation: {
          ...observation(version % 2 ? LOGIN : SSA, version),
          observedAt: task.updatedAt,
        },
      });
    expect(task.originChain).toHaveLength(MAX_TASK_ORIGIN_CHAIN);
    expect(task.originChain?.at(-1)?.origin).toBe(SSA);
  });
});
