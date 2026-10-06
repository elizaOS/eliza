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
