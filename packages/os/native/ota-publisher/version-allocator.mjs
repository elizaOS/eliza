import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_CODE = 2100000000;
const code = (n) => {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_CODE)
    throw Error("Invalid Android versionCode");
  return n;
};
function open(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error("Allocator must be an existing regular file");
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA busy_timeout=10000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;",
  );
  return db;
}
/** Explicit one-time initialization on persistent release infrastructure. Never
 * called implicitly by reservePair: a lost database must stop publication. */
export function initializeAllocator(file, observedHighWatermark) {
  code(observedHighWatermark);
  const fd = fs.openSync(file, "wx", 0o600);
  fs.closeSync(fd);
  let db;
  try {
    db = open(file);
    db.exec(
      "BEGIN IMMEDIATE; CREATE TABLE state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema_version INTEGER NOT NULL CHECK(schema_version=1), high_watermark INTEGER NOT NULL CHECK(high_watermark>=0 AND high_watermark<=2100000000)); CREATE TABLE reservations (release_id TEXT PRIMARY KEY, source_commit TEXT NOT NULL, candidate INTEGER NOT NULL UNIQUE, recovery INTEGER NOT NULL UNIQUE, CHECK(recovery=candidate+1));",
    );
    db.prepare("INSERT INTO state VALUES (1,1,?)").run(observedHighWatermark);
    db.exec("COMMIT");
  } finally {
    db?.close();
  }
  const dir = fs.openSync(path.dirname(path.resolve(file)), "r");
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}
/** publishedCodes must be collected from the complete authoritative publication
 * inventory by the release service, never from a device or release candidate.
 * One persistent database allocates for all channels and distributions. */
export function reservePair(
  file,
  { releaseId, sourceCommit, publishedCodes },
  fault = () => {},
) {
  if (
    typeof releaseId !== "string" ||
    !/^[-a-zA-Z0-9_.]{1,96}$/.test(releaseId) ||
    typeof sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(sourceCommit) ||
    !Array.isArray(publishedCodes)
  )
    throw Error("Invalid reservation");
  for (const n of publishedCodes) code(n);
  const observed = publishedCodes.reduce((a, b) => Math.max(a, b), 0),
    db = open(file);
  try {
    db.exec("BEGIN IMMEDIATE");
    const state = db
      .prepare(
        "SELECT schema_version,high_watermark FROM state WHERE singleton=1",
      )
      .get();
    if (state?.schema_version !== 1) throw Error("Allocator state unavailable");
    code(state.high_watermark);
    const existing = db
      .prepare(
        "SELECT source_commit,candidate,recovery FROM reservations WHERE release_id=?",
      )
      .get(releaseId);
    if (existing) {
      if (existing.source_commit !== sourceCommit)
        throw Error("Release identity reused for another source");
      db.exec("COMMIT");
      return {
        releaseId,
        candidateVersionCode: existing.candidate,
        recoveryVersionCode: existing.recovery,
      };
    }
    const high = Math.max(state.high_watermark, observed);
    if (high > MAX_CODE - 2) throw Error("Android versionCode space exhausted");
    db.prepare("UPDATE state SET high_watermark=? WHERE singleton=1").run(
      high + 2,
    );
    fault("before-reservation");
    db.prepare("INSERT INTO reservations VALUES (?,?,?,?)").run(
      releaseId,
      sourceCommit,
      high + 1,
      high + 2,
    );
    fault("before-commit");
    db.exec("COMMIT");
    fault("committed");
    return {
      releaseId,
      candidateVersionCode: high + 1,
      recoveryVersionCode: high + 2,
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.close();
  }
}
