import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireExclusiveDatabaseLease } from "./database-lease.mjs";
import { openTraceQueue, startTraceUpload } from "./trace-queue.mjs";
import { createTraceTransport } from "./trace-transport.mjs";

const event = (id) => ({ eventId: id, kind: "task", status: "started" });
const validateEvent = (value) => {
  assert.deepEqual(Object.keys(value).sort(), ["eventId", "kind", "status"]);
  assert.match(value.eventId, /^[a-z0-9]+$/);
  assert.equal(value.kind, "task");
  assert.equal(value.status, "started");
};
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "eliza-trace-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    path: join(dir, "trace.sqlite"),
    key: randomBytes(32),
    validateEvent,
  };
}

test("encrypted queue persists events and checkpoints and rejects schemas and wrong keys", (t) => {
  const config = fixture(t);
  let q = openTraceQueue(config);
  q.append(event("privateevent1"));
  q.checkpoint("source", 12);
  q.append(event("privateevent1"));
  assert.throws(() =>
    q.append({ ...event("privateevent2"), transcript: "private text" }),
  );
  assert.equal(q.status().queued, 1);
  q.close();
  assert.equal(
    readFileSync(config.path).includes(Buffer.from('"kind":"task"')),
    false,
  );
  assert.throws(() => openTraceQueue({ ...config, key: randomBytes(32) }));
  q = openTraceQueue(config);
  assert.equal(q.status().queued, 1);
  assert.equal(q.checkpoint("source"), 12);
  q.withdraw();
  q.close();
  q = openTraceQueue(config);
  assert.equal(q.status().queued, 0);
  assert.equal(q.checkpoint("source"), -1);
  assert.throws(() => q.append(event("privateevent3")), /withdrawn/);
  q.close();
});
test("only exact durable acknowledgements delete events; flush is serialized and withdrawal survives late replies", async (t) => {
  const q = openTraceQueue(fixture(t));
  t.after(() => q.close());
  q.append(event("a"));
  q.append(event("b"));
  for (const reply of [
    { accepted: ["a", "b"] },
    { durable: true, accepted: ["a"] },
    { durable: true, accepted: ["a", "a"] },
  ]) {
    await assert.rejects(
      q.flush(async () => reply),
      /acknowledgement/,
    );
    assert.equal(q.status().queued, 2);
  }
  let release;
  const first = q.flush(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  assert.deepEqual(
    await q.flush(async () => {
      throw Error("must not send twice");
    }),
    { busy: true },
  );
  assert.throws(() => q.close(), /Wait/);
  q.withdraw();
  release({ durable: true, accepted: ["a", "b"] });
  await first;
  assert.equal(q.status().queued, 0);
  assert.throws(() => q.append(event("c")), /withdrawn/);
});
test("queue overflow is explicit and uploads retry without losing an event", async (t) => {
  const q = openTraceQueue({ ...fixture(t), maxEvents: 1 });
  t.after(() => q.close());
  q.append(event("a"));
  assert.throws(() => q.append(event("b")), /full/);
  assert.deepEqual(q.status(), { queued: 1, dropped: 1 });
  let attempts = 0,
    done;
  const completed = new Promise((resolve) => {
    done = resolve;
  });
  const states = [];
  const worker = startTraceUpload({
    queue: q,
    minimumDelayMs: 10,
    maximumDelayMs: 20,
    transport: async (events) => {
      if (++attempts === 1) throw Error("offline");
      return { durable: true, accepted: events.map((e) => e.eventId) };
    },
    onStatus: (status) => {
      states.push(status.state);
      if (status.uploaded === 1) done();
    },
  });
  await completed;
  await worker.stop();
  assert.deepEqual(states, ["retrying", "connected"]);
  assert.equal(q.status().queued, 0);
});
test("database lease rejects concurrent ownership and releases explicitly", (t) => {
  const { path } = fixture(t);
  const release = acquireExclusiveDatabaseLease(path);
  assert.throws(() => acquireExclusiveDatabaseLease(path), { code: "EEXIST" });
  release();
  release();
  acquireExclusiveDatabaseLease(path)();
});
test("trace transport uses authenticated HTTP, validates before sending and honors caller cancellation", async (t) => {
  let requests = 0;
  const token = randomBytes(32).toString("hex");
  const server = http.createServer(async (req, res) => {
    requests++;
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let raw = "";
    for await (const bytes of req) raw += bytes;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/api/capture"
          ? { status: "active" }
          : { durable: true, accepted: JSON.parse(raw).map((e) => e.eventId) },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const transport = createTraceTransport({ url, token, validateEvent });
  assert.deepEqual(await transport.captureState(), { status: "active" });
  assert.deepEqual(await transport.upload([event("a")]), {
    durable: true,
    accepted: ["a"],
  });
  assert.throws(() =>
    transport.upload([{ ...event("b"), transcript: "not allowed" }]),
  );
  assert.equal(requests, 2);
  assert.throws(() =>
    createTraceTransport({
      url: "http://remote.invalid",
      token,
      validateEvent,
    }),
  );
  assert.throws(() => createTraceTransport({ url, token }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createTraceTransport({
      url,
      token,
      validateEvent,
      signal: controller.signal,
    }).captureState(),
  );
  assert.equal(requests, 2);
});

test("an old database owner cannot release a replacement lease", (t) => {
  const { path } = fixture(t);
  const releaseOld = acquireExclusiveDatabaseLease(path);
  renameSync(path + ".lock", path + ".old-lock");
  const releaseNew = acquireExclusiveDatabaseLease(path);
  assert.throws(releaseOld, /ownership changed/);
  assert.throws(() => acquireExclusiveDatabaseLease(path), { code: "EEXIST" });
  releaseNew();
});
