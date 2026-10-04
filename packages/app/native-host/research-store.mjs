import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NativeHostError } from "./errors.mjs";

const invalid = () => {
  throw Object.assign(new NativeHostError("Invalid pilot request"), {
    status: 400,
  });
};
const denied = () => {
  throw Object.assign(new NativeHostError("Pilot access denied"), {
    status: 403,
  });
};
export const traceKinds = [
  "app",
  "navigation",
  "task",
  "input",
  "guidance",
  "browser",
  "tool",
  "model",
  "asr",
  "tts",
  "connector",
  "network",
  "storage",
  "crash",
  "gap",
];
const id = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const exact = (v, keys) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const canonical = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
const digest = (v) => createHash("sha256").update(canonical(v)).digest("hex");
export function validateTraceEvent(e) {
  const keys = [
    "eventId",
    "participantId",
    "deviceId",
    "sessionId",
    "taskId",
    "requestId",
    "sequence",
    "at",
    "monotonicMs",
    "kind",
    "status",
    "durationMs",
    "redacted",
    "unavailable",
  ];
  if (
    !exact(e, keys) ||
    ["eventId", "participantId", "deviceId", "sessionId"].some(
      (k) => !id(e[k]),
    ) ||
    !["taskId", "requestId"].every((k) => e[k] === null || id(e[k])) ||
    !integer(e.sequence) ||
    e.sequence < 1 ||
    !integer(e.at) ||
    !(e.monotonicMs === null || integer(e.monotonicMs)) ||
    !traceKinds.includes(e.kind) ||
    ![
      "started",
      "succeeded",
      "failed",
      "cancelled",
      "paused",
      "resumed",
      "unknown",
      "manual",
      "missing",
      "completed",
    ].includes(e.status) ||
    !(e.durationMs === null || integer(e.durationMs)) ||
    !Array.isArray(e.redacted) ||
    e.redacted.some(
      (x) => !["password", "code", "token", "financial", "content"].includes(x),
    ) ||
    new Set(e.redacted).size !== e.redacted.length ||
    !Array.isArray(e.unavailable) ||
    e.unavailable.some(
      (x) =>
        ![
          "screen",
          "audio",
          "dom",
          "model-content",
          "speech-content",
          "os",
        ].includes(x),
    ) ||
    new Set(e.unavailable).size !== e.unavailable.length
  )
    invalid();
}
export function openResearchStore({
  path,
  key,
  retentionMs,
  maxEvents,
  now = Date.now,
  measurementPolicy,
}) {
  if (
    typeof measurementPolicy?.validateDataset !== "function" ||
    typeof measurementPolicy?.report !== "function"
  )
    throw new TypeError("Explicit research measurement policy is required");
  if (
    !Buffer.isBuffer(key) ||
    key.length !== 32 ||
    !Number.isSafeInteger(retentionMs) ||
    retentionMs < 60000 ||
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < 10 ||
    maxEvents > 1000000
  )
    invalid();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new NativeHostError("Unsafe pilot database path");
  }
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(
    "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS pilot_records (id TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pilot_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, document TEXT NOT NULL)",
  );
  const seal = (value, aad) => {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad));
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return JSON.stringify({
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      bytes: bytes.toString("base64"),
    });
  };
  const unseal = (text, aad) => {
    const v = JSON.parse(text),
      cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(v.iv, "base64"),
      );
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(Buffer.from(v.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        cipher.update(Buffer.from(v.bytes, "base64")),
        cipher.final(),
      ]).toString(),
    );
  };
  const read = (id) => {
    const row = db
      .prepare("SELECT document FROM pilot_records WHERE id=?")
      .get(id);
    return row ? unseal(row.document, id) : null;
  };
  const write = (id, value) =>
    db
      .prepare("INSERT OR REPLACE INTO pilot_records VALUES (?,?)")
      .run(id, seal(value, id));
  try {
    const first = db.prepare("SELECT id FROM pilot_records LIMIT 1").get();
    if (first) read(first.id);
    if (!read("key-check")) write("key-check", { version: 1 });
  } catch (error) {
    db.close();
    throw error;
  }
  const audit = (actor, action, result = "allowed") => {
    db.prepare("INSERT INTO pilot_audit(document) VALUES (?)").run(
      seal(
        { actor: actor.name, role: actor.role, action, result, at: now() },
        "audit",
      ),
    );
    const removed = db
      .prepare(
        "DELETE FROM pilot_audit WHERE sequence NOT IN (SELECT sequence FROM pilot_audit ORDER BY sequence DESC LIMIT 100000)",
      )
      .run().changes;
    if (removed) {
      const old = read("audit-retention") ?? { removed: 0 };
      write("audit-retention", {
        removed: old.removed + Number(removed),
        lastPrunedAt: now(),
        reason: "capacity",
      });
    }
  };
  const allow = (actor, roles, action) => {
    if (!actor || !id(actor.name) || !roles.includes(actor.role)) {
      if (actor && id(actor.name)) audit(actor, action, "denied");
      denied();
    }
    audit(actor, action);
  };
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const enrollmentKey = (p) => `enrollment:${p}`;
  const enrollments = () =>
    db
      .prepare(
        "SELECT id,document FROM pilot_records WHERE id LIKE 'enrollment:%'",
      )
      .all()
      .map((row) => unseal(row.document, row.id));
  const events = () =>
    db
      .prepare("SELECT id,document FROM pilot_records WHERE id LIKE 'trace:%'")
      .all()
      .map((row) => ({ key: row.id, ...unseal(row.document, row.id) }));
  function prune() {
    const threshold = now() - retentionMs;
    let expired = 0;
    for (const event of events())
      if (event.receivedAt < threshold) {
        db.prepare("DELETE FROM pilot_records WHERE id=?").run(event.key);
        expired++;
      }
    if (expired) {
      const retention = read("retention") ?? { expired: 0 };
      write("retention", {
        expired: retention.expired + expired,
        lastPrunedAt: now(),
      });
    }
  }
  function enrollment(actor, participant) {
    const value = read(enrollmentKey(participant));
    if (!value || value.status === "withdrawn") denied();
    if (
      actor.role === "device" &&
      (actor.participantId !== participant || actor.deviceId !== value.deviceId)
    )
      denied();
    return value;
  }

  return {
    enroll(actor, input) {
      allow(actor, ["admin"], "enroll");
      if (!read("dataset"))
        throw Object.assign(
          new NativeHostError(
            "Define study windows, targets and minimum counts before enrollment",
          ),
          { status: 409 },
        );
      if (
        !exact(input, [
          "participantId",
          "deviceId",
          "consentVersion",
          "authorizedAt",
        ]) ||
        !id(input.participantId) ||
        !id(input.deviceId) ||
        !id(input.consentVersion) ||
        !integer(input.authorizedAt) ||
        input.authorizedAt > now()
      )
        invalid();
      if (read(enrollmentKey(input.participantId)))
        throw Object.assign(new NativeHostError("Enrollment already exists"), {
          status: 409,
        });
      const value = {
        ...input,
        status: "active",
        revision: 1,
        changedAt: now(),
      };
      write(enrollmentKey(input.participantId), value);
      return value;
    },
    enrollments(actor) {
      allow(actor, ["admin", "engineer", "researcher"], "enrollments");
      return enrollments();
    },
    capture(actor, input) {
      if (!exact(input, ["participantId", "status", "expectedRevision"]))
        invalid();
      const { participantId, status, expectedRevision } = input;
      allow(actor, ["admin", "device"], "capture-control");
      if (
        !id(participantId) ||
        !["active", "paused", "withdrawn"].includes(status) ||
        !integer(expectedRevision)
      )
        invalid();
      return transaction(() => {
        const value = enrollment(actor, participantId);
        if (value.revision !== expectedRevision)
          throw Object.assign(
            new NativeHostError("Enrollment changed; reload before updating"),
            { status: 409 },
          );
        const next = {
          ...value,
          status,
          revision: value.revision + 1,
          changedAt: now(),
        };
        write(enrollmentKey(participantId), next);
        const controls = read(`controls:${participantId}`) ?? [];
        controls.push({ status, at: now(), revision: next.revision });
        if (controls.length > 1000) controls.splice(0, controls.length - 1000);
        write(`controls:${participantId}`, controls);
        if (status === "withdrawn") {
          for (const event of events())
            if (event.event.participantId === participantId)
              db.prepare("DELETE FROM pilot_records WHERE id=?").run(event.key);
          const dataset = read("dataset");
          if (dataset) {
            dataset.data.participants = dataset.data.participants.filter(
              (p) => p !== participantId,
            );
            dataset.data.tasks = dataset.data.tasks.filter(
              (t) => t.participantId !== participantId,
            );
            dataset.data.coverage = dataset.data.coverage.filter(
              (c) => c.participantId !== participantId,
            );
            dataset.revision++;
            write("dataset", dataset);
          }
        }
        return next;
      });
    },
    captureState(actor) {
      allow(actor, ["device"], "capture-state");
      const value = read(enrollmentKey(actor.participantId));
      if (!value || value.deviceId !== actor.deviceId) denied();
      return {
        participantId: value.participantId,
        deviceId: value.deviceId,
        authorizedAt: value.authorizedAt,
        status: value.status,
        changes: read(`controls:${value.participantId}`) ?? [],
        omittedControlCount: Math.max(0, value.revision - 1 - 1000),
      };
    },
    ingest(actor, batch) {
      allow(actor, ["device"], "ingest");
      if (
        !Array.isArray(batch) ||
        batch.length < 1 ||
        batch.length > 100 ||
        new Set(batch.map((e) => e?.eventId)).size !== batch.length
      )
        invalid();
      for (const e of batch) validateTraceEvent(e);
      return transaction(() => {
        prune();
        let count = events().length;
        const accepted = [];
        for (const event of batch) {
          const enrolled = enrollment(actor, event.participantId);
          if (
            enrolled.status !== "active" ||
            event.deviceId !== enrolled.deviceId
          )
            denied();
          const controls = read(`controls:${event.participantId}`) ?? [];
          if (
            (enrolled.revision > 1001 &&
              event.at < (controls[0]?.at ?? Infinity)) ||
            [{ at: enrolled.authorizedAt, status: "active" }, ...controls]
              .filter((c) => c.at <= event.at)
              .at(-1)?.status !== "active"
          )
            denied();
          const eventKey = `trace:${digest([event.participantId, event.deviceId, event.sessionId, event.eventId])}`,
            old = read(eventKey);
          if (old) {
            if (digest(old.event) !== digest(event))
              throw Object.assign(
                new NativeHostError("Event ID reused with different content"),
                { status: 409 },
              );
            accepted.push(event.eventId);
            continue;
          }
          if (count >= maxEvents)
            throw Object.assign(
              new NativeHostError(
                "Trace capacity reached; retain the device queue and report a storage gap",
              ),
              { status: 507 },
            );
          const streamKey = `stream:${digest([event.participantId, event.deviceId, event.sessionId])}`,
            stream = read(streamKey) ?? { sequence: 0, monotonicMs: 0 };
          if (
            event.sequence <= stream.sequence ||
            (event.monotonicMs !== null &&
              stream.monotonicMs !== null &&
              event.monotonicMs < stream.monotonicMs)
          )
            throw Object.assign(
              new NativeHostError("Trace ordering conflict"),
              { status: 409 },
            );
          const record = {
            event,
            receivedAt: now(),
            clockOffsetMs: now() - event.at,
            sequenceGap: event.sequence - stream.sequence - 1,
            clockRegression: event.at < (stream.at ?? 0),
          };
          write(eventKey, record);
          write(streamKey, {
            sequence: event.sequence,
            monotonicMs: event.monotonicMs,
            at: event.at,
          });
          count++;
          accepted.push(event.eventId);
        }
        return { durable: true, accepted };
      });
    },
    traces(actor, filter = {}) {
      allow(actor, ["engineer", "admin"], "read-traces");
      if (
        !filter ||
        typeof filter !== "object" ||
        Array.isArray(filter) ||
        Object.keys(filter).some(
          (k) =>
            ![
              "participantId",
              "deviceId",
              "sessionId",
              "taskId",
              "from",
              "to",
            ].includes(k),
        )
      )
        invalid();
      for (const [k, v] of Object.entries(filter))
        if (["from", "to"].includes(k) ? !integer(v) : !id(v)) invalid();
      prune();
      const matching = events()
        .filter(({ event }) =>
          Object.entries(filter).every(([k, v]) =>
            k === "from"
              ? event.at >= v
              : k === "to"
                ? event.at <= v
                : event[k] === v,
          ),
        )
        .sort(
          (a, b) =>
            a.receivedAt - b.receivedAt || a.event.sequence - b.event.sequence,
        );
      return {
        events: matching.map(({ key, ...r }) => r),
        hasMore: false,
        total: matching.length,
        retention: read("retention"),
        auditRetention: read("audit-retention"),
        captureControls: enrollments()
          .filter(
            (e) =>
              !filter.participantId || e.participantId === filter.participantId,
          )
          .map((e) => ({
            participantId: e.participantId,
            status: e.status,
            omittedControlCount: Math.max(0, e.revision - 1 - 1000),
            changes: read(`controls:${e.participantId}`) ?? [],
          })),
        capabilities: {
          structuralEvents: true,
          rawScreen: false,
          rawAudio: false,
          rawText: false,
        },
      };
    },
    exportTraces(actor, filter) {
      allow(actor, ["admin"], "export-traces");
      return this.traces(actor, filter);
    },
    dataset(actor, value) {
      allow(actor, ["admin", "researcher"], "measurement-write");
      if (
        !exact(value, ["expectedRevision", "data"]) ||
        !integer(value.expectedRevision)
      )
        invalid();
      measurementPolicy.validateDataset(value.data);
      return transaction(() => {
        for (const p of value.data.participants) enrollment(actor, p);
        const old = read("dataset");
        if (old && canonical(old.data.study) !== canonical(value.data.study))
          throw Object.assign(
            new NativeHostError(
              "Study definitions are frozen after the first import",
            ),
            { status: 409 },
          );
        if ((old?.revision ?? 0) !== value.expectedRevision)
          throw Object.assign(
            new NativeHostError(
              "Measurement dataset changed; reload before editing",
            ),
            { status: 409 },
          );
        const next = {
          revision: value.expectedRevision + 1,
          data: value.data,
          updatedAt: now(),
          operator: actor.name,
        };
        write("dataset", next);
        return { revision: next.revision };
      });
    },
    readDataset(actor) {
      allow(actor, ["admin", "researcher"], "measurement-evidence-read");
      return read("dataset") ?? { revision: 0, data: null };
    },
    report(actor) {
      allow(actor, ["admin", "researcher", "partner"], "measurement-read");
      const value = read("dataset");
      if (!value) return { revision: 0, report: null };
      return {
        revision: value.revision,
        report: measurementPolicy.report(value.data, {
          partner: actor.role === "partner",
        }),
      };
    },
    audit(actor) {
      allow(actor, ["admin"], "audit-read");
      return db
        .prepare(
          "SELECT sequence,document FROM pilot_audit ORDER BY sequence DESC",
        )
        .all()
        .map((row) => ({
          sequence: row.sequence,
          ...unseal(row.document, "audit"),
        }));
    },
    rotateKey(actor, nextKey) {
      allow(actor, ["admin"], "rotate-storage-key");
      if (!Buffer.isBuffer(nextKey) || nextKey.length !== 32) invalid();
      const records = db
        .prepare("SELECT id,document FROM pilot_records")
        .all()
        .map((row) => ({ ...row, value: unseal(row.document, row.id) }));
      const audits = db
        .prepare("SELECT sequence,document FROM pilot_audit")
        .all()
        .map((row) => ({ ...row, value: unseal(row.document, "audit") }));
      const previousKey = key;
      try {
        transaction(() => {
          key = nextKey;
          for (const row of records)
            db.prepare("UPDATE pilot_records SET document=? WHERE id=?").run(
              seal(row.value, row.id),
              row.id,
            );
          for (const row of audits)
            db.prepare(
              "UPDATE pilot_audit SET document=? WHERE sequence=?",
            ).run(seal(row.value, "audit"), row.sequence);
        });
      } catch (error) {
        key = previousKey;
        throw error;
      }
      return { records: records.length, auditEntries: audits.length };
    },
    close() {
      db.close();
    },
  };
}
