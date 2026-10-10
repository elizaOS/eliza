import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createTaskGateway } from "@elizaos/host/native-host";
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

test("an extension cannot publish a former-account result after an owner change", async (t) => {
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
      entered();
      await pending;
      return Response.json({ private: "former-owner-result" });
    },
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

async function actuatorFixture(t, { leaseMs = 60000 } = {}) {
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
  const f = await actuatorFixture(t, { leaseMs: 300 });
  let current = f.runtime.current();
  current = await f.runtime.observe(current.id, current.revision);
  // Within the lease, the binding is reused.
  current = await f.runtime.observe(current.id, current.revision);
  assert.equal(f.state.bindings.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 350));
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
