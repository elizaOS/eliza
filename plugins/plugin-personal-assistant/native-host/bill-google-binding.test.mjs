import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createTaskGateway } from "../../../packages/host/native-host/task-runtime-gateway.mjs";
import { buildTaskRuntime } from "../test/fixtures/bill-host/runtime.mjs";
import { createBillGoogleBinding } from "./bill-google-binding.mjs";

const goal = (id) => ({
  id,
  goalRef: "bill",
  allowedCapabilities: [],
  allowedOrigins: ["https://biller.example"],
  authorization: {
    decisionId: "consent",
    policyRevision: "v1",
    state: "active",
    decidedAt: new Date().toISOString(),
    revokedAt: null,
  },
});

test("real gateway atomically initializes new tasks; original Google identity survives recovery and account change", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bill-google-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, "runtime.mjs"),
    databasePath = join(root, "tasks.sqlite");
  buildTaskRuntime(bundlePath);
  let account = "owner",
    binding,
    db;
  const open = (initialize = true) =>
    createTaskGateway({
      bundlePath,
      databasePath,
      credentialGate: async () => account,
      actuator: { capabilities: [] },
      ...(initialize
        ? {
            initializeTaskStorage(context) {
              db = context.db;
              binding = createBillGoogleBinding(context);
            },
          }
        : {}),
    });
  let gateway = await open(false);
  let runtime = await gateway.forCurrentOwner();
  runtime.create(goal("legacy"));
  await gateway.close();
  gateway = await open();
  runtime = await gateway.forCurrentOwner();
  assert.throws(() => binding.read(runtime.get("legacy")), /Original Google/);
  // Owner partition permits a separate fresh task without deleting legacy evidence.
  account = "second";
  runtime = await gateway.forCurrentOwner();
  const task = runtime.create(goal("new"));
  assert.equal(binding.read(task), null);
  assert.deepEqual(
    binding.bind(task, {
      accountId: "grant-a",
      email: "original@example.test",
    }),
    { accountId: "grant-a", email: "original@example.test" },
  );
  assert.equal(
    binding.bind(task, { accountId: "grant-b" }).accountId,
    "grant-a",
    "a competing bind cannot overwrite original identity",
  );
  assert.throws(
    () =>
      binding.read({ ...task, owner: { ...task.owner, actorId: "attacker" } }),
    /Original Google/,
  );
  assert.throws(
    () =>
      binding.bind(
        { ...task, revision: task.revision + 1 },
        { accountId: "grant-b" },
      ),
    /Original Google/,
  );
  assert.throws(
    () =>
      binding.bind(
        { ...task, epoch: task.epoch + 1 },
        { accountId: "grant-b" },
      ),
    /Original Google/,
  );
  await gateway.close();
  gateway = await open();
  t.after(() => gateway.close());
  runtime = await gateway.forCurrentOwner();
  const recovered = runtime.get("new");
  assert.deepEqual(binding.read(recovered), {
    accountId: "grant-a",
    email: "original@example.test",
  });
  assert.equal(
    binding.bind(recovered, { accountId: "grant-b" }).accountId,
    "grant-a",
  );
  const concurrentDb = new DatabaseSync(databasePath);
  const concurrent = createBillGoogleBinding({
    db: concurrentDb,
    store: {
      get: (id, owner) => {
        assert.deepEqual(owner, recovered.owner);
        return runtime.get(id);
      },
    },
  });
  assert.equal(
    concurrent.bind(recovered, { accountId: "competing-process" }).accountId,
    "grant-a",
  );
  concurrentDb.close();
  // Restore this host's admission trigger after the competing host closed.
  binding = createBillGoogleBinding({
    db,
    store: { get: (id) => runtime.get(id) },
  });
  // Simulate an atomic task-creation failure: the marker must roll back too.
  db.exec(
    "CREATE TRIGGER fixture_fail_event BEFORE INSERT ON interactive_task_events_v1 BEGIN SELECT RAISE(ABORT, 'fixture crash'); END;",
  );
  account = "third";
  runtime = await gateway.forCurrentOwner();
  assert.throws(() => runtime.create(goal("failed-create")), /fixture crash/);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM bill_google_binding_v1 WHERE task_id = 'failed-create'",
      )
      .get().n,
    0,
  );
  db.exec("DROP TRIGGER fixture_fail_event");
  const unbound = runtime.create(goal("unbound"));
  assert.equal(binding.read(unbound), null);
  await gateway.close();
  gateway = await open();
  runtime = await gateway.forCurrentOwner();
  assert.throws(
    () => binding.bind(runtime.get("unbound"), { accountId: "now-connected" }),
    /Original Google/,
    "restart before first binding never infers the account",
  );
  // Missing and malformed persisted identities also refuse; no fallback to current account.
  const other = new DatabaseSync(databasePath);
  other
    .prepare(
      "UPDATE bill_google_binding_v1 SET account_id = '' WHERE task_id = 'new'",
    )
    .run();
  account = "second";
  runtime = await gateway.forCurrentOwner();
  assert.throws(() => binding.read(runtime.get("new")), /Original Google/);
  other
    .prepare("DELETE FROM bill_google_binding_v1 WHERE task_id = 'new'")
    .run();
  assert.throws(
    () => binding.bind(runtime.get("new"), { accountId: "grant-b" }),
    /Original Google/,
  );
  other.close();
});
