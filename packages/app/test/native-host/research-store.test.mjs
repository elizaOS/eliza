import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import {
  createResearchServer,
  createTraceTransport,
  openResearchStore,
  startResearchCapture,
  validateTraceEvent,
} from "@elizaos/host/native-host";

const measurementPolicy = {
  validateDataset: (data) => {
    assert.ok(Array.isArray(data.participants));
    assert.ok(Array.isArray(data.tasks));
    assert.ok(Array.isArray(data.coverage));
    assert.ok(data.study);
  },
  report: (data) => ({ participantCount: data.participants.length }),
};
const openPilotStore = (options) =>
  openResearchStore({ ...options, measurementPolicy });
const createPilotServer = (options) =>
  createResearchServer({
    ...options,
    readAsset: () => "<main>Pilot research fixture</main>",
  });
const createPilotTransport = (options) =>
  createTraceTransport({ ...options, validateEvent: validateTraceEvent });
const admin = { name: "operator", role: "admin" },
  device = {
    name: "device",
    role: "device",
    participantId: "p1",
    deviceId: "d1",
  };
const event = (sequence = 1) => ({
  eventId: "event" + sequence,
  participantId: "p1",
  deviceId: "d1",
  sessionId: "s1",
  taskId: "t1",
  requestId: null,
  sequence,
  at: 100,
  monotonicMs: sequence,
  kind: "task",
  status: "started",
  durationMs: null,
  redacted: ["content"],
  unavailable: ["screen", "audio"],
});
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "pilot-test-")),
    key = randomBytes(32);
  let now = 1000;
  const store = openPilotStore({
    path: join(dir, "store.sqlite"),
    key,
    retentionMs: 60000,
    maxEvents: 10,
    now: () => now,
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const empty = dataset();
  empty.participants = [];
  empty.tasks = [];
  empty.coverage = [];
  store.dataset(admin, { expectedRevision: 0, data: empty });
  store.enroll(admin, {
    participantId: "p1",
    deviceId: "d1",
    consentVersion: "approved_v1",
    authorizedAt: 1,
  });
  return { store, dir, key, time: (v) => (now = v) };
}
const task = (id, at, mode, role = "none") => ({
  id,
  participantId: "p1",
  category: "bill",
  acceptedAt: at,
  startMode: mode === "eliza" ? "eliza" : "alone",
  elizaJoinedAt: null,
  status: "completed",
  outcome: {
    at: at + 1,
    source: "observed",
    evidenceRef: "evidence" + id,
    verified: true,
  },
  support: [
    {
      at,
      kind: "task",
      mode: role === "none" ? mode : "human",
      role,
      source: "observed",
    },
  ],
  traceRef: null,
});
const dataset = () => ({
  schemaVersion: 1,
  study: {
    id: "test",
    categories: ["bill"],
    baseline: { from: 0, to: 100 },
    followup: { from: 100, to: 200 },
    cutoff: 300,
    minimumParticipants: 2,
    minimumTasksPerParticipant: 1,
    targets: { assistedCompletion: 0.8, caregiverReductionPoints: 10 },
  },
  participants: ["p1"],
  tasks: [
    task("baseline", 10, "alone", "caregiver"),
    task("assisted", 110, "eliza"),
    task("researcher", 120, "alone", "researcher"),
  ],
  coverage: [
    {
      participantId: "p1",
      period: "baseline",
      status: "complete",
      source: "diary",
    },
  ],
});
test("pilot encrypted storage, role isolation, durable dedupe, gap and withdrawal", (t) => {
  const { store, dir } = setup(t);
  assert.throws(() => store.traces({ name: "partner", role: "partner" }), {
    status: 403,
  });
  assert.throws(() => store.readDataset({ name: "partner", role: "partner" }), {
    status: 403,
  });
  assert.equal(store.readDataset(admin).revision, 1);
  assert.deepEqual(store.ingest(device, [event()]), {
    durable: true,
    accepted: ["event1"],
  });
  store.ingest(device, [event()]);
  store.ingest(device, [event(3)]);
  assert.equal(store.traces(admin).events[1].sequenceGap, 1);
  assert.throws(() => store.ingest(device, [{ ...event(4), password: "no" }]), {
    status: 400,
  });
  store.dataset(admin, { expectedRevision: 1, data: dataset() });
  assert.throws(
    () => store.dataset(admin, { expectedRevision: 0, data: dataset() }),
    { status: 409 },
  );
  assert.equal(
    readFileSync(join(dir, "store.sqlite")).includes(
      Buffer.from("approved_v1"),
    ),
    false,
  );
  store.capture(admin, {
    participantId: "p1",
    status: "paused",
    expectedRevision: 1,
  });
  assert.throws(() => store.ingest(device, [event(4)]), { status: 403 });
  store.capture(admin, {
    participantId: "p1",
    status: "withdrawn",
    expectedRevision: 2,
  });
  assert.equal(store.traces(admin).total, 0);
  assert.equal(store.report(admin).report.participantCount, 0);
  assert.throws(
    () =>
      store.capture(admin, {
        participantId: "p1",
        status: "active",
        expectedRevision: 3,
      }),
    { status: 403 },
  );
});
test("trace retention records explicit expiration", (t) => {
  const { store, time } = setup(t);
  store.ingest(device, [event()]);
  time(62000);
  const r = store.traces(admin);
  assert.equal(r.total, 0);
  assert.equal(r.retention.expired, 1);
});
test("console HTTP authentication and cross-origin isolation", async (t) => {
  const { store } = setup(t),
    token = randomBytes(32).toString("hex");
  const server = createPilotServer({
    store,
    operators: [
      {
        ...admin,
        tokenSha256: createHash("sha256").update(token).digest("hex"),
      },
    ],
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(url + "/api/report")).status, 401);
  assert.equal(
    (
      await fetch(url + "/api/report", {
        headers: {
          Authorization: "Bearer " + token,
          Origin: "https://elsewhere.test",
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(url + "/api/me", {
        headers: { Authorization: "Bearer " + token },
      })
    ).status,
    200,
  );
  assert.match(await (await fetch(url)).text(), /Pilot research/);
});
test("storage key rotation re-encrypts records and audit without losing evidence", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-rotation-")),
    path = join(dir, "db"),
    key = randomBytes(32),
    nextKey = randomBytes(32);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = openPilotStore({ path, key, retentionMs: 60000, maxEvents: 10 });
  const empty = dataset();
  empty.participants = [];
  empty.tasks = [];
  empty.coverage = [];
  store.dataset(admin, { expectedRevision: 0, data: empty });
  assert.ok(store.rotateKey(admin, nextKey).records);
  store.close();
  store = openPilotStore({
    path,
    key: nextKey,
    retentionMs: 60000,
    maxEvents: 10,
  });
  assert.equal(store.report(admin).revision, 1);
  assert.ok(store.audit(admin).some((e) => e.action === "rotate-storage-key"));
  store.close();
  assert.throws(() =>
    openPilotStore({ path, key, retentionMs: 60000, maxEvents: 10 }),
  );
});
test("protected HTTP transport binds the enrolled device and acknowledges actual storage", async (t) => {
  const { store } = setup(t),
    token = randomBytes(32).toString("hex");
  const server = createPilotServer({
    store,
    operators: [
      {
        ...device,
        tokenSha256: createHash("sha256").update(token).digest("hex"),
      },
    ],
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const transport = createPilotTransport({
    url: "http://127.0.0.1:" + server.address().port,
    token,
  });
  assert.equal((await transport.captureState()).participantId, "p1");
  assert.deepEqual(await transport.upload([event()]), {
    durable: true,
    accepted: ["event1"],
  });
  store.capture(admin, {
    participantId: "p1",
    status: "withdrawn",
    expectedRevision: 1,
  });
  assert.equal((await transport.captureState()).status, "withdrawn");
  await assert.rejects(transport.upload([event(2)]), /unavailable/);
  assert.throws(() =>
    createPilotTransport({ url: "http://remote.invalid", token }),
  );
});

test("research store requires explicit measurement policy before opening storage", () => {
  assert.throws(
    () =>
      openResearchStore({
        path: "/unopened",
        key: randomBytes(32),
        retentionMs: 60000,
        maxEvents: 10,
      }),
    /measurement policy/,
  );
});

test("configured host captures to the real collector and stops on withdrawal", {
  timeout: 5000,
}, async (t) => {
  const { store, dir } = setup(t),
    token = randomBytes(32).toString("hex");
  const server = createPilotServer({
    store,
    operators: [
      {
        ...device,
        tokenSha256: createHash("sha256").update(token).digest("hex"),
      },
    ],
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const owner = {
    agentId: "agent",
    actorId: "account",
    connector: { source: "test", accountId: "account" },
  };
  const gateway = {
    collectPilotEvidence: (factory) =>
      factory({
        db: { prepare: () => ({ all: () => [{ id: "private-task" }] }) },
        tasks: {
          events: (_id, _owner, cursor) => ({
            events:
              cursor < 0 ? [{ sequence: 0, at: 100, kind: "create" }] : [],
            cursor: 0,
            hasMore: false,
          }),
        },
        owner,
        isCurrentOwner: () => true,
      }).collect(),
  };
  let uploaded, withdrawn;
  const didUpload = new Promise((r) => (uploaded = r)),
    didWithdraw = new Promise((r) => (withdrawn = r));
  const worker = startResearchCapture({
    gateway,
    intervalMs: 10,
    config: {
      queuePath: join(dir, "host.sqlite"),
      encryptionKey: randomBytes(32).toString("base64"),
      pseudonymKey: randomBytes(32).toString("base64"),
      ownerSha256: createHash("sha256").update("account").digest("hex"),
      participantId: "p1",
      deviceId: "d1",
      collectorUrl: "http://127.0.0.1:" + server.address().port,
      deviceToken: token,
    },
    onStatus: (s) => {
      if (s.uploaded === 1) uploaded();
      if (s.state === "withdrawn") withdrawn();
    },
  });
  t.after(() => worker.stop());
  try {
    await didUpload;
    assert.equal(store.traces(admin).total, 1);
    store.capture(admin, {
      participantId: "p1",
      status: "withdrawn",
      expectedRevision: 1,
    });
    await didWithdraw;
    assert.equal(store.traces(admin).total, 0);
  } finally {
    await worker.stop();
  }
});

test("stopping pilot capture aborts an unanswered collector request and releases its lease", {
  timeout: 3000,
}, async (t) => {
  const http = await import("node:http");
  const { existsSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "pilot-stop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let entered;
  const requestStarted = new Promise((resolve) => {
    entered = resolve;
  });
  const server = http.createServer(() => entered());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const queuePath = join(dir, "queue.sqlite");
  const capture = startResearchCapture({
    gateway: {
      collectPilotEvidence: () =>
        assert.fail("collector has not authorized capture"),
    },
    config: {
      collectorUrl: `http://127.0.0.1:${server.address().port}`,
      deviceToken: randomBytes(32).toString("hex"),
      queuePath,
      encryptionKey: randomBytes(32).toString("base64"),
    },
  });
  t.after(() => capture.stop());
  await requestStarted;
  assert.equal(existsSync(queuePath + ".lock"), true);
  await capture.stop();
  await capture.stop();
  assert.equal(existsSync(queuePath + ".lock"), false);
});

// Compile the immutable production journal before timed transport tests begin.
let SqliteInteractiveTaskStore;
const taskBundleDirectory = mkdtempSync(
  join(tmpdir(), "research-task-source-"),
);
before(async () => {
  const { execFileSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { buildTaskRuntime } = await import(
    "../../scripts/build-consumer-task-runtime.mjs"
  );
  const sourceRoot = resolve(import.meta.dirname, "../../../..");
  const bundlePath = join(taskBundleDirectory, "task-runtime.mjs");
  buildTaskRuntime(bundlePath, {
    sourceRoot,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
    }).trim(),
  });
  ({ SqliteInteractiveTaskStore } = await import(
    pathToFileURL(bundlePath).href
  ));
});
after(() => rmSync(taskBundleDirectory, { recursive: true, force: true }));

test("configured capture drains a full queue and resumes complete real task history", {
  timeout: 10000,
}, async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { store, dir } = setup(t);
  const db = new DatabaseSync(join(dir, "journal.sqlite"));
  db.exec("PRAGMA synchronous=FULL");
  t.after(() => db.close());
  const tasks = new SqliteInteractiveTaskStore(db);
  const owner = {
    agentId: "agent",
    actorId: "account",
    connector: { source: "fixture", accountId: "account" },
  };
  const task = tasks.create({
    id: "real-task",
    owner,
    goalRef: "observed-goal",
    now: 100,
    authorization: {
      decisionId: "fixture-grant",
      policyRevision: "fixture-policy",
      state: "active",
      decidedAt: new Date(100).toISOString(),
      revokedAt: null,
    },
    allowedCapabilities: ["fill"],
    allowedOrigins: ["https://example.org"],
  });
  tasks.transition(
    task.id,
    { owner, expectedRevision: task.revision, now: 101 },
    { type: "pause" },
  );
  const token = randomBytes(32).toString("hex");
  const server = createPilotServer({
    store,
    operators: [
      {
        ...device,
        tokenSha256: createHash("sha256").update(token).digest("hex"),
      },
    ],
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  let complete;
  const completed = new Promise((r) => {
    complete = r;
  });
  const worker = startResearchCapture({
    gateway: {
      collectPilotEvidence: (factory) =>
        factory({ db, tasks, owner, isCurrentOwner: () => true }).collect(),
    },
    intervalMs: 10,
    config: {
      queuePath: join(dir, "bounded-queue.sqlite"),
      maxEvents: 1,
      encryptionKey: randomBytes(32).toString("base64"),
      pseudonymKey: randomBytes(32).toString("base64"),
      ownerSha256: createHash("sha256").update(owner.actorId).digest("hex"),
      participantId: "p1",
      deviceId: "d1",
      collectorUrl: `http://127.0.0.1:${server.address().port}`,
      deviceToken: token,
    },
    onStatus: () => {
      if (store.traces(admin).total === 2) complete();
    },
  });
  t.after(() => worker.stop());
  t.signal.addEventListener("abort", complete, { once: true });
  try {
    await completed;
    assert.deepEqual(
      store.traces(admin).events.map((entry) => entry.event.status),
      ["started", "paused"],
    );
  } finally {
    await worker.stop();
  }
});

test("authorized export and audit return complete retained evidence", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "research-complete-export-"));
  const store = openPilotStore({
    path: join(dir, "store.sqlite"),
    key: randomBytes(32),
    retentionMs: 60000,
    maxEvents: 1100,
    now: () => 1000,
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.dataset(admin, {
    expectedRevision: 0,
    data: { study: {}, participants: [], tasks: [], coverage: [] },
  });
  store.enroll(admin, {
    participantId: "p1",
    deviceId: "d1",
    consentVersion: "approved",
    authorizedAt: 1,
  });
  for (let start = 1; start <= 1001; start += 100)
    store.ingest(
      device,
      Array.from({ length: Math.min(100, 1002 - start) }, (_, i) =>
        event(start + i),
      ),
    );
  const exported = store.exportTraces(admin, {});
  assert.equal(exported.total, 1001);
  assert.equal(exported.events.length, 1001);
  assert.equal(exported.hasMore, false);
  assert.equal(
    new Set(exported.events.map(({ event }) => event.eventId)).size,
    1001,
  );
  for (let i = 0; i < 1001; i++) store.readDataset(admin);
  assert.ok(store.audit(admin).length > 1000);
});
