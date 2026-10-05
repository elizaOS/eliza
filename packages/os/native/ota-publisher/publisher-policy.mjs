import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const roles = Object.freeze([
  "root",
  "timestamp",
  "snapshot",
  "targets",
  "stable",
  "beta",
]);
const requireValue = (ok, message) => {
  if (!ok) throw Error(`OTA publisher policy: ${message}`);
};
function validate(versions) {
  requireValue(
    versions &&
      Object.keys(versions).length === roles.length &&
      roles.every(
        (role) => Number.isSafeInteger(versions[role]) && versions[role] > 0,
      ),
    "complete safe role versions required",
  );
}
function open(file) {
  const stat = fs.lstatSync(file);
  requireValue(
    stat.isFile() && !stat.isSymbolicLink(),
    "existing regular policy required",
  );
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA busy_timeout=10000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON",
  );
  return db;
}
function read(db) {
  requireValue(
    db.prepare("PRAGMA user_version").get().user_version === 1,
    "unsupported policy schema",
  );
  const rows = db.prepare("SELECT role, version FROM floors").all(),
    versions = Object.fromEntries(rows.map((r) => [r.role, r.version]));
  validate(versions);
  return versions;
}
/** Explicit provisioning only. Missing/corrupt policy must never auto-reset. */
export function initializePublisherPolicy(file, versions) {
  validate(versions);
  const fd = fs.openSync(file, "wx", 0o600);
  fs.closeSync(fd);
  const db = open(file);
  try {
    db.exec(
      "BEGIN IMMEDIATE; CREATE TABLE floors (role TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version > 0)); PRAGMA user_version=1",
    );
    for (const role of roles)
      db.prepare("INSERT INTO floors VALUES (?,?)").run(role, versions[role]);
    db.exec("COMMIT");
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
export function readPublisherPolicy(file, trustedUpperMs) {
  requireValue(
    Number.isSafeInteger(trustedUpperMs) && trustedUpperMs > 0,
    "qualified time required",
  );
  const db = open(file);
  try {
    db.exec("BEGIN");
    const minimumVersions = read(db);
    db.exec("COMMIT");
    return { trustedUpperMs, minimumVersions };
  } finally {
    db.close();
  }
}
/** Caller supplies versions from a freshly verified complete signed graph.
 * Persist before publication: a crash may conservatively raise floors before a
 * timestamp is published, but can never authorize rollback. Retrying exact
 * versions is permitted. Concurrent stale authorization fails atomically.
 */
export function advancePublisherPolicy(file, versions) {
  validate(versions);
  const db = open(file);
  try {
    db.exec("BEGIN IMMEDIATE");
    const before = read(db);
    requireValue(
      roles.every((role) => versions[role] >= before[role]),
      "concurrent role rollback",
    );
    for (const role of roles)
      db.prepare("UPDATE floors SET version=? WHERE role=?").run(
        versions[role],
        role,
      );
    db.exec("COMMIT");
    return { ...versions };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.close();
  }
}
