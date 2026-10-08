import assert from "node:assert/strict";
import { test } from "vitest";
import { TaskLifecycle as SharedTaskLifecycle } from "../../src/api/task-lifecycle.ts";

const messages = {
  start: "start-unconfirmed",
  pause: "pause-unconfirmed",
  resume: "resume-unconfirmed",
  cancel: "cancel-unconfirmed",
};
class TaskLifecycle extends SharedTaskLifecycle {
  constructor(request, changed) {
    super(request, changed, messages);
  }
}
const task = {
  schemaVersion: 1,
  id: "task",
  revision: 3,
  epoch: 1,
  status: "active",
  hasUnknownOutcome: false,
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("Close reads durable state before pausing and does not optimistically claim pause", async () => {
  const reply = deferred();
  const called = [];
  let state;
  const client = new TaskLifecycle(
    async (path, body) => {
      called.push({ path, body });
      return path === "/tasks/current" ? { task } : reply.promise;
    },
    (next) => {
      state = next;
    },
  );
  const pending = client.control("pause");
  await Promise.resolve();
  assert.equal(state.pending, true);
  assert.equal(state.task, null);
  reply.resolve({ task: { ...task, revision: 4, epoch: 2, status: "paused" } });
  assert.equal(await pending, true);
  assert.equal(state.task.status, "paused");
  assert.deepEqual(called[1], {
    path: "/tasks/task/pause",
    body: { expectedRevision: 3 },
  });
});

test("Close sends the close reason, also for a task that is already paused", async () => {
  for (const status of ["active", "paused"]) {
    const called = [];
    let state;
    const client = new TaskLifecycle(
      async (path, body) => {
        called.push({ path, body });
        return path === "/tasks/current"
          ? { task: { ...task, status } }
          : { task: { ...task, revision: 4, epoch: 2, status: "paused" } };
      },
      (next) => {
        state = next;
      },
    );
    assert.equal(await client.control("close"), true);
    assert.equal(state.task.status, "paused");
    assert.deepEqual(called[1], {
      path: "/tasks/task/pause",
      body: { expectedRevision: 3, reason: "close" },
    });
  }
  const called = [];
  const paused = new TaskLifecycle(
    async (path) => {
      called.push(path);
      return { task: { ...task, status: "paused" } };
    },
    () => {},
  );
  assert.equal(await paused.control("pause"), true);
  assert.deepEqual(called, ["/tasks/current"]);
});

test("account reset and later Close suppress an older Resume response", async () => {
  const reply = deferred();
  let state;
  let resuming = false;
  const client = new TaskLifecycle(
    async (path) => {
      if (path.endsWith("/resume")) {
        resuming = true;
        return reply.promise;
      }
      if (path.endsWith("/pause"))
        return { task: { ...task, revision: 5, epoch: 2, status: "paused" } };
      return { task: { ...task, status: resuming ? "active" : "paused" } };
    },
    (next) => {
      state = next;
    },
  );
  const resume = client.control("resume");
  await Promise.resolve();
  await client.control("pause");
  reply.resolve({ task: { ...task, revision: 4 } });
  assert.equal(await resume, false);
  assert.equal(state.task.status, "paused");
  const slow = deferred();
  const other = new TaskLifecycle(
    () => slow.promise,
    (next) => {
      state = next;
    },
  );
  const refresh = other.refresh();
  other.reset();
  slow.resolve({ task });
  await refresh;
  assert.equal(state.task, null);
});

test("failed pause remains explicitly unconfirmed; invalid server state cannot become UI state", async () => {
  let state;
  const client = new TaskLifecycle(
    async (path) => {
      if (path.endsWith("/pause")) throw new Error("offline");
      return { task };
    },
    (next) => {
      state = next;
    },
  );
  assert.equal(await client.control("pause"), false);
  assert.match(state.error, /pause-unconfirmed/);
  const invalid = new TaskLifecycle(
    async () => ({ task: { ...task, id: "../../effect" } }),
    (next) => {
      state = next;
    },
  );
  await invalid.control("resume");
  assert.equal(state.task, null);
  assert.match(state.error, /resume-unconfirmed/);
});

test("Close during create waits for the response and pauses the created task", async () => {
  const create = deferred();
  let created = false,
    state;
  const calls = [];
  const client = new TaskLifecycle(
    async (path) => {
      calls.push(path);
      if (path === "/tasks/current") return { task: created ? task : null };
      if (path === "/tasks") {
        const result = await create.promise;
        created = true;
        return result;
      }
      return { task: { ...task, status: "paused", revision: 4, epoch: 2 } };
    },
    (value) => (state = value),
  );
  const start = client.start("controlled-bill");
  await Promise.resolve();
  await Promise.resolve();
  const close = client.control("pause");
  create.resolve({ task });
  assert.equal(await start, false);
  assert.equal(await close, true);
  assert.equal(state.task.status, "paused");
  assert.deepEqual(calls, [
    "/tasks/current",
    "/tasks",
    "/tasks/current",
    "/tasks/task/pause",
  ]);
});
test("starting reuses the existing task and concurrent starts do not duplicate creation", async () => {
  let creates = 0;
  const client = new TaskLifecycle(
    async (path) => {
      if (path === "/tasks") creates++;
      return { task };
    },
    () => {},
  );
  const first = client.start("controlled-bill");
  assert.equal(await client.start("controlled-bill"), false);
  assert.equal(await first, true);
  assert.equal(creates, 0);
});
test("navigation before the current-task read returns prevents task creation", async () => {
  const read = deferred();
  let creates = 0;
  const client = new TaskLifecycle(
    async (path) => {
      if (path === "/tasks") {
        creates++;
        return { task };
      }
      return read.promise;
    },
    () => {},
  );
  const start = client.start("controlled-bill");
  client.interruptStart();
  read.resolve({ task: null });
  assert.equal(await start, false);
  await Promise.resolve();
  assert.equal(creates, 0);
});

test("uncertain creation reconciles existing task before a retry and keeps host messages", async () => {
  let created = false,
    creates = 0,
    state;
  const client = new TaskLifecycle(
    async (path) => {
      if (path === "/tasks/current") return { task: created ? task : null };
      creates++;
      created = true;
      throw new Error("transport lost after commit");
    },
    (next) => {
      state = next;
    },
  );
  assert.equal(await client.start("goal"), false);
  assert.equal(state.error, messages.start);
  assert.equal(await client.start("goal"), true);
  assert.equal(creates, 1);
  assert.equal(state.task.id, task.id);
});

test("malformed projection fields and regressing transition replies never publish success", async () => {
  for (const invalid of [
    { epoch: -1 },
    { revision: 1.5 },
    { status: "invented" },
    { hasUnknownOutcome: "false" },
    { schemaVersion: 2 },
  ]) {
    let state;
    const client = new TaskLifecycle(
      async () => ({ task: { ...task, ...invalid } }),
      (next) => {
        state = next;
      },
    );
    assert.equal(await client.start("goal"), false);
    assert.equal(state.task, null);
  }
  for (const change of [{ id: "other" }, { revision: 2 }]) {
    let state;
    const client = new TaskLifecycle(
      async (path) => ({
        task: path === "/tasks/current" ? task : { ...task, ...change },
      }),
      (next) => {
        state = next;
      },
    );
    assert.equal(await client.control("pause"), false);
    assert.equal(state.error, messages.pause);
  }
});

test("account reset permits a new start while the prior account request is unresolved", async () => {
  const old = deferred();
  let calls = 0,
    state;
  const client = new TaskLifecycle(
    async () => (++calls === 1 ? old.promise : { task }),
    (next) => {
      state = next;
    },
  );
  const previous = client.start("old-goal");
  client.reset();
  assert.equal(await client.start("new-goal"), true);
  old.resolve({ task: null });
  assert.equal(await previous, false);
  assert.equal(state.task.id, task.id);
});

test("a transition cannot regress the authoritative task epoch", async () => {
  let state;
  const client = new TaskLifecycle(
    async (path) => ({
      task:
        path === "/tasks/current"
          ? task
          : { ...task, revision: 4, epoch: 0, status: "paused" },
    }),
    (next) => {
      state = next;
    },
  );
  assert.equal(await client.control("pause"), false);
  assert.equal(state.error, messages.pause);
});

test("unchanged or opposite-state acknowledgements keep controls unconfirmed", async () => {
  for (const [command, current, reply] of [
    ["pause", task, task],
    ["pause", task, { ...task, revision: 4, epoch: 2 }],
    ["pause", task, { ...task, revision: 4, status: "paused" }],
    [
      "resume",
      { ...task, status: "paused" },
      { ...task, revision: 4, status: "paused" },
    ],
    ["cancel", task, { ...task, revision: 4, epoch: 2 }],
    ["cancel", task, { ...task, revision: 4, epoch: 2, status: "paused" }],
  ]) {
    let state;
    const client = new TaskLifecycle(
      async (path) => ({ task: path === "/tasks/current" ? current : reply }),
      (next) => {
        state = next;
      },
    );
    assert.equal(
      await client.control(command),
      false,
      `${command} must be confirmed`,
    );
    assert.equal(state.error, messages[command]);
    assert.equal(state.pending, false);
  }
});
