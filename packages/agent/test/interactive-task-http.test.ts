/** Real HTTP + SQLite integration. The controlled actuator is not Chromium. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  TaskLifecycle,
  type TaskLifecycleState,
} from "../../ui/src/api/task-lifecycle.ts";
import { InteractiveTaskChoices } from "../src/services/interactive-task-choices.ts";
import { createInteractiveTaskHandler } from "../src/services/interactive-task-http.ts";
import { SqliteTaskPresentation } from "../src/services/interactive-task-presentation.ts";
import {
  type InteractiveTaskActuator,
  InteractiveTaskRuntime,
} from "../src/services/interactive-task-runtime.ts";
import { SqliteInteractiveTaskStore } from "../src/services/interactive-task-store.ts";
import { SqliteMessageInteractionSessionStore } from "../src/services/sqlite-message-interaction-session-store.ts";

import { listenTaskHttp } from "./fixtures/task-http-server.ts";

const owner = {
  actorId: "actor",
  agentId: "agent",
  connector: { source: "browser", accountId: "account" },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "eliza-task-http-"));
  const db = new DatabaseSync(join(directory, "host.sqlite"));
  db.exec("PRAGMA synchronous = FULL");
  return {
    db,
    store: new SqliteInteractiveTaskStore(db),
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function goal(goalRef: string) {
  return {
    id: "task-1",
    goalRef,
    authorization: {
      decisionId: "grant",
      policyRevision: "policy",
      state: "active" as const,
      decidedAt: new Date().toISOString(),
      revokedAt: null,
    },
    allowedCapabilities: ["fill", "submit"],
    allowedOrigins: ["https://example.org"],
  };
}

describe("interactive task HTTP host", () => {
  it.each([
    { status: "succeeded" },
    { status: "failed" },
    { status: "succeeded", evidenceRef: "invalid evidence" },
    { status: "unexpected" },
  ])("journals an invalid actuator reply as uncertain: %j", async (reply) => {
    const storage = setup();
    let effects = 0;
    let version = 0;
    const runtime = new InteractiveTaskRuntime({
      owner,
      store: storage.store,
      actuator: {
        capabilities: ["fill"],
        async observe() {
          return {
            id: "view",
            pageId: "page",
            origin: "https://example.org",
            version: ++version,
            inputRevision: 0,
            observedAt: Date.now(),
          };
        },
        async execute() {
          effects++;
          // A JavaScript/native adapter can violate the TypeScript contract.
          return reply as Awaited<
            ReturnType<InteractiveTaskActuator["execute"]>
          >;
        },
      },
    });
    const http = await listenTaskHttp(
      createInteractiveTaskHandler({
        runtime,
        authenticate: async () => owner,
        authorizeGoal: async (ref) => goal(ref),
      }),
    );
    try {
      expect((await http.call("/tasks", { goalRef: "message" })).status).toBe(
        201,
      );
      const observed = await runtime.observe("task-1", 0);
      const result = await runtime.execute("task-1", observed.revision, {
        id: "operation",
        taskId: "task-1",
        epoch: observed.epoch,
        observationId: "view",
        observationVersion: 1,
        inputRevision: 0,
        targetRef: "field",
        capability: "fill",
        authorizationId: "grant",
        expiresAt: Date.now() + 10000,
      });
      expect(effects).toBe(1);
      expect(result.status).toBe("blocked");
      expect(result.operations[0].status).toBe("unknown");
      expect(result.operations[0].evidenceRef).toBeUndefined();
      expect(
        (await (await http.call("/tasks/task-1")).json()).task.status,
      ).toBe("blocked");
      expect(runtime.events("task-1").events.at(-1)?.kind).toBe("result");
      const reconciled = storage.store.transition(
        "task-1",
        {
          owner,
          expectedRevision: result.revision,
          now: Date.now(),
        },
        {
          type: "reconcile",
          operationId: "operation",
          status: "succeeded",
          evidenceRef: "readback",
        },
      ).task;
      expect(reconciled.status).toBe("paused");
      expect(
        (await runtime.observe("task-1", reconciled.revision, true)).status,
      ).toBe("active");
      expect(effects).toBe(1);
    } finally {
      await http.close();
      storage.close();
    }
  });

  it("authenticates controls, commits before dispatch, and fences a late result after pause", async () => {
    const storage = setup();
    const entered =
      deferred<Parameters<InteractiveTaskActuator["execute"]>[1]>();
    const reply = deferred<{ status: "succeeded"; evidenceRef: string }>();
    let version = 0;
    const runtime = new InteractiveTaskRuntime({
      owner,
      store: storage.store,
      actuator: {
        capabilities: ["fill"],
        async observe() {
          return {
            id: `view-${++version}`,
            pageId: "page",
            origin: "https://example.org",
            version,
            inputRevision: 0,
            observedAt: Date.now(),
          };
        },
        async execute(_proposal, context) {
          expect(storage.store.get("task-1", owner)?.operations[0].status).toBe(
            "dispatched",
          );
          expect(context.isCurrent()).toBe(true);
          entered.resolve(context);
          return reply.promise;
        },
      },
    });
    const http = await listenTaskHttp(
      createInteractiveTaskHandler({
        runtime,
        authenticate: async (request) =>
          request.headers.get("authorization") === "valid" ? owner : null,
        authorizeGoal: async (ref) => goal(ref),
      }),
    );
    try {
      expect(
        (await http.call("/tasks/task-1", undefined, "invalid")).status,
      ).toBe(401);
      expect(
        (
          await http.call("/tasks", {
            goalRef: "message-1",
            allowedCapabilities: ["submit"],
          })
        ).status,
      ).toBe(400);
      expect((await http.call("/tasks", { goalRef: "message-1" })).status).toBe(
        201,
      );
      expect(runtime.get("task-1").allowedCapabilities).toEqual(["fill"]);
      expect((await (await http.call("/tasks/current")).json()).task.id).toBe(
        "task-1",
      );
      expect((await http.call("/tasks/task-1/dispatch", {})).status).toBe(404);
      const paused = await (
        await http.call("/tasks/task-1/pause", { expectedRevision: 0 })
      ).json();
      expect(paused.task.status).toBe("paused");
      expect(
        (
          await http.call("/tasks/task-1/resume", {
            expectedRevision: 1,
            observation: {},
          })
        ).status,
      ).toBe(400);
      expect(
        (await http.call("/tasks/task-1/resume", { expectedRevision: 1 }))
          .status,
      ).toBe(200);
      const observed = runtime.get("task-1");
      const execution = runtime.execute("task-1", observed.revision, {
        id: "operation-1",
        taskId: "task-1",
        epoch: observed.epoch,
        observationId: "view-1",
        observationVersion: 1,
        inputRevision: 0,
        targetRef: "field-1",
        capability: "fill",
        authorizationId: "grant",
        expiresAt: Date.now() + 10000,
      });
      const actuatorContext = await entered.promise;
      const waiting = await (await http.call("/tasks/task-1")).json();
      expect(waiting.task.status).toBe("waiting");
      expect(waiting.task).not.toHaveProperty("owner");
      expect(waiting.task).not.toHaveProperty("operations");
      expect(
        (
          await http.call("/tasks/task-1/pause", {
            expectedRevision: waiting.task.revision,
          })
        ).status,
      ).toBe(200);
      expect(actuatorContext.signal.aborted).toBe(true);
      expect(actuatorContext.isCurrent()).toBe(false);
      reply.resolve({ status: "succeeded", evidenceRef: "late-receipt" });
      const after = await execution;
      expect(after.status).toBe("paused");
      expect(after.operations[0].status).toBe("unknown");
      expect(after.operations[0].evidenceRef).toBeUndefined();
      expect(
        (
          await http.call("/tasks/task-1/pause", {
            expectedRevision: waiting.task.revision,
          })
        ).status,
      ).toBe(409);
      expect((await http.call("/tasks", { goalRef: "message-2" })).status).toBe(
        409,
      );
    } finally {
      await http.close();
      storage.close();
    }
  });

  it("does not resume when authentication changes during observation", async () => {
    const storage = setup();
    const observed = deferred<void>();
    const release = deferred<void>();
    let authenticated = true;
    const runtime = new InteractiveTaskRuntime({
      owner,
      store: storage.store,
      actuator: {
        capabilities: [],
        async observe() {
          observed.resolve();
          await release.promise;
          return {
            id: "view-1",
            pageId: "page",
            origin: "https://example.org",
            version: 1,
            inputRevision: 0,
            observedAt: Date.now(),
          };
        },
        async execute() {
          throw new Error("No actuator capability");
        },
      },
    });
    runtime.create(goal("message-1"));
    runtime.control("task-1", 0, "pause");
    const http = await listenTaskHttp(
      createInteractiveTaskHandler({
        runtime,
        authenticate: async () => (authenticated ? owner : null),
        authorizeGoal: async (ref) => goal(ref),
      }),
    );
    try {
      const request = http.call("/tasks/task-1/resume", {
        expectedRevision: 1,
      });
      await observed.promise;
      authenticated = false;
      release.resolve();
      expect((await request).status).toBe(409);
      expect(runtime.get("task-1").status).toBe("paused");
      expect(runtime.get("task-1").revision).toBe(1);
    } finally {
      await http.close();
      storage.close();
    }
  });
});

describe("task event transport", () => {
  it("returns stable ordered lifecycle events with owner checks and strict cursors", async () => {
    const state = setup();
    const runtime = new InteractiveTaskRuntime({
      owner,
      store: state.store,
      actuator: {
        capabilities: [],
        observe: async () => {
          throw new Error("Not used");
        },
        execute: async () => {
          throw new Error("Not used");
        },
      },
    });
    const server = await listenTaskHttp(
      createInteractiveTaskHandler({
        runtime,
        authenticate: async (request) =>
          request.headers.get("authorization") === "valid" ? owner : null,
        authorizeGoal: async (ref) => goal(ref),
      }),
    );
    try {
      expect((await server.call("/tasks", { goalRef: "goal" })).status).toBe(
        201,
      );
      const initial = await (
        await server.call("/tasks/task-1/events?after=-1")
      ).json();
      expect(
        initial.events.map((event: { eventId: string }) => event.eventId),
      ).toEqual(["task-1#0"]);
      expect(initial.task.owner).toBeUndefined();
      expect(initial.task.goalRef).toBeUndefined();
      expect(
        (await server.call("/tasks/task-1/pause", { expectedRevision: 0 }))
          .status,
      ).toBe(200);
      const next = await (
        await server.call("/tasks/task-1/events?after=0")
      ).json();
      expect(next.events[0].kind).toBe("pause");
      expect(next.events[0].eventId).toBe("task-1#1");
      expect(
        (await server.call("/tasks/task-1/events?after=0&after=1")).status,
      ).toBe(400);
      expect((await server.call("/tasks/task-1/events?after=1.5")).status).toBe(
        400,
      );
      expect((await server.call("/tasks/task-1/events?after=99")).status).toBe(
        400,
      );
      expect((await server.call("/tasks/task-1/events", {})).status).toBe(405);
      expect(
        (await server.call("/tasks/task-1/events", undefined, "foreign"))
          .status,
      ).toBe(401);
    } finally {
      await server.close();
      state.close();
    }
  });
});

it.each(["pause", "close"] as const)(
  "shared client %s waits for ordered HTTP cleanup and retries only cleanup after a missing acknowledgement",
  async (command) => {
    const f = setup(),
      entered = deferred<void>(),
      release = deferred<void>();
    let calls = 0,
      fail = false;
    const reasons: unknown[] = [];
    const runtime = new InteractiveTaskRuntime({
      owner,
      store: f.store,
      actuator: {
        capabilities: [],
        observe: async () => {
          throw new Error("unexpected observe");
        },
        execute: async () => {
          throw new Error("unexpected execute");
        },
        quiesce: async ({ reason }) => {
          reasons.push(reason);
          calls++;
          if (calls === 1) {
            entered.resolve();
            await release.promise;
          }
          if (fail) throw new Error("no removal acknowledgement");
        },
      },
    });
    runtime.create(goal("cleanup"));
    const http = await listenTaskHttp(
      createInteractiveTaskHandler({
        runtime,
        authenticate: async () => owner,
        authorizeGoal: async (ref) => goal(ref),
      }),
    );
    const states: TaskLifecycleState[] = [];
    const client = new TaskLifecycle(
      async (path, body) => {
        const response = await http.call(path, body);
        if (!response.ok) throw new Error(`Task HTTP ${response.status}`);
        return response.json();
      },
      (state) => states.push(state),
      {
        start: "start failed",
        pause: "pause failed",
        resume: "resume failed",
        cancel: "cancel failed",
      },
    );
    try {
      let completed = false;
      const pending = client.control(command).then((response) => {
        completed = true;
        return response;
      });
      await entered.promise;
      expect(runtime.get("task-1").status).toBe("paused");
      expect(completed).toBe(false);
      // A host may close a task while its earlier Pause cleanup still awaits an ack.
      runtime.control("task-1", runtime.get("task-1").revision, "close");
      await Promise.resolve();
      const beforePauseAcknowledged = [...reasons];
      release.resolve();
      expect(await pending).toBe(true);
      expect(beforePauseAcknowledged).toEqual([command]);
      // Close is a pause; only the host cleanup reason differs.
      for (const body of [
        { expectedRevision: 1, reason: "pause" },
        { expectedRevision: 1, reason: "close", extra: true },
      ])
        expect((await http.call("/tasks/task-1/pause", body)).status).toBe(400);
      expect(
        (
          await http.call("/tasks/task-1/cancel", {
            expectedRevision: 1,
            reason: "close",
          })
        ).status,
      ).toBe(400);
      expect(await client.control("close")).toBe(true);
      expect(states.at(-1)).toMatchObject({
        pending: false,
        error: "",
        task: { status: "paused" },
      });
      fail = true;
      expect(await client.control("close")).toBe(false);
      const failedRevision = runtime.get("task-1").revision;
      expect(await client.control("pause")).toBe(false);
      expect(runtime.get("task-1").revision).toBe(failedRevision);
      fail = false;
      expect(await client.control("pause")).toBe(true);
      expect(runtime.get("task-1").revision).toBe(failedRevision);
      const beforeRepeatedPause = calls;
      expect(await client.control("pause")).toBe(true);
      expect(calls).toBe(beforeRepeatedPause);
      fail = true;
      const cancelled = await http.call("/tasks/task-1/cancel", {
        expectedRevision: runtime.get("task-1").revision,
      });
      expect(cancelled.status).toBe(503);
      expect(await cancelled.json()).toEqual({
        code: "TASK_CLEANUP_UNCONFIRMED",
      });
      const revision = runtime.get("task-1").revision;
      fail = false;
      const refreshed = await http.call("/tasks/current");
      expect(refreshed.status).toBe(200);
      expect(await refreshed.json()).toEqual({ task: null });
      expect(runtime.get("task-1").revision).toBe(revision);
      expect(calls).toBe(8);
      // A retried cleanup keeps the reason of the control that started it.
      expect(reasons).toEqual([
        command,
        "close",
        "close",
        "close",
        "close",
        "close",
        "cancel",
        "cancel",
      ]);
    } finally {
      release.resolve();
      await http.close();
      f.close();
    }
  },
);

it("does not deliver a choice when an authenticated pause finishes during refresh", async () => {
  const storage = setup();
  const runtime = new InteractiveTaskRuntime({
    owner,
    store: storage.store,
    actuator: {
      capabilities: [],
      observe: async () => {
        throw new Error("Presentation read must not observe");
      },
      execute: async () => {
        throw new Error("Presentation read must not execute");
      },
    },
  });
  const http = await listenTaskHttp(
    createInteractiveTaskHandler({
      runtime,
      authenticate: async () => owner,
      authorizeGoal: async (ref) => ({ ...goal(ref), allowedCapabilities: [] }),
    }),
  );
  let pauseAfterRefresh = false;
  // Preserve the actual refresh and disk read; interleave a real HTTP control
  // before its caller resumes, as can happen across an asynchronous boundary.
  class ControlledRefresh extends InteractiveTaskChoices {
    override async refresh(
      value: Parameters<InteractiveTaskChoices["refresh"]>[0],
    ) {
      const current = await super.refresh(value);
      if (pauseAfterRefresh) {
        pauseAfterRefresh = false;
        const paused = await http.call("/tasks/task-1/pause", {
          expectedRevision: runtime.get("task-1").revision,
        });
        expect(paused.status).toBe(200);
        expect(runtime.get("task-1").status).toBe("paused");
      }
      return current;
    }
  }
  try {
    expect((await http.call("/tasks", { goalRef: "message" })).status).toBe(
      201,
    );
    const choices = new ControlledRefresh(
      runtime,
      new SqliteMessageInteractionSessionStore(storage.db),
    );
    const presentation = new SqliteTaskPresentation(
      storage.db,
      runtime,
      choices,
    );
    await presentation.publish("task-1", "a".repeat(64), {
      kind: "choice",
      id: "method",
      scope: "review",
      options: [{ value: "existing", label: "Use existing method" }],
    });
    pauseAfterRefresh = true;
    expect(await presentation.read("task-1")).toBeNull();
    expect(runtime.get("task-1").status).toBe("paused");
  } finally {
    await http.close();
    storage.close();
  }
});

it.each(["reply", "lost-reply", "timeout"])(
  "Pause covers a pending start, including a lost creation reply (%s)",
  async (replyMode) => {
    const f = setup();
    const runtime = new InteractiveTaskRuntime({
      owner,
      store: f.store,
      actuator: {
        capabilities: [],
        observe: async () => {
          throw new Error("unexpected observe");
        },
        execute: async () => {
          throw new Error("unexpected execute");
        },
        quiesce: async () => {},
      },
    });
    const created = deferred<void>();
    const authorizing = deferred<void>();
    const http = await listenTaskHttp(
      createInteractiveTaskHandler({
        runtime,
        authenticate: async () => owner,
        authorizeGoal: async (ref) => {
          authorizing.resolve();
          await created.promise;
          return goal(ref);
        },
      }),
    );
    const paths: string[] = [];
    const states: TaskLifecycleState[] = [];
    const client = new TaskLifecycle(
      async (path, body) => {
        paths.push(path);
        const response = await http.call(path, body);
        if (!response.ok) throw new Error(`Task HTTP ${response.status}`);
        const reply = await response.json();
        if (path === "/tasks" && replyMode === "lost-reply")
          throw new Error("Creation reply lost");
        return reply;
      },
      (state) => states.push(state),
      {
        start: "start failed",
        pause: "pause failed",
        resume: "resume failed",
        cancel: "cancel failed",
      },
    );
    try {
      for (const body of [{ reason: "pause" }, { reason: "close", extra: 1 }])
        expect((await http.call("/tasks/current/pause", body)).status).toBe(
          400,
        );
      expect(
        await (await http.call("/tasks/current/pause", {})).json(),
      ).toEqual({
        task: null,
      });
      const starting = client.start("bill");
      await authorizing.promise;
      paths.length = 0;
      let paused = false;
      const pausing = client.control("pause").then((value) => {
        paused = value;
        return value;
      });
      // The pause request is answered while the start is still pending.
      while (!paths.includes("/tasks/current/pause"))
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(paused).toBe(false);
      if (replyMode === "timeout") {
        expect(await pausing).toBe(false);
        expect(states.at(-1)).toMatchObject({
          pending: false,
          error: "pause failed",
        });
        const beforeRefresh = paths.length;
        await client.refresh();
        expect(paths).toHaveLength(beforeRefresh);
      }
      created.resolve();
      expect(await starting).toBe(false);
      if (replyMode !== "timeout") expect(await pausing).toBe(true);
      // A timeout reports failure promptly but does not abandon the pending pause.
      await vi.waitFor(() =>
        expect(runtime.get("task-1").status).toBe("paused"),
      );
      // The task that start created is paused, not left running.
      expect(runtime.get("task-1").status).toBe("paused");
      expect(
        paths.filter((path) => path === "/tasks/current/pause"),
      ).toHaveLength(2);
      expect(paths.some((path) => /\/tasks\/task-1\/pause$/.test(path))).toBe(
        false,
      );
    } finally {
      created.resolve();
      await http.close();
      f.close();
    }
  },
  20_000,
);
