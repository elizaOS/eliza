// Durable producer queue. Transport is supplied by the authenticated deployment;
// retries never remove events until the collector confirms the exact batch IDs.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { NativeHostError } from "./errors.mjs";
export function openTraceQueue({
  path,
  key,
  maxEvents = 10000,
  validateEvent,
}) {
  if (typeof validateEvent !== "function")
    throw new TypeError("Explicit trace event validation is required");
  if (
    !Buffer.isBuffer(key) ||
    key.length !== 32 ||
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < 1
  )
    throw new NativeHostError("Invalid trace queue configuration");
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new NativeHostError("Unsafe pilot database path");
  }
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(
    "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS trace_queue (sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS trace_queue_state (id INTEGER PRIMARY KEY CHECK(id=1),dropped INTEGER NOT NULL); INSERT OR IGNORE INTO trace_queue_state VALUES(1,0)",
  );
  const seal = (value, id) => {
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(id));
    const b = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
    return JSON.stringify({
      iv: iv.toString("base64"),
      tag: c.getAuthTag().toString("base64"),
      bytes: b.toString("base64"),
    });
  };
  const unseal = (text, id) => {
    const v = JSON.parse(text),
      c = createDecipheriv("aes-256-gcm", key, Buffer.from(v.iv, "base64"));
    c.setAAD(Buffer.from(id));
    c.setAuthTag(Buffer.from(v.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        c.update(Buffer.from(v.bytes, "base64")),
        c.final(),
      ]).toString(),
    );
  };
  db.exec(
    "CREATE TABLE IF NOT EXISTS trace_checkpoints (id TEXT PRIMARY KEY,document TEXT NOT NULL)",
  );
  try {
    const checkpoint = db
      .prepare("SELECT id,document FROM trace_checkpoints LIMIT 1")
      .get();
    if (checkpoint) unseal(checkpoint.document, "checkpoint:" + checkpoint.id);
    const first = db
      .prepare("SELECT id,document FROM trace_queue LIMIT 1")
      .get();
    if (first) unseal(first.document, first.id);
  } catch (error) {
    db.close();
    throw error;
  }
  db.exec("CREATE TABLE IF NOT EXISTS withdrawal (id INTEGER PRIMARY KEY)");
  let flushing = false;
  return {
    append(event) {
      validateEvent(event);
      if (db.prepare("SELECT id FROM withdrawal").get())
        throw new NativeHostError("Capture withdrawn");
      const previous = db
        .prepare("SELECT document FROM trace_queue WHERE id=?")
        .get(event.eventId);
      if (previous) {
        if (
          JSON.stringify(unseal(previous.document, event.eventId)) !==
          JSON.stringify(event)
        )
          throw new NativeHostError("Queued event ID reused");
        return;
      }
      if (
        db.prepare("SELECT count(*) AS n FROM trace_queue").get().n >= maxEvents
      ) {
        db.prepare(
          "UPDATE trace_queue_state SET dropped=dropped+1 WHERE id=1",
        ).run();
        throw new NativeHostError("Trace queue full; collection gap recorded", {
          code: "TRACE_QUEUE_FULL",
        });
      }
      db.prepare("INSERT INTO trace_queue(id,document) VALUES(?,?)").run(
        event.eventId,
        seal(event, event.eventId),
      );
    },
    checkpoint(sourceId, cursor) {
      if (
        typeof sourceId !== "string" ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(sourceId)
      )
        throw new NativeHostError("Invalid trace checkpoint");
      if (cursor === undefined) {
        const row = db
          .prepare("SELECT document FROM trace_checkpoints WHERE id=?")
          .get(sourceId);
        return row ? unseal(row.document, "checkpoint:" + sourceId).cursor : -1;
      }
      if (
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        db.prepare("SELECT id FROM withdrawal").get()
      )
        throw new NativeHostError("Invalid trace checkpoint");
      db.prepare("INSERT OR REPLACE INTO trace_checkpoints VALUES(?,?)").run(
        sourceId,
        seal({ cursor }, "checkpoint:" + sourceId),
      );
    },
    status() {
      return {
        queued: db.prepare("SELECT count(*) AS n FROM trace_queue").get().n,
        dropped: db
          .prepare("SELECT dropped FROM trace_queue_state WHERE id=1")
          .get().dropped,
      };
    },
    async flush(transport) {
      if (flushing) return { busy: true };
      flushing = true;
      try {
        const rows = db
          .prepare(
            "SELECT id,document FROM trace_queue ORDER BY sequence LIMIT 100",
          )
          .all();
        if (!rows.length) return { uploaded: 0 };
        const events = rows.map((row) => unseal(row.document, row.id));
        const reply = await transport(events);
        if (
          reply?.durable !== true ||
          !Array.isArray(reply.accepted) ||
          reply.accepted.length !== rows.length ||
          new Set(reply.accepted).size !== rows.length ||
          rows.some((row) => !reply.accepted.includes(row.id))
        )
          throw new NativeHostError("Durable trace acknowledgement missing");
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const row of rows)
            db.prepare("DELETE FROM trace_queue WHERE id=?").run(row.id);
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        return { uploaded: rows.length };
      } finally {
        flushing = false;
      }
    },
    withdraw() {
      db.exec(
        "BEGIN IMMEDIATE; DELETE FROM trace_queue; DELETE FROM trace_checkpoints; INSERT OR IGNORE INTO withdrawal VALUES(1); COMMIT",
      );
    },
    close() {
      if (flushing)
        throw new NativeHostError("Wait for trace upload before closing queue");
      db.close();
    },
  };
}

// One in-flight upload, bounded exponential backoff, and an explicit stop handle.
// The deployment supplies transport and lifecycle ownership; never auto-connect.
export function startTraceUpload({
  queue,
  transport,
  onStatus = () => {},
  minimumDelayMs = 1000,
  maximumDelayMs = 60000,
}) {
  if (
    typeof transport !== "function" ||
    !Number.isInteger(minimumDelayMs) ||
    minimumDelayMs < 10 ||
    !Number.isInteger(maximumDelayMs) ||
    maximumDelayMs < minimumDelayMs
  )
    throw new NativeHostError("Invalid trace retry configuration");
  let stopped = false,
    timer,
    pending,
    delay = minimumDelayMs;
  const tick = async () => {
    try {
      const result = await queue.flush(transport);
      delay = minimumDelayMs;
      if (!stopped)
        onStatus({ state: "connected", ...result, ...queue.status() });
    } catch {
      delay = Math.min(maximumDelayMs, delay * 2);
      if (!stopped)
        onStatus({ state: "retrying", retryAfterMs: delay, ...queue.status() });
    } finally {
      if (!stopped)
        timer = setTimeout(() => {
          pending = tick();
        }, delay);
    }
  };
  pending = tick();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await pending;
    },
  };
}
