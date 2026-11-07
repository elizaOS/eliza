import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createTaskGateway,
  initialOwnerFence,
  ownerFenceStep,
} from "@elizaos/host/native-host";
import { buildTaskRuntime as build } from "../../scripts/build-consumer-task-runtime.mjs";

const sourceRoot = resolve(import.meta.dirname, "../../../..");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: sourceRoot,
  encoding: "utf8",
}).trim();
const buildTaskRuntime = (output) =>
  build(output, { sourceRoot, sourceCommit });
test("logout fences an authorization already in flight", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-task-logout-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  let release, entered;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: async () => "account-a",
    actuator: { capabilities: ["fill"] },
    authorizeGoal: async (goalRef) => {
      entered();
      await waiting;
      return {
        id: "task-a",
        goalRef,
        authorization: {
          decisionId: "grant",
          policyRevision: "policy",
          state: "active",
          decidedAt: new Date().toISOString(),
          revokedAt: null,
        },
        allowedCapabilities: ["fill"],
        allowedOrigins: ["https://example.org"],
      };
    },
  });
  try {
    const pending = gateway.handle(
      new Request("http://localhost/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"goalRef":"bill"}',
      }),
    );
    await started;
    await gateway.revoke();
    release();
    assert.equal((await pending).status, 401);
    assert.deepEqual(
      await (
        await gateway.handle(new Request("http://localhost/tasks/current"))
      ).json(),
      { task: null },
    );
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the bundle exports the reducer and status mapping the gateway uses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-task-reducer-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  const { transitionInteractiveTask, taskErrorStatus } = await import(
    (await import("node:url")).pathToFileURL(bundlePath).href
  );
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: async () => "account",
    actuator: { capabilities: ["fill"] },
    authorizeGoal: async (goalRef) => ({
      id: "task-a",
      goalRef,
      authorization: {
        decisionId: "grant",
        policyRevision: "policy",
        state: "active",
        decidedAt: new Date().toISOString(),
        revokedAt: null,
      },
      allowedCapabilities: ["fill"],
      allowedOrigins: ["https://example.org"],
    }),
  });
  const post = (path, value) =>
    gateway.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      }),
    );
  try {
    assert.equal((await post("/tasks", { goalRef: "bill" })).status, 201);
    const runtime = await gateway.forCurrentOwner();
    const before = runtime.get("task-a");
    // A refused request answers with the exported mapping of its code.
    for (const response of [
      await gateway.handle(new Request("http://localhost/tasks/task-b")),
      await post("/tasks/task-a/pause", {
        expectedRevision: before.revision + 1,
      }),
    ]) {
      const { code } = await response.json();
      assert.equal(response.status, taskErrorStatus(code));
    }
    assert.equal(taskErrorStatus("TASK_NOT_FOUND"), 404);
    assert.equal(taskErrorStatus("TASK_CONFLICT"), 409);
    // The gateway's pause is the exported reducer's pause step.
    assert.equal(
      (await post("/tasks/task-a/pause", { expectedRevision: before.revision }))
        .status,
      200,
    );
    const after = runtime.get("task-a");
    const { task } = transitionInteractiveTask(
      before,
      {
        owner: runtime.owner,
        expectedRevision: before.revision,
        now: after.updatedAt,
      },
      { type: "pause" },
    );
    assert.equal(after.status, "paused");
    assert.deepEqual(after, task);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("gateway consumes the shared native actuator with durable binding revisions and observed results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-native-actuator-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  const { NativeTaskActuator } = await import(
    (await import("node:url")).pathToFileURL(bundlePath).href
  );
  let sequence = 0,
    effects = 0,
    taskId = "task-first";
  const bindings = [];
  // Controlled native endpoint tests composition. This is not an installed browser.
  const target = {
    guideTask: async () => ({ visible: false }),
    bindTask: async (binding) => {
      bindings.push(binding);
      return {
        bound: true,
        tabId: binding.tabId,
        taskId: binding.taskId,
        epoch: binding.epoch,
        bindingRevision: binding.bindingRevision,
      };
    },
    execute: async (command) => {
      if (command.subaction !== "snapshot") effects++;
      const snapshotId = `00000000-0000-0000-0000-${String(++sequence).padStart(12, "0")}`;
      return {
        value: {
          result:
            command.subaction === "snapshot"
              ? {
                  snapshotId,
                  frames: [
                    {
                      frameId: 0,
                      documentId: "document",
                      url: "https://example.org",
                      complete: true,
                      inputRevision: 0,
                      text: `effects:${effects}`,
                      elements: [{ selector: `${snapshotId}:0:0` }],
                    },
                  ],
                }
              : { dispatched: true, completed: false },
        },
      };
    },
  };
  const config = {
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: async () => "account",
    authorizeGoal: async (goalRef) => ({
      id: taskId,
      goalRef,
      authorization: {
        decisionId: "grant",
        policyRevision: "policy",
        state: "active",
        decidedAt: new Date().toISOString(),
        revokedAt: null,
      },
      allowedCapabilities: ["browser.click"],
      allowedOrigins: ["https://example.org"],
    }),
    actuatorFactory: (host) =>
      new NativeTaskActuator({
        ...host,
        target,
        policy: () => ({
          tabId: "1",
          origin: "https://example.org",
          leaseMs: 60000,
          targets: [{ selector: "#ordinary", action: "click" }],
        }),
        resolveValue: async () => {
          throw new Error("No values used");
        },
        verify: async (_proposal, before, after) =>
          before.text === "effects:0" && after.text === "effects:1"
            ? "succeeded"
            : "unknown",
        recordEvidence: async () => "evidence:test-readback",
      }),
  };
  let gateway = await createTaskGateway(config);
  const create = () =>
    gateway.handle(
      new Request("http://localhost/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"goalRef":"bill"}',
      }),
    );
  try {
    assert.equal((await create()).status, 201);
    let runtime = await gateway.forCurrentOwner();
    let current = runtime.current();
    current = await runtime.observe(current.id, current.revision);
    const proposal = {
      id: "operation",
      taskId: current.id,
      epoch: current.epoch,
      observationId: current.observation.id,
      observationVersion: current.observation.version,
      inputRevision: 0,
      targetRef: `${current.observation.id}:0:0`,
      capability: "browser.click",
      authorizationId: "grant",
      expiresAt: Date.now() + 60000,
    };
    current = await runtime.execute(current.id, current.revision, proposal);
    assert.equal(current.operations[0].status, "succeeded");
    assert.equal(effects, 1);
    runtime.control(current.id, current.revision, "cancel");
    await gateway.close();
    taskId = "task-second";
    gateway = await createTaskGateway(config);
    assert.equal((await create()).status, 201);
    runtime = await gateway.forCurrentOwner();
    current = runtime.current();
    await runtime.observe(current.id, current.revision);
    assert.deepEqual(
      bindings.map((binding) => binding.bindingRevision),
      [1, 2],
    );
    assert.equal(bindings[1].taskId, "task-second");
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing credentials revoke tasks and late authentication cannot replace or revoke a new owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-task-auth-order-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  let gate = async () => "account-a";
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: () => gate(),
    actuator: { capabilities: ["fill"] },
  });
  const goal = (id) => ({
    id,
    goalRef: "controlled",
    authorization: {
      decisionId: `grant-${id}`,
      policyRevision: "policy",
      state: "active",
      decidedAt: new Date().toISOString(),
      revokedAt: null,
    },
    allowedCapabilities: ["fill"],
    allowedOrigins: ["https://example.org"],
  });
  const request = () =>
    gateway.handle(new Request("http://localhost/tasks/current"));
  try {
    const a = await gateway.forCurrentOwner();
    a.create(goal("task-a"));
    gate = async () => null;
    assert.equal((await request()).status, 401);
    assert.equal(a.current().authorization.state, "revoked");
    assert.equal(a.current().status, "paused");

    // Old success arrives after account B is already authenticated and active.
    let releaseOld;
    gate = () =>
      new Promise((resolve) => {
        releaseOld = resolve;
      });
    const old = request();
    gate = async () => "account-b";
    const b = await gateway.forCurrentOwner();
    b.create(goal("task-b"));
    releaseOld("account-a");
    assert.equal((await old).status, 401);
    assert.equal(b.current().authorization.state, "active");
    assert.equal((await (await request()).json()).task.id, "task-b");

    // An old failure must not revoke an account authenticated more recently.
    let rejectOld;
    gate = () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject;
      });
    const failing = request();
    gate = async () => "account-b";
    assert.equal((await request()).status, 200);
    rejectOld(new Error("old provider failure"));
    assert.equal((await failing).status, 401);
    assert.equal(b.current().authorization.state, "active");

    // Logout fences a pending success even if the provider returns the same ID.
    gate = () =>
      new Promise((resolve) => {
        releaseOld = resolve;
      });
    const loggingOut = request();
    await gateway.revoke();
    releaseOld("account-b");
    assert.equal((await loggingOut).status, 401);
    assert.equal(b.current().authorization.state, "revoked");
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const boundary of ["extension", "observer"])
  test(`a delayed ${boundary} cannot publish a former-account result`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "eliza-task-extension-"));
    const bundlePath = join(directory, "task-runtime.mjs");
    buildTaskRuntime(bundlePath);
    let account = "owner-a",
      release,
      entered;
    const pending = new Promise((resolve) => (release = resolve)),
      started = new Promise((resolve) => (entered = resolve));
    const gateway = await createTaskGateway({
      bundlePath,
      databasePath: join(directory, "journal.sqlite"),
      credentialGate: async () => account,
      extensionFactory: () => async () => {
        if (boundary === "extension") {
          entered();
          await pending;
        }
        return Response.json({ private: "former-owner-result" });
      },
      onResponse:
        boundary === "observer"
          ? async () => {
              entered();
              await pending;
            }
          : undefined,
    });
    t.after(async () => {
      await gateway.close();
      await rm(directory, { recursive: true, force: true });
    });
    const response = gateway.handle(
      new Request("http://localhost/tasks/extension"),
    );
    await started;
    account = "owner-b";
    release();
    const denied = await response;
    assert.equal(denied.status, 401);
    assert.doesNotMatch(await denied.text(), /former-owner-result/);
  });

test("the storage probe asks the host inspector without account calls and stops at close", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-task-storage-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  let accountCalls = 0;
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: async () => {
      accountCalls++;
      return "account-a";
    },
    storageInspector: (db) =>
      db.prepare("PRAGMA quick_check").get().quick_check === "ok"
        ? "ok"
        : "unavailable",
  });
  t.after(async () => {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  });
  accountCalls = 0;
  assert.equal(gateway.inspectStorage(), "ok");
  assert.equal(accountCalls, 0);
  await gateway.close();
  assert.equal(gateway.inspectStorage(), "unavailable");
});

test("concurrent same-account reads and planner access remain authorized", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-task-concurrent-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  let gate = async () => "account";
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: () => gate(),
  });
  t.after(async () => {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  });
  const request = () =>
    gateway.handle(new Request("http://localhost/tasks/current"));
  const responses = await Promise.all([request(), request(), request()]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200, 200],
  );
  const [response, runtime] = await Promise.all([
    request(),
    gateway.forCurrentOwner(),
  ]);
  assert.equal(response.status, 200);
  assert.equal(typeof runtime.current, "function");
  // An older successful check may finish last when it confirms the same owner.
  let release;
  gate = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const older = request();
  gate = async () => "account";
  assert.equal((await request()).status, 200);
  release("account");
  assert.equal((await older).status, 200);
});

for (const transition of ["account", "revision"])
  test(`host hooks preserve answers and fence a delayed ${transition} change`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "eliza-task-hooks-"));
    const bundlePath = join(directory, "task-runtime.mjs");
    buildTaskRuntime(bundlePath);
    const observed = [];
    let failHooks = false;
    let decorationWait;
    let decorationEntered;
    let account = "account";
    const gateway = await createTaskGateway({
      bundlePath,
      databasePath: join(directory, "journal.sqlite"),
      credentialGate: async () => account,
      actuator: { capabilities: ["fill"] },
      authorizeGoal: async (goalRef) => ({
        id: "task-hooks",
        goalRef,
        authorization: {
          decisionId: "grant",
          policyRevision: "policy",
          state: "active",
          decidedAt: new Date().toISOString(),
          revokedAt: null,
        },
        allowedCapabilities: ["fill"],
        allowedOrigins: ["https://example.org"],
      }),
      decoratePresentation: async ({ presentation, db, owner, runtime }) => {
        if (decorationWait) {
          decorationEntered();
          await decorationWait;
        }
        if (failHooks) throw new Error("decorator failed");
        assert.equal(typeof db.prepare, "function");
        assert.equal(runtime.get(presentation.taskId).id, "task-hooks");
        return { ...presentation, actor: owner.actorId };
      },
      onResponse: async ({ request, response, durationMs }) => {
        if (failHooks) throw new Error("observer failed");
        await response.json();
        response.headers.set("x-observer", "private");
        observed.push([
          request.method,
          new URL(request.url).pathname,
          response.status,
          durationMs >= 0,
        ]);
      },
    });
    t.after(async () => {
      await gateway.close();
      await rm(directory, { recursive: true, force: true });
    });
    const created = await gateway.handle(
      new Request("http://localhost/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"goalRef":"bill"}',
      }),
    );
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("x-observer"), null);
    assert.equal((await created.json()).task.id, "task-hooks");
    assert.deepEqual(observed, [["POST", "/tasks", 201, true]]);
    const task = (await gateway.forCurrentOwner()).current();
    const read = () =>
      gateway.presentationForConversation({
        taskId: task.id,
        expectedEpoch: task.epoch,
        actorId: "account",
      });
    const decorated = await read();
    assert.equal(decorated.taskId, "task-hooks");
    assert.equal(decorated.actor, "account");
    failHooks = true;
    const { actor, ...undecorated } = decorated;
    assert.deepEqual(await read(), undecorated);
    assert.equal(
      (await gateway.handle(new Request("http://localhost/tasks/current")))
        .status,
      200,
    );
    assert.equal(observed.length, 1);
    failHooks = false;
    {
      let release;
      decorationWait = new Promise((resolve) => {
        release = resolve;
      });
      const entered = new Promise((resolve) => {
        decorationEntered = resolve;
      });
      const pendingRead = read();
      const refused = assert.rejects(pendingRead, /Task changed/);
      await entered;
      if (transition === "account") account = "another-account";
      else {
        const runtime = await gateway.forCurrentOwner();
        runtime.control(task.id, runtime.get(task.id).revision, "pause");
      }
      release();
      await refused;
    }
  });

async function actuatorFixture(t, { leaseMs = 60000, commitGrant } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "eliza-native-refusal-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  const { NativeTaskActuator } = await import(
    (await import("node:url")).pathToFileURL(bundlePath).href
  );
  const state = { refusal: null, effects: 0, bindings: [] };
  let sequence = 0;
  const target = {
    guideTask: async () => ({ visible: false }),
    bindTask: async (binding) => {
      state.bindings.push(binding);
      return {
        bound: true,
        tabId: binding.tabId,
        taskId: binding.taskId,
        epoch: binding.epoch,
        bindingRevision: binding.bindingRevision,
      };
    },
    execute: async (command, options) => {
      if (command.subaction !== "snapshot") {
        if (state.refusal)
          throw Object.assign(new Error("refused"), { kind: state.refusal });
        state.effects++;
        state.options = options;
      }
      const snapshotId = `00000000-0000-0000-0000-${String(++sequence).padStart(12, "0")}`;
      return {
        value: {
          result:
            command.subaction === "snapshot"
              ? {
                  snapshotId,
                  frames: [
                    {
                      frameId: 0,
                      documentId: "document",
                      url: "https://example.org",
                      complete: true,
                      inputRevision: 0,
                      elements: [{ selector: `${snapshotId}:0:0` }],
                      ...(state.violation && state.effects
                        ? { effectViolation: state.violation }
                        : {}),
                      ...(state.consented && state.effects
                        ? { consentedCommit: state.consented }
                        : {}),
                    },
                  ],
                }
              : { dispatched: true },
        },
      };
    },
  };
  let revision = 0;
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: async () => "account",
    authorizeGoal: async (goalRef) => ({
      id: "task",
      goalRef,
      authorization: {
        decisionId: "grant",
        policyRevision: "policy",
        state: "active",
        decidedAt: new Date().toISOString(),
        revokedAt: null,
      },
      allowedCapabilities: ["browser.click"],
      allowedOrigins: ["https://example.org"],
    }),
    actuatorFactory: (host) =>
      new NativeTaskActuator({
        ...host,
        target,
        nextBindingRevision: () => ++revision,
        policy: () => ({
          tabId: "1",
          origin: "https://example.org",
          leaseMs,
          targets: [{ selector: "#ordinary", action: "click" }],
        }),
        resolveValue: async () => {
          throw new Error("No values used");
        },
        describeAction: () => {
          state.beforeDispatch?.();
          return undefined;
        },
        verify: async () => "succeeded",
        recordEvidence: async () => "evidence:test",
        ...(commitGrant ? { commitGrant } : {}),
      }),
  });
  t.after(async () => {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(
    (
      await gateway.handle(
        new Request("http://localhost/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"goalRef":"bill"}',
        }),
      )
    ).status,
    201,
  );
  const runtime = await gateway.forCurrentOwner();
  const click = async (id, extra = {}) => {
    let current = runtime.current();
    current = await runtime.observe(current.id, current.revision);
    return runtime.execute(current.id, current.revision, {
      ...extra,
      id,
      taskId: current.id,
      epoch: current.epoch,
      observationId: current.observation.id,
      observationVersion: current.observation.version,
      inputRevision: 0,
      targetRef: `${current.observation.id}:0:0`,
      capability: "browser.click",
      authorizationId: "grant",
      expiresAt: Date.now() + 10000,
    });
  };
  return { state, runtime, click };
}

test("a browser refusal before the effect is a failed operation, not an unknown outcome", async (t) => {
  const f = await actuatorFixture(t);
  for (const kind of ["STALE_REF", "POLICY_BLOCKED"]) {
    f.state.refusal = kind;
    const task = await f.click(`refused-${kind}`);
    const operation = task.operations.at(-1);
    assert.equal(operation.status, "failed");
    assert.equal(operation.evidenceRef, "not-dispatched");
    // The task stays usable: it can observe and act again.
    assert.equal(task.status, "active");
  }
  f.state.refusal = null;
  assert.equal((await f.click("retry")).operations.at(-1).status, "succeeded");
  assert.equal(f.state.effects, 1);
  // A lost or uncertain reply is still unknown and blocks the task.
  f.state.refusal = "UNCERTAIN_OUTCOME";
  const uncertain = await f.click("uncertain");
  assert.equal(uncertain.operations.at(-1).status, "unknown");
  assert.equal(uncertain.status, "blocked");
});

test("observing after the browser lease expires renews it with a new binding revision", async (t) => {
  // The actuator and task runtime must observe the same advancing clock.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await actuatorFixture(t, { leaseMs: 300 });
  let current = f.runtime.current();
  current = await f.runtime.observe(current.id, current.revision);
  // Within the lease, the binding is reused.
  current = await f.runtime.observe(current.id, current.revision);
  assert.equal(f.state.bindings.length, 1);
  t.mock.timers.tick(350);
  const renewedAt = Date.now();
  current = await f.runtime.observe(current.id, current.revision);
  assert.deepEqual(
    f.state.bindings.map((binding) => binding.bindingRevision),
    [1, 2],
  );
  assert.ok(f.state.bindings[1].expiresAt >= renewedAt + 300);
  assert.equal(current.epoch, f.state.bindings[0].epoch);
  assert.equal(
    (await f.click("after-renewal")).operations.at(-1).status,
    "succeeded",
  );
});

test("a pause while preparing the action sentence prevents dispatch", async (t) => {
  const f = await actuatorFixture(t);
  f.state.beforeDispatch = () => {
    const task = f.runtime.current();
    f.runtime.control(task.id, task.revision, "pause");
  };
  const task = await f.click("paused-before-dispatch");
  assert.equal(task.status, "paused");
  assert.equal(f.state.effects, 0);
});

test("a host-chosen target must be a reviewed target, and a stopped page submit is an unknown outcome", async (t) => {
  const f = await actuatorFixture(t);
  const refused = await f.click("other-target", {
    expectedSelector: "#unreviewed",
  });
  assert.equal(refused.operations.at(-1).status, "failed");
  assert.equal(refused.operations.at(-1).evidenceRef, "not-dispatched");
  assert.equal(f.state.effects, 0);
  const sent = await f.click("reviewed-target", {
    expectedSelector: "#ordinary",
  });
  assert.equal(sent.operations.at(-1).status, "succeeded");
  assert.equal(f.state.options.expectedSelector, "#ordinary");
  // The browser stopped a submit that the click set off. The page is not
  // the reviewed page any more, so the result is not trusted.
  f.state.violation = "submit";
  const stopped = await f.click("set-off-submit");
  assert.equal(stopped.operations.at(-1).status, "unknown");
  assert.equal(stopped.status, "blocked");
});

test("a host commit grant reaches the browser only for its exact action, and its consented commit is trusted", async (t) => {
  let issue = () => undefined;
  const f = await actuatorFixture(t, {
    commitGrant: (task, proposal) => issue(task, proposal),
  });
  const grantFor = (task, proposal, extra = {}) => ({
    grantId: `yes:${proposal.id}`,
    taskId: task.id,
    epoch: task.epoch,
    origin: "https://example.org",
    targetRef: proposal.targetRef,
    selector: "#ordinary",
    subaction: "click",
    expiresAt: Date.now() + 30000,
    ...extra,
  });
  // Without a grant nothing extra is sent: commits stay blocked in the page.
  assert.equal(
    (await f.click("plain", { expectedSelector: "#ordinary" })).operations.at(
      -1,
    ).status,
    "succeeded",
  );
  assert.equal(f.state.options.commitGrant, undefined);
  // A grant for another control, origin, epoch or a long life is refused
  // before anything reaches the browser.
  for (const extra of [
    { selector: "#other" },
    { origin: "https://evil.example" },
    { epoch: 99 },
    { expiresAt: Date.now() + 120000 },
    { subaction: "fill" },
  ]) {
    const effects = f.state.effects;
    issue = (task, proposal) => grantFor(task, proposal, extra);
    const refused = await f.click(`bad-${Object.keys(extra)[0]}`, {
      expectedSelector: "#ordinary",
    });
    assert.equal(refused.operations.at(-1).status, "failed");
    assert.equal(refused.operations.at(-1).evidenceRef, "not-dispatched");
    assert.equal(f.state.effects, effects);
  }
  // A grant needs the reviewed control the person said yes to.
  issue = (task, proposal) => grantFor(task, proposal);
  assert.equal(
    (await f.click("no-target")).operations.at(-1).evidenceRef,
    "not-dispatched",
  );
  // The matching grant is sent with the action; the browser's consented
  // commit for that grant is a verified result, not an unknown one.
  issue = (task, proposal) => {
    f.state.consented = { grantId: `yes:${proposal.id}`, kind: "submit" };
    return grantFor(task, proposal);
  };
  const committed = await f.click("pay", { expectedSelector: "#ordinary" });
  assert.equal(committed.operations.at(-1).status, "succeeded");
  assert.equal(f.state.options.commitGrant.grantId, "yes:pay");
  assert.equal(f.state.options.expectedSelector, "#ordinary");
  // A grant bound to a request and form contents reaches the browser with
  // them; a consented commit reporting the same form hash is trusted.
  const formHash = "d".repeat(64);
  const requestTarget = { path: "/api/pay", method: "POST" };
  issue = (task, proposal) => {
    f.state.consented = {
      grantId: `yes:${proposal.id}`,
      kind: "submit",
      formHash,
    };
    return grantFor(task, proposal, { requestTarget, formHash });
  };
  const bound = await f.click("bound", { expectedSelector: "#ordinary" });
  assert.equal(bound.operations.at(-1).status, "succeeded");
  assert.deepEqual(f.state.options.commitGrant.requestTarget, requestTarget);
  assert.equal(f.state.options.commitGrant.formHash, formHash);
  // A malformed request target never reaches the browser.
  const before = f.state.effects;
  issue = (task, proposal) =>
    grantFor(task, proposal, { requestTarget: { path: "//evil.example" } });
  assert.equal(
    (
      await f.click("bad-request-target", { expectedSelector: "#ordinary" })
    ).operations.at(-1).evidenceRef,
    "not-dispatched",
  );
  assert.equal(f.state.effects, before);
  // A consented commit the host did not grant for this action is unknown.
  issue = () => undefined;
  f.state.consented = { grantId: "yes:someone-else", kind: "submit" };
  const foreign = await f.click("foreign", { expectedSelector: "#ordinary" });
  assert.equal(foreign.operations.at(-1).status, "unknown");
  assert.equal(foreign.status, "blocked");
});

const grant = (id) => ({
  id,
  goalRef: "bill",
  authorization: {
    decisionId: "grant",
    policyRevision: "policy",
    state: "active",
    decidedAt: new Date().toISOString(),
    revokedAt: null,
  },
  allowedCapabilities: ["fill"],
  allowedOrigins: ["https://example.org"],
});
const observation = () => ({
  id: `view-${Date.now()}`,
  pageId: "page",
  origin: "https://example.org",
  version: Date.now(),
  inputRevision: 0,
  observedAt: Date.now(),
});
/** A fill whose reply is lost, so its outcome is unknown. */
const lostReplyActuator = {
  capabilities: ["fill"],
  observe: async () => observation(),
  execute: async () => {
    throw new Error("reply lost");
  },
  reconcile: async () => ({ status: "unknown" }),
};
async function fillWithLostReply(runtime, id) {
  let task = runtime.get(id);
  task = await runtime.observe(id, task.revision);
  return runtime.execute(id, task.revision, {
    id: "fill-1",
    taskId: id,
    epoch: task.epoch,
    observationId: task.observation.id,
    observationVersion: task.observation.version,
    inputRevision: 0,
    targetRef: "field",
    capability: "fill",
    authorizationId: "grant",
    expiresAt: Date.now() + 60000,
  });
}
const send = (gateway, method, path, value) =>
  gateway.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }),
  );

test("the owner fence asks to confirm a read that would end the live owner's tasks", () => {
  const live = ownerFenceStep(initialOwnerFence, {
    type: "read",
    sequence: 1,
    startedEpoch: 0,
    account: "a",
    confirming: false,
  });
  assert.deepEqual(live, {
    fence: { epoch: 0, owner: "a", settled: 1, closed: false },
    decision: "accepted",
    revoke: false,
  });
  const read = (account, confirming, sequence = 2) =>
    ownerFenceStep(live.fence, {
      type: "read",
      sequence,
      startedEpoch: 0,
      account,
      confirming,
    });
  // One failed or changed read never revokes on its own.
  for (const account of [null, "b"])
    assert.deepEqual(read(account, false), {
      fence: live.fence,
      decision: "confirm",
      revoke: false,
    });
  // A confirming read that names the live owner keeps the task.
  assert.deepEqual(read("a", true).revoke, false);
  assert.deepEqual(read(null, true), {
    fence: { epoch: 1, owner: null, settled: 2, closed: false },
    decision: "signed-out",
    revoke: true,
  });
  assert.deepEqual(read("b", true), {
    fence: { epoch: 1, owner: "b", settled: 2, closed: false },
    decision: "accepted",
    revoke: true,
  });
  // A late read, or one from an older epoch, changes nothing.
  const later = read("b", true, 3).fence;
  for (const event of [
    { sequence: 2, startedEpoch: 1, account: "a" },
    { sequence: 4, startedEpoch: 0, account: "b" },
  ])
    assert.equal(
      ownerFenceStep(later, { type: "read", confirming: true, ...event })
        .decision,
      "superseded",
    );
  assert.deepEqual(ownerFenceStep(later, { type: "close" }), {
    fence: { epoch: 2, owner: null, settled: 3, closed: true },
    decision: "signed-out",
    revoke: true,
  });
});

test("one failed credential read does not revoke the signed-in owner's task", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-task-transient-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  let failNext = false;
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: async () => {
      if (!failNext) return "account-a";
      failNext = false;
      // A credential write in progress answers 409 for one read.
      throw Object.assign(new Error("credential changing"), { status: 409 });
    },
    actuator: lostReplyActuator,
    authorizeGoal: async () => grant("task-a"),
  });
  t.after(async () => {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(
    (await send(gateway, "POST", "/tasks", { goalRef: "bill" })).status,
    201,
  );
  failNext = true;
  const response = await send(gateway, "GET", "/tasks/current");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).task.status, "active");
  const runtime = await gateway.forCurrentOwner();
  assert.equal(runtime.get("task-a").authorization.state, "active");
});

test("a revoke reaches every account's task when one runtime fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-task-revoke-all-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  let account = "account-a";
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: async () => account,
    actuator: lostReplyActuator,
  });
  t.after(async () => {
    await gateway.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  const a = await gateway.forCurrentOwner();
  account = "account-b";
  const b = await gateway.forCurrentOwner();
  b.create(grant("task-b"));
  // A runtime whose storage failed cannot even read its current task.
  a.current = () => {
    throw new Error("storage failed");
  };
  await assert.rejects(async () => gateway.revoke(), /storage failed/);
  assert.equal(b.get("task-b").authorization.state, "revoked");
  b.control("task-b", b.get("task-b").revision, "cancel");
  account = "account-b";
  const c = await gateway.forCurrentOwner();
  c.create(grant("task-c"));
  await assert.rejects(async () => gateway.close(), /storage failed/);
  assert.equal(c.get("task-c").authorization.state, "revoked");
});

test("the owner releases a slot held by a revoked task with an unknown outcome", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-task-acknowledge-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  let taskId = "task-a";
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: async () => "account-a",
    actuator: lostReplyActuator,
    authorizeGoal: async () => grant(taskId),
  });
  t.after(async () => {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(
    (await send(gateway, "POST", "/tasks", { goalRef: "bill" })).status,
    201,
  );
  const runtime = await gateway.forCurrentOwner();
  const unknown = await fillWithLostReply(runtime, "task-a");
  assert.equal(unknown.operations[0].status, "unknown");
  // While the authorization is active, readback can still settle it.
  const early = await send(
    gateway,
    "POST",
    "/tasks/task-a/acknowledge-unknown",
    { expectedRevision: runtime.get("task-a").revision },
  );
  assert.equal(early.status, 409);
  assert.equal((await early.json()).code, "TASK_UNKNOWN_OUTCOME");
  // Sign-out revokes the task; readback then needs an authorization it lost.
  await gateway.revoke();
  const { revision } = runtime.get("task-a");
  await assert.rejects(
    runtime.reconcile("task-a", revision, "fill-1", async () => true),
    { code: "TASK_NOT_ACTIVE" },
  );
  taskId = "task-b";
  const blocked = await send(gateway, "POST", "/tasks", { goalRef: "bill" });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, "TASK_CONFLICT");
  const stale = await send(
    gateway,
    "POST",
    "/tasks/task-a/acknowledge-unknown",
    {
      expectedRevision: revision - 1,
    },
  );
  assert.equal(stale.status, 409);
  const acknowledged = await send(
    gateway,
    "POST",
    "/tasks/task-a/acknowledge-unknown",
    { expectedRevision: revision },
  );
  assert.equal(acknowledged.status, 200);
  assert.equal((await acknowledged.json()).status, "cancelled");
  // The outcome is still shown as unknown; nothing says the fill succeeded.
  const shown = await (await send(gateway, "GET", "/tasks/task-a")).json();
  assert.equal(shown.task.status, "cancelled");
  assert.equal(shown.task.hasUnknownOutcome, true);
  assert.equal(runtime.get("task-a").operations[0].status, "unknown");
  assert.equal(
    (await send(gateway, "POST", "/tasks", { goalRef: "bill" })).status,
    201,
  );
});

test("a task record from another version does not stop the gateway", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-task-unreadable-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  let taskId = "task-a";
  const config = {
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: async () => "account-a",
    actuator: lostReplyActuator,
    authorizeGoal: async () => grant(taskId),
  };
  let gateway = await createTaskGateway(config);
  t.after(async () => {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(
    (await send(gateway, "POST", "/tasks", { goalRef: "bill" })).status,
    201,
  );
  await gateway.close();
  // A rollback or a newer build wrote a field this build does not know.
  const db = new DatabaseSync(config.databasePath);
  const { document } = db
    .prepare("SELECT document FROM interactive_task_journal_v1 WHERE id = ?")
    .get("task-a");
  db.prepare(
    "UPDATE interactive_task_journal_v1 SET document = ? WHERE id = ?",
  ).run(JSON.stringify({ ...JSON.parse(document), laterField: 1 }), "task-a");
  db.close();
  gateway = await createTaskGateway(config);
  assert.deepEqual(
    await (await send(gateway, "GET", "/tasks/current")).json(),
    { task: null },
  );
  const listed = await (
    await send(gateway, "GET", "/tasks/current/unreadable")
  ).json();
  assert.deepEqual(
    listed.records.map(({ taskId, reason, acknowledgedAt }) => ({
      taskId,
      reason,
      acknowledgedAt,
    })),
    [
      {
        taskId: "task-a",
        reason: "Unexpected task record fields",
        acknowledgedAt: null,
      },
    ],
  );
  taskId = "task-b";
  const held = await send(gateway, "POST", "/tasks", { goalRef: "bill" });
  assert.equal(held.status, 409);
  assert.equal((await held.json()).code, "TASK_UNREADABLE");
  const released = await send(
    gateway,
    "POST",
    "/tasks/task-a/acknowledge-unreadable",
    {},
  );
  assert.equal(released.status, 200);
  assert.equal(
    typeof (await released.json()).records[0].acknowledgedAt,
    "number",
  );
  assert.equal(
    (await send(gateway, "POST", "/tasks", { goalRef: "bill" })).status,
    201,
  );
});

test("a host extension's save is noted, so an answer after an account change is a 409", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-task-extension-save-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  t.after(() => rm(directory, { recursive: true, force: true }));
  let run = 0;
  // Each extension route saves (or not) the way a host route does, then the
  // account changes before its own last check, as in the bill routes.
  const attempt = async (path) => {
    let account = "account-a";
    const gateway = await createTaskGateway({
      bundlePath,
      databasePath: join(directory, `journal-${++run}.sqlite`),
      credentialGate: async () => account,
      actuator: { capabilities: ["fill"] },
      authorizeGoal: async () => grant("task-a"),
      extensionFactory: ({ db }) => {
        db.exec("CREATE TABLE IF NOT EXISTS notes (owner TEXT NOT NULL)");
        return async (request, { owner, runtime, authenticate }) => {
          const { pathname } = new URL(request.url);
          if (pathname === "/tasks/runtime-save")
            runtime.control("task-a", runtime.get("task-a").revision, "pause");
          else if (pathname === "/tasks/db-save")
            db.prepare("INSERT INTO notes (owner) VALUES (?)").run(
              owner.actorId,
            );
          else if (pathname === "/tasks/no-save")
            db.prepare("UPDATE notes SET owner = owner WHERE 0").run();
          else return;
          account = "account-b";
          const current = await authenticate();
          if (current.actorId !== owner.actorId)
            return Response.json(
              { code: "TASK_UNAUTHORIZED" },
              { status: 401 },
            );
          return Response.json({ saved: true });
        };
      },
    });
    try {
      (await gateway.forCurrentOwner()).create(grant("task-a"));
      const response = await send(gateway, "POST", path, {});
      return { status: response.status, code: (await response.json()).code };
    } finally {
      await gateway.close();
    }
  };
  for (const path of ["/tasks/runtime-save", "/tasks/db-save"])
    assert.deepEqual(
      await attempt(path),
      { status: 409, code: "TASK_ACCOUNT_CHANGED" },
      path,
    );
  assert.deepEqual(await attempt("/tasks/no-save"), {
    status: 401,
    code: "TASK_UNAUTHORIZED",
  });
});

test("the owner record routes read bodies and answer storage failures as the core routes do", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-task-record-routes-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  const databasePath = join(directory, "journal.sqlite");
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath,
    credentialGate: async () => "account-a",
  });
  t.after(async () => {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  });
  const post = (headers, body) =>
    gateway.handle(
      new Request("http://localhost/tasks/task-a/acknowledge-unreadable", {
        method: "POST",
        headers,
        body,
      }),
    );
  // A cross-origin simple POST cannot reach an owner action.
  const plain = await post({ "Content-Type": "text/plain" }, "{}");
  assert.equal(plain.status, 400);
  assert.equal((await plain.json()).code, "TASK_INVALID");
  const large = await post(
    { "Content-Type": "application/json" },
    `{"padding":"${"x".repeat(4096)}"}`,
  );
  assert.equal(large.status, 400);
  assert.equal(
    (await post({ "Content-Type": "application/json" }, "{}")).status,
    404,
  );
  // A storage failure is a 503, never a thrown request or a conflict.
  const db = new DatabaseSync(databasePath);
  db.exec("DROP TABLE interactive_task_quarantine_v1");
  db.close();
  const listed = await send(gateway, "GET", "/tasks/current/unreadable");
  assert.equal(listed.status, 503);
  assert.equal((await listed.json()).code, "TASK_UNAVAILABLE");
  const released = await post({ "Content-Type": "application/json" }, "{}");
  assert.equal(released.status, 503);
  assert.equal((await released.json()).code, "TASK_UNAVAILABLE");
  // Put the table back so the gateway can close.
  const restore = new DatabaseSync(databasePath);
  restore.exec(
    "CREATE TABLE interactive_task_quarantine_v1 (task_id TEXT PRIMARY KEY NOT NULL, owner_key TEXT NOT NULL, reason TEXT NOT NULL, quarantined_at INTEGER NOT NULL, acknowledged_at INTEGER)",
  );
  restore.close();
});

test("two closes at once close the database once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-task-close-twice-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: async () => "account-a",
  });
  const results = await Promise.allSettled([gateway.close(), gateway.close()]);
  assert.deepEqual(
    results.map(({ status, reason }) => reason?.message ?? status),
    ["fulfilled", "fulfilled"],
  );
});

/**
 * Conformance of the owner fence: one account change at the k-th credential
 * read of a request, for every route and every k the request reaches.
 * - "switch": from read k on the gate names account B.
 * - "signed-out": from read k on the gate fails.
 * - "transient": only read k fails, as during a credential write.
 */
test("an account change at any credential read of a request is fenced", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-task-owner-flip-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const routes = [
    ["active", "GET", "/tasks/current"],
    ["active", "GET", "/tasks/task-a"],
    ["active", "GET", "/tasks/task-a/events"],
    ["active", "GET", "/tasks/current/unreadable"],
    ["active", "GET", "/tasks/note"],
    ["active", "POST", "/tasks/note", {}],
    ["empty", "POST", "/tasks", { goalRef: "bill" }],
    ["unknown", "POST", "/tasks/task-a/acknowledge-unknown", "revision"],
    ["active", "POST", "/tasks/task-a/pause", "revision"],
    ["active", "POST", "/tasks/current/pause", {}],
    ["active", "POST", "/tasks/task-a/cancel", "revision"],
    ["paused", "POST", "/tasks/task-a/resume", "revision"],
  ];
  let run = 0;
  async function attempt([setup, method, path, body], flip) {
    let reads = 0;
    let flipAt = Number.POSITIVE_INFINITY;
    const gate = async () => {
      reads++;
      if (
        flip &&
        reads >= flipAt &&
        (flip.variant !== "transient" || reads === flipAt)
      ) {
        if (flip.variant === "switch") return "account-b";
        throw Object.assign(new Error("credential gate failed"), {
          status: 409,
        });
      }
      return "account-a";
    };
    const gateway = await createTaskGateway({
      bundlePath,
      databasePath: join(directory, `journal-${++run}.sqlite`),
      credentialGate: gate,
      actuator: lostReplyActuator,
      authorizeGoal: async () => grant("task-a"),
      extensionFactory: ({ db }) => {
        db.exec("CREATE TABLE IF NOT EXISTS notes (owner TEXT NOT NULL)");
        return async (request, { owner, authenticate, commit }) => {
          if (new URL(request.url).pathname !== "/tasks/note") return;
          await authenticate();
          if (request.method === "POST")
            await commit(() =>
              db
                .prepare("INSERT INTO notes (owner) VALUES (?)")
                .run(owner.actorId),
            );
          return Response.json({
            notes: db
              .prepare("SELECT count(*) AS n FROM notes WHERE owner = ?")
              .get(owner.actorId).n,
          });
        };
      },
    });
    try {
      const runtime = await gateway.forCurrentOwner();
      if (setup !== "empty") runtime.create(grant("task-a"));
      if (setup === "paused") runtime.control("task-a", 0, "pause");
      if (setup === "unknown") {
        await fillWithLostReply(runtime, "task-a");
        await gateway.revoke();
        await gateway.forCurrentOwner();
      }
      const db = new DatabaseSync(join(directory, `journal-${run}.sqlite`));
      // Rows the request saved for account A: notes, tasks, acknowledgements
      // and task events, since every change to a task appends one. The
      // revoke an account change appends is the fence's, not the request's.
      const ofA = `owner_key LIKE '%"account-a"%'`;
      const scopeOfA = () =>
        JSON.stringify(
          [
            "SELECT count(*) AS n FROM notes WHERE owner = 'account-a'",
            `SELECT count(*) AS n FROM interactive_task_journal_v1 WHERE ${ofA}`,
            `SELECT count(*) AS n FROM interactive_task_unknown_acknowledgements_v1 WHERE ${ofA}`,
            `SELECT count(*) AS n FROM interactive_task_events_v1 WHERE ${ofA} AND json_extract(document, '$.kind') <> 'revoke'`,
          ].map((sql) => db.prepare(sql).get().n),
        );
      const before = scopeOfA();
      const task =
        runtime.current() ??
        (setup === "unknown" ? runtime.get("task-a") : null);
      const input =
        body === "revision" ? { expectedRevision: task.revision } : body;
      flipAt = reads + (flip?.k ?? Number.POSITIVE_INFINITY);
      const start = reads;
      const response = await send(gateway, method, path, input);
      const result = {
        status: response.status,
        code: response.ok ? undefined : (await response.json()).code,
        reads: reads - start,
        wroteForA: scopeOfA() !== before,
        authorization: task && runtime.get("task-a").authorization.state,
        ended: task && runtime.get("task-a").status === "cancelled",
      };
      db.close();
      return result;
    } finally {
      await gateway.close();
    }
  }
  let cases = 0;
  const savedThenChanged = new Set();
  for (const route of routes) {
    const [setup, method, path] = route;
    const baseline = await attempt(route);
    assert.ok(
      baseline.status < 300,
      `${method} ${path} works: ${baseline.status} ${baseline.code}`,
    );
    for (const variant of ["switch", "signed-out", "transient"])
      for (let k = 1; k <= baseline.reads; k++) {
        cases++;
        const name = `${variant} at read ${k} of ${method} ${path}`;
        const result = await attempt(route, { variant, k });
        if (variant === "transient") {
          // NoStaleRevoke: one failed read changes nothing.
          assert.equal(result.status, baseline.status, name);
          assert.equal(result.authorization, baseline.authorization, name);
          continue;
        }
        // ResponseFenced: no success once the account changed mid-request;
        // only a switch at the very first read makes the whole request B's.
        if (result.status < 300)
          assert.ok(
            variant === "switch" && k === 1,
            `${name}: ${result.status}`,
          );
        // A 401 means nothing was saved for A; a save is answered 409.
        if (result.status === 401) assert.equal(result.wroteForA, false, name);
        if (result.wroteForA)
          assert.equal(result.code, "TASK_ACCOUNT_CHANGED", name);
        if (result.code === "TASK_ACCOUNT_CHANGED") savedThenChanged.add(path);
        if (result.status < 300) assert.equal(result.wroteForA, false, name);
        // The change revoked A's task, unless the request had already ended it.
        if (setup === "active" || setup === "paused")
          assert.ok(result.authorization === "revoked" || result.ended, name);
      }
  }
  t.diagnostic(`${cases} flip cases`);
  assert.ok(cases > 60);
  // Every route that saves after its last check, host or core, reaches the
  // case where the save landed before the change. A start reads nothing after
  // its save.
  assert.deepEqual([...savedThenChanged].sort(), [
    "/tasks/current/pause",
    "/tasks/note",
    "/tasks/task-a/acknowledge-unknown",
    "/tasks/task-a/cancel",
    "/tasks/task-a/pause",
    "/tasks/task-a/resume",
  ]);
});

/** A provider whose database and statements are frozen, as the SQLCipher one's are. */
const frozenProvider = {
  open: ({ path }) => {
    const db = new DatabaseSync(path);
    return Object.freeze({
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const statement = db.prepare(sql);
        return Object.freeze({
          get: (...params) => statement.get(...params),
          run: (...params) => statement.run(...params),
          all: (...params) => statement.all(...params),
        });
      },
      close: () => db.close(),
    });
  },
  assertEncryption: () => true,
};

test("the gateway runs on a provider whose database and statements are frozen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-task-frozen-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  let account = "account-a";
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    databaseProvider: frozenProvider,
    requireEncryptedDatabase: true,
    credentialGate: async () => account,
    actuator: { capabilities: ["fill"] },
    authorizeGoal: async () => grant("task-a"),
    extensionFactory: ({ db }) => {
      db.exec("CREATE TABLE IF NOT EXISTS notes (owner TEXT NOT NULL)");
      return async (request, { owner, authenticate }) => {
        if (new URL(request.url).pathname !== "/tasks/db-save") return;
        db.prepare("INSERT INTO notes (owner) VALUES (?)").run(owner.actorId);
        assert.equal(db.prepare("SELECT owner FROM notes").all().length, 1);
        account = "account-b";
        await authenticate().catch(() => undefined);
        return Response.json({ saved: true });
      };
    },
  });
  t.after(async () => {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(
    (await send(gateway, "POST", "/tasks", { goalRef: "bill" })).status,
    201,
  );
  assert.equal((await send(gateway, "GET", "/tasks/task-a")).status, 200);
  // A save through the frozen database is still noted on the request.
  const saved = await send(gateway, "POST", "/tasks/db-save", {});
  assert.equal(saved.status, 409);
  assert.equal((await saved.json()).code, "TASK_ACCOUNT_CHANGED");
});

test("a change a host route rolls back is not a save, so the answer is a 401", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-task-rollback-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  let account = "account-a";
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: async () => account,
    actuator: { capabilities: ["fill"] },
    authorizeGoal: async () => grant("task-a"),
    extensionFactory: ({ db }) => {
      db.exec("CREATE TABLE IF NOT EXISTS notes (owner TEXT NOT NULL)");
      return async (request, { owner, authenticate }) => {
        const { pathname } = new URL(request.url);
        if (!pathname.startsWith("/tasks/tx-")) return;
        db.exec("BEGIN IMMEDIATE");
        db.prepare("INSERT INTO notes (owner) VALUES (?)").run(owner.actorId);
        db.exec(pathname === "/tasks/tx-commit" ? "COMMIT" : "ROLLBACK");
        account = account === "account-a" ? "account-b" : "account-a";
        const current = await authenticate();
        if (current.actorId !== owner.actorId)
          return Response.json({ code: "TASK_UNAUTHORIZED" }, { status: 401 });
        return Response.json({ saved: true });
      };
    },
  });
  t.after(async () => {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  });
  const rolledBack = await send(gateway, "POST", "/tasks/tx-rollback", {});
  assert.deepEqual(
    { status: rolledBack.status, code: (await rolledBack.json()).code },
    { status: 401, code: "TASK_UNAUTHORIZED" },
  );
  const committed = await send(gateway, "POST", "/tasks/tx-commit", {});
  assert.deepEqual(
    { status: committed.status, code: (await committed.json()).code },
    { status: 409, code: "TASK_ACCOUNT_CHANGED" },
  );
});

test("an unconfirmed cleanup among other cleanup errors still answers 503", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-task-mixed-cleanup-"));
  const bundlePath = join(directory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath);
  let account = "account-a";
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: async () => account,
    actuator: lostReplyActuator,
  });
  t.after(async () => {
    await gateway.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  const a = await gateway.forCurrentOwner();
  account = "account-b";
  const b = await gateway.forCurrentOwner();
  a.current = () => {
    throw Object.assign(new Error("storage failed"), {
      code: "TASK_STORAGE_FAILED",
    });
  };
  b.settle = async () => {
    throw Object.assign(new Error("cleanup unconfirmed"), {
      code: "TASK_CLEANUP_UNCONFIRMED",
    });
  };
  account = null;
  const response = await send(gateway, "GET", "/tasks/current");
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "TASK_CLEANUP_UNCONFIRMED");
});
