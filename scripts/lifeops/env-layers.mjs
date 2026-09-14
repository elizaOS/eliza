#!/usr/bin/env node
/**
 * Layered .env resolution for the LifeOps HITL credential tooling (#11632).
 * Credentials can live in three places on an operator machine, and this module
 * is the single arbiter of which one wins: process.env > the current repo's
 * .env > ~/.eliza/.env.
 * The HITL dashboard and lane drivers consume loadLayeredEnv()/listPresent()
 * so a probe sees the same value a paste-and-save produced, no matter which
 * worktree the operator happens to be in.
 *
 * Saves default to ~/.eliza/.env — the layer that survives worktree churn —
 * with repo .env as the per-save alternative. Each target file is serialized
 * through an exclusive lock, reread, then written atomically (tmp file mode
 * 600 + rename, tmp unlinked on failure). A lock is an atomically published,
 * pre-populated directory whose marker binds a live PID to a random owner
 * token. Reclamation removes only the observed token marker, so an aged-live
 * writer and a replacement directory cannot be stolen by a stale observer.
 * Upserts collapse every definition of the written key so parseDotenv's
 * last-wins read cannot resurrect a stale later line, and preserve unrelated
 * lines, comments, and trailing blanks.
 * The parse, merge, and upsert primitives stay unit-testable without touching
 * the real operator files. Values returned by loadLayeredEnv are real secrets:
 * callers must never render them — the display-safe surface is listPresent(),
 * which only reports presence and the winning source layer.
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Home-layer file: shared across every checkout and worktree of this repo. */
export const HOME_ENV_PATH = join(homedir(), ".eliza", ".env");

/** Precedence order, highest first; the values of the `sources` map. */
export const ENV_LAYER_SOURCES = ["process", "repo", "home"];

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 25;
const LOCK_OWNER_FILE_PATTERN = /^owner-([a-f0-9]{32})$/;

// --- pure primitives ---------------------------------------------------------

/**
 * Parse dotenv text: KEY=value with optional `export ` prefix, surrounding
 * single/double quotes stripped, comments and malformed lines skipped.
 * Identical semantics to the v1 dashboard parser so a file written by either
 * tool reads back the same.
 */
export function parseDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      trimmed,
    );
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * Merge layers ordered highest-precedence first; the first layer that defines
 * a key wins. "Defined" means a string value — including the empty string, so
 * an exported-but-empty process.env variable shadows a file value exactly like
 * dotenv's override:false behavior.
 */
export function mergeEnvLayers(layers) {
  const values = {};
  const sources = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.values)) {
      if (typeof value !== "string") continue;
      if (Object.hasOwn(sources, key)) continue;
      values[key] = value;
      sources[key] = layer.source;
    }
  }
  return { values, sources };
}

/**
 * Replace KEY=value lines in dotenv text, preserving unrelated lines,
 * comments, and trailing blank lines. Every definition of a written key is
 * collapsed to one assignment so a later duplicate cannot win at parse time.
 * Keys that were not present are appended. A non-empty result always ends
 * with a newline.
 */
export function upsertEnvContent(existingText, entries) {
  const remaining = new Map(Object.entries(entries));
  const writtenKeys = new Set(remaining.keys());
  const replaced = new Set();
  const nextLines = [];
  if (existingText.length > 0) {
    for (const line of existingText.split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (match && writtenKeys.has(match[1])) {
        if (replaced.has(match[1])) {
          continue;
        }
        replaced.add(match[1]);
        const value = remaining.get(match[1]);
        remaining.delete(match[1]);
        nextLines.push(`${match[1]}=${value}`);
        continue;
      }
      nextLines.push(line);
    }
  }
  for (const [key, value] of remaining) nextLines.push(`${key}=${value}`);
  if (nextLines.length === 0) {
    return "";
  }
  const body = nextLines.join("\n");
  return body.endsWith("\n") ? body : `${body}\n`;
}

/**
 * Load and merge every env layer. Returns:
 *   values  — merged KEY -> value (real secrets; never render these),
 *   sources — KEY -> 'process' | 'repo' | 'home' (winning layer),
 *   layers  — [{ source, path, exists }] for display ("loaded from ...").
 * All roots/paths are injectable for tests; by default the repo root is this
 * checkout.
 */
export function loadLayeredEnv(options = {}) {
  const {
    processEnv = process.env,
    repoRoot = ROOT,
    homeEnvPath = HOME_ENV_PATH,
  } = options;
  const filePaths = [];
  const pushUnique = (source, path) => {
    if (path && !filePaths.some((layer) => layer.path === path)) {
      filePaths.push({ source, path });
    }
  };
  pushUnique("repo", join(repoRoot, ".env"));
  pushUnique("home", homeEnvPath);
  const layers = [
    { source: "process", path: null, exists: true, values: processEnv },
    ...filePaths.map(({ source, path }) => {
      const exists = existsSync(path);
      return {
        source,
        path,
        exists,
        values: exists ? parseDotenv(readFileSync(path, "utf8")) : {},
      };
    }),
  ];
  const { values, sources } = mergeEnvLayers(layers);
  return {
    values,
    sources,
    layers: layers.map(({ source, path, exists }) => ({
      source,
      path,
      exists,
    })),
  };
}

/**
 * Load the layered env and fill process.env with every file-layer value whose
 * key the process does not already define. The lane driver and status
 * collector call this once at startup so their own readiness checks AND the
 * test suites they spawn observe exactly the resolution the dashboard
 * displays; the dashboard itself never calls this (it keeps process.env
 * pristine and reads the merged map instead). Returns the loadLayeredEnv
 * result for layer display.
 */
export function applyLayeredEnvToProcess(options = {}) {
  const loaded = loadLayeredEnv(options);
  const processEnv = options.processEnv ?? process.env;
  for (const [key, value] of Object.entries(loaded.values)) {
    if (processEnv[key] === undefined) processEnv[key] = value;
  }
  return loaded;
}

/**
 * Display-safe presence report for the given env names: present means a
 * non-empty value after trimming; source is the winning layer (attributed even
 * for empty-but-defined values, null when no layer defines the key). Never
 * returns values.
 */
export function listPresent(names, options = {}) {
  const { values, sources } = loadLayeredEnv(options);
  return names.map((name) => {
    const value = values[name];
    return {
      name,
      present: typeof value === "string" && value.trim().length > 0,
      source: sources[name] ?? null,
    };
  });
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ownerMarkerPath(lockPath, token) {
  return join(lockPath, `owner-${token}`);
}

function readLockOwner(lockPath) {
  let lockStat;
  try {
    lockStat = lstatSync(lockPath);
  } catch (err) {
    // error-policy:J3 lock ownership changed while contention was inspected
    if (err.code === "ENOENT") return { state: "missing" };
    throw err;
  }
  // Never follow a lock-path symlink or reinterpret an unexpected file as a
  // lock directory. An operator can remove a malformed entry after timeout.
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
    return { state: "held" };
  }

  let entries;
  try {
    entries = readdirSync(lockPath, { withFileTypes: true });
  } catch (err) {
    // error-policy:J3 the lock directory changed during inspection
    if (err.code === "ENOENT") return { state: "missing" };
    throw err;
  }
  if (entries.length === 0) return { state: "empty" };
  if (entries.length !== 1 || !entries[0].isFile()) {
    return { state: "held" };
  }
  const markerMatch = LOCK_OWNER_FILE_PATTERN.exec(entries[0].name);
  if (!markerMatch) return { state: "held" };
  const token = markerMatch[1];
  const markerPath = ownerMarkerPath(lockPath, token);
  let record;
  try {
    record = readFileSync(markerPath, "utf8");
  } catch (err) {
    // error-policy:J3 marker removal means ownership changed during inspection
    if (err.code === "ENOENT") return { state: "missing" };
    throw err;
  }

  const match = /^([1-9][0-9]*):([a-f0-9]{32})\n$/.exec(record);
  // Published candidates are complete before rename, so malformed or
  // mismatched markers are external corruption and fail closed.
  if (!match || match[2] !== token) return { state: "held" };

  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid)) {
    return { state: "held" };
  }
  try {
    process.kill(pid, 0);
    return { state: "held" };
  } catch (err) {
    // error-policy:J3 process liveness is the lock-owner validity boundary
    if (err.code === "ESRCH") {
      return { state: "reclaim", record, markerPath };
    }
    if (err.code === "EPERM") return { state: "held" };
    throw err;
  }
}

/**
 * Reclaim a dead owner without ever moving the shared lock pathname. The
 * observed token selects one immutable marker name. A replacement lock uses
 * a fresh random name in a new non-empty directory, so a stale observer gets
 * ENOENT for its old marker and cannot remove or rename the new live lock.
 */
export function reclaimObservedLock(lockPath, observedRecord) {
  const observed = /^([1-9][0-9]*):([a-f0-9]{32})\n$/.exec(observedRecord);
  if (!observed) return false;
  try {
    process.kill(Number(observed[1]), 0);
    return false;
  } catch (err) {
    // error-policy:J3 reclaim revalidates death at the mutation boundary
    if (err.code === "EPERM") return false;
    if (err.code !== "ESRCH") throw err;
  }
  const markerPath = ownerMarkerPath(lockPath, observed[2]);
  try {
    if (readFileSync(markerPath, "utf8") !== observedRecord) return false;
    unlinkSync(markerPath);
  } catch (err) {
    // error-policy:J3 an absent token belongs to an already-reclaimed or
    // replacement directory; only a fully absent lock is idempotent success
    if (err.code === "ENOENT") {
      try {
        lstatSync(lockPath);
        return false;
      } catch (lockErr) {
        // error-policy:J3 distinguish an absent lock from a replacement
        if (lockErr.code === "ENOENT") return true;
        throw lockErr;
      }
    }
    throw err;
  }
  try {
    rmdirSync(lockPath);
  } catch (err) {
    // error-policy:J3 another contender may atomically publish a populated
    // replacement directory after marker removal; it must remain untouched
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(err.code)) throw err;
  }
  return true;
}

function removeEmptyLock(lockPath) {
  try {
    rmdirSync(lockPath);
    return true;
  } catch (err) {
    // error-policy:J3 a populated replacement directory is never removable
    if (err.code === "ENOENT") return true;
    if (["ENOTEMPTY", "EEXIST"].includes(err.code)) return false;
    throw err;
  }
}

function cleanupLockCandidate(candidate, primaryError) {
  const cleanupErrors = [];
  try {
    unlinkSync(candidate.candidateMarkerPath);
  } catch (err) {
    // error-policy:J6 unpublished lock-candidate marker cleanup
    if (err.code !== "ENOENT") cleanupErrors.push(err);
  }
  try {
    rmdirSync(candidate.candidatePath);
  } catch (err) {
    // error-policy:J6 unpublished lock-candidate directory cleanup
    if (err.code !== "ENOENT") cleanupErrors.push(err);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `writeSecret: lock candidate cleanup failed for ${candidate.lockPath}`,
    );
  }
}

function acquireTargetLock(targetPath, waitMs = LOCK_WAIT_MS) {
  const lockPath = `${targetPath}.lock`;
  mkdirSync(dirname(targetPath), { recursive: true });
  const token = randomBytes(16).toString("hex");
  const ownerRecord = `${process.pid}:${token}\n`;
  const candidatePath = `${lockPath}.candidate.${process.pid}.${token}`;
  const candidateMarkerPath = ownerMarkerPath(candidatePath, token);
  const candidate = {
    candidateMarkerPath,
    candidatePath,
    lockPath,
    ownerRecord,
  };
  try {
    mkdirSync(candidatePath, { mode: 0o700 });
    writeFileSync(candidateMarkerPath, ownerRecord, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (err) {
    // error-policy:J2 preserve lock initialization and cleanup failures
    cleanupLockCandidate(candidate, err);
    throw err;
  }

  const deadline = Date.now() + waitMs;
  try {
    while (true) {
      try {
        // A prepared directory is already non-empty when published. rename()
        // cannot replace a valid non-empty lock directory on supported hosts.
        renameSync(candidatePath, lockPath);
        return {
          lockPath,
          ownerMarkerPath: ownerMarkerPath(lockPath, token),
          ownerRecord,
        };
      } catch (err) {
        // error-policy:J3 publish failure is contention only when a lock exists
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(err.code)) {
          throw err;
        }
      }
      const owner = readLockOwner(lockPath);
      if (owner.state === "missing") continue;
      if (owner.state === "empty" && removeEmptyLock(lockPath)) continue;
      if (
        owner.state === "reclaim" &&
        reclaimObservedLock(lockPath, owner.record)
      ) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`writeSecret: timed out waiting for lock ${lockPath}`);
      }
      sleepMs(LOCK_POLL_MS);
    }
  } catch (err) {
    // error-policy:J2 preserve acquisition and candidate-cleanup failures
    cleanupLockCandidate(candidate, err);
    throw err;
  }
}

function stillOwnsLock(lock) {
  try {
    return readFileSync(lock.ownerMarkerPath, "utf8") === lock.ownerRecord;
  } catch (err) {
    // error-policy:J3 a missing marker means ownership was displaced
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

function releaseTargetLock(lock) {
  const errors = [];
  if (stillOwnsLock(lock)) {
    try {
      unlinkSync(lock.ownerMarkerPath);
    } catch (err) {
      // error-policy:J6 owned marker cleanup is teardown-only
      if (err.code !== "ENOENT") errors.push(err);
    }
    try {
      rmdirSync(lock.lockPath);
    } catch (err) {
      // error-policy:J6 a populated replacement is owned by another writer
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(err.code)) {
        errors.push(err);
      }
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `writeSecret: failed to release lock ${lock.lockPath}`,
    );
  }
}

export function atomicWriteEnvFile(path, content, options = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    if (
      typeof options.confirmCommit === "function" &&
      !options.confirmCommit()
    ) {
      try {
        unlinkSync(tmp);
      } catch (cleanupErr) {
        // error-policy:J6 rejected commits must not retain plaintext tmp files
        if (cleanupErr.code !== "ENOENT") {
          throw new Error(
            `atomicWriteEnvFile: ownership rejected for ${path} and could not remove ${tmp}`,
            { cause: cleanupErr },
          );
        }
      }
      return false;
    }
    renameSync(tmp, path);
    return true;
  } catch (err) {
    // error-policy:J2 preserve the atomic-write failure through tmp cleanup
    try {
      unlinkSync(tmp);
    } catch (cleanupErr) {
      // error-policy:J6 uncommitted tmp after a failed atomic write
      if (cleanupErr.code !== "ENOENT") {
        throw new Error(
          `atomicWriteEnvFile: failed writing ${path} and could not remove ${tmp}`,
          { cause: err },
        );
      }
    }
    throw err;
  }
}

/**
 * Upsert one KEY=value into the chosen layer file — scope 'home'
 * (~/.eliza/.env, created on first save; the default because it survives
 * worktree churn) or 'repo' (this checkout's .env). The target is locked,
 * reread, then written atomically (tmp+rename, mode 600). The owner marker is
 * confirmed at the final commit gate; because valid reclamation can remove
 * only a dead owner's exact marker, ownership cannot change between that gate
 * and rename through this protocol. Also sets the key on processEnv so probes
 * running in the same process observe the save immediately. Values must be
 * single-line; multi-line values would corrupt the dotenv format and are
 * rejected.
 */
export function writeSecret(key, value, options = {}) {
  const {
    scope = "home",
    repoRoot = ROOT,
    homeEnvPath = HOME_ENV_PATH,
    processEnv = process.env,
    afterRead,
    lockWaitMs = LOCK_WAIT_MS,
  } = options;
  if (typeof key !== "string" || !ENV_KEY_PATTERN.test(key)) {
    throw new Error(`writeSecret: invalid env key ${JSON.stringify(key)}`);
  }
  if (typeof value !== "string" || /[\r\n]/.test(value)) {
    throw new Error(`writeSecret(${key}): value must be a single-line string`);
  }
  if (scope !== "home" && scope !== "repo") {
    throw new Error(
      `writeSecret(${key}): scope must be "home" or "repo", got ${JSON.stringify(scope)}`,
    );
  }
  const path = scope === "home" ? homeEnvPath : join(repoRoot, ".env");
  const lock = acquireTargetLock(path, lockWaitMs);
  try {
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (typeof afterRead === "function") {
      afterRead();
    }
    const committed = atomicWriteEnvFile(
      path,
      upsertEnvContent(existing, { [key]: value }),
      { confirmCommit: () => stillOwnsLock(lock) },
    );
    if (!committed) {
      const ownershipError = new Error(
        `writeSecret(${key}): lock ownership lost before commit`,
      );
      ownershipError.code = "ERR_LOCK_OWNERSHIP_LOST";
      throw ownershipError;
    }
    processEnv[key] = value;
  } catch (err) {
    // error-policy:J2 preserve transaction failure while releasing ownership
    try {
      releaseTargetLock(lock);
    } catch (releaseError) {
      // error-policy:J2 preserve both transaction and teardown failures
      throw new AggregateError(
        [err, releaseError],
        `writeSecret(${key}): write and lock release both failed`,
      );
    }
    throw err;
  }
  releaseTargetLock(lock);
  return { key, scope, path };
}

export function saveEnvVar(key, value, target = "home", options = {}) {
  const saved = writeSecret(key, value, { ...options, scope: target });
  return { key: saved.key, target: saved.scope, path: saved.path };
}

// --- CLI: presence/source inspection (never prints values) -------------------

const IS_MAIN =
  import.meta.main || process.argv[1] === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const names = args.filter((arg) => !arg.startsWith("--"));
  const { layers } = loadLayeredEnv();
  const rows = names.length > 0 ? listPresent(names) : [];
  if (json) {
    console.log(JSON.stringify({ layers, present: rows }, null, 2));
  } else {
    for (const layer of layers) {
      console.log(
        `${layer.source.padEnd(8)} ${layer.path ?? "(process.env)"}${layer.exists ? "" : " (absent)"}`,
      );
    }
    for (const row of rows) {
      console.log(
        `${row.present ? "present" : "absent "} [${row.source ?? "-"}] ${row.name}`,
      );
    }
  }
}
