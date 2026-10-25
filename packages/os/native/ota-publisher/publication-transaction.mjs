import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseDescriptorJson } from "./strict-json.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (ok, message) => {
  if (!ok) throw Error(`OTA publication transaction: ${message}`);
};
function open(file) {
  const stat = fs.lstatSync(file);
  fail(stat.isFile() && !stat.isSymbolicLink(), "existing journal required");
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA busy_timeout=10000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON",
  );
  return db;
}
export function initializePublicationJournal(file) {
  const fd = fs.openSync(file, "wx", 0o600);
  fs.closeSync(fd);
  const db = open(file);
  try {
    db.exec(
      "BEGIN IMMEDIATE; CREATE TABLE publication (id TEXT PRIMARY KEY, identity TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('preparing','committing','published')), baseline TEXT, target TEXT NOT NULL, version INTEGER NOT NULL); CREATE UNIQUE INDEX one_active ON publication ((1)) WHERE phase != 'published'; PRAGMA user_version=1; COMMIT;",
    );
  } finally {
    db.close();
  }
  const dir = fs.openSync(path.dirname(path.resolve(file)), "r");
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}
function transact(file, action) {
  const db = open(file);
  try {
    db.exec("BEGIN IMMEDIATE");
    fail(
      db.prepare("PRAGMA user_version").get().user_version === 1,
      "unsupported journal",
    );
    const result = action(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.close();
  }
}
function version(bytes) {
  const m = parseDescriptorJson(bytes);
  fail(
    m?.signed?._type === "timestamp" &&
      Number.isSafeInteger(m.signed.version) &&
      m.signed.version > 0,
    "invalid timestamp version",
  );
  return m.signed.version;
}
function snapshot(input) {
  fail(
    input &&
      /^[-a-zA-Z0-9_.]{1,96}$/.test(input.id) &&
      Array.isArray(input.dependencies) &&
      input.dependencies.length > 0 &&
      input.dependencies.length <= 128,
    "invalid publication plan",
  );
  const timestamp = Buffer.from(input.timestamp),
    seen = new Set();
  fail(timestamp.length > 0 && timestamp.length <= 16384, "timestamp budget");
  let size = timestamp.length;
  const dependencies = input.dependencies
    .map(({ name, bytes }) => {
      fail(
        typeof name === "string" &&
          (/^[1-9]\d*\.(?:root|snapshot|targets|stable|beta)\.json$/.test(
            name,
          ) ||
            /^targets\/(?:stable|beta)\/[a-f0-9]{64}\.(?:launcher|standalone)\.json$/.test(
              name,
            )) &&
          !seen.has(name),
        "invalid/duplicate immutable path",
      );
      seen.add(name);
      const data = Buffer.from(bytes);
      size += data.length;
      fail(
        data.length > 0 &&
          data.length <= 1024 * 1024 &&
          size <= 64 * 1024 * 1024,
        "dependency byte budget",
      );
      return { name, bytes: data, sha256: hash(data) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const target = hash(timestamp),
    v = version(timestamp),
    identity = hash(
      Buffer.from(
        JSON.stringify({
          target,
          dependencies: dependencies.map(({ name, sha256 }) => ({
            name,
            sha256,
          })),
        }),
      ),
    );
  return {
    id: input.id,
    timestamp,
    dependencies,
    target,
    version: v,
    identity,
  };
}
/** Core for a provisioned publisher. No default signer, storage adapter or CLI.
 * authorizeBundle must verify the complete signed TUF graph, pinned trust,
 * source/provenance and fresh local/public APK preflight. Called before writes
 * and again immediately before timestamp CAS; a saved report is insufficient.
 * Storage must supply atomic create-if-absent and timestamp compare-and-swap,
 * with strong readback. Never implement CAS as a read followed by blind PUT.
 * Adapter operations need bounded deadlines; ambiguous errors are retried by
 * rerunning this function with the same id and exact byte plan.
 */
export async function publishMetadataTransaction(
  journal,
  input,
  ports,
  fault = () => {},
) {
  const plan = snapshot(input);
  for (const name of [
    "authorizeBundle",
    "read",
    "putImmutable",
    "compareAndSwapTimestamp",
  ])
    fail(typeof ports?.[name] === "function", `missing ${name}`);
  const copy = () => ({
    id: plan.id,
    timestamp: Buffer.from(plan.timestamp),
    dependencies: plan.dependencies.map((d) => ({
      name: d.name,
      bytes: Buffer.from(d.bytes),
    })),
  });
  await ports.authorizeBundle(copy());
  const initial = await ports.read("timestamp.json");
  fail(
    initial === null || Buffer.isBuffer(initial),
    "invalid timestamp readback",
  );
  const baseline = initial === null ? null : hash(initial);
  const row = transact(journal, (db) => {
    const existing = db
      .prepare("SELECT * FROM publication WHERE id=?")
      .get(plan.id);
    if (existing) {
      fail(
        existing.identity === plan.identity,
        "publication id reused for different bytes",
      );
      return existing;
    }
    fail(baseline !== plan.target, "untracked timestamp already published");
    fail(
      initial === null || plan.version > version(initial),
      "timestamp version must increase",
    );
    db.prepare("INSERT INTO publication VALUES (?,?,'preparing',?,?,?)").run(
      plan.id,
      plan.identity,
      baseline,
      plan.target,
      plan.version,
    );
    return db.prepare("SELECT * FROM publication WHERE id=?").get(plan.id);
  });
  fault("intent-durable");
  // Never replay a completed old transaction over a later timestamp.
  if (row.phase === "published")
    return {
      id: plan.id,
      status: baseline === plan.target ? "published" : "superseded",
      timestampSha256: plan.target,
    };
  fail(
    baseline === row.baseline || baseline === plan.target,
    "timestamp changed by another publisher",
  );
  for (const dependency of plan.dependencies) {
    let existing = await ports.read(dependency.name);
    fail(
      existing === null || Buffer.isBuffer(existing),
      "invalid dependency readback",
    );
    if (existing === null) {
      await ports.putImmutable(dependency.name, Buffer.from(dependency.bytes));
      fault("dependency-written");
      existing = await ports.read(dependency.name);
    }
    fail(
      Buffer.isBuffer(existing) && hash(existing) === dependency.sha256,
      `immutable dependency conflict: ${dependency.name}`,
    );
  }
  fault("dependencies-verified");
  // Reconcile an uncertain prior CAS by observing exact target bytes. Still
  // verify dependencies before recording success; never repair a conflicting one.
  if (baseline !== plan.target) {
    await ports.authorizeBundle(copy());
    for (const dependency of plan.dependencies) {
      const existing = await ports.read(dependency.name);
      fail(
        Buffer.isBuffer(existing) && hash(existing) === dependency.sha256,
        "dependency disappeared before commit",
      );
    }
    transact(journal, (db) =>
      db
        .prepare(
          "UPDATE publication SET phase='committing' WHERE id=? AND phase='preparing'",
        )
        .run(plan.id),
    );
    fault("commit-intent-durable");
    const changed = await ports.compareAndSwapTimestamp(
      row.baseline,
      Buffer.from(plan.timestamp),
    );
    fail(typeof changed === "boolean", "invalid timestamp CAS result");
    fault("timestamp-cas-returned");
  }
  const readback = await ports.read("timestamp.json");
  fail(
    Buffer.isBuffer(readback) && hash(readback) === plan.target,
    "timestamp commit not confirmed",
  );
  transact(journal, (db) =>
    db
      .prepare(
        "UPDATE publication SET phase='published' WHERE id=? AND identity=?",
      )
      .run(plan.id, plan.identity),
  );
  fault("published-durable");
  return { id: plan.id, status: "published", timestampSha256: plan.target };
}
