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
 * 600 + rename, tmp unlinked on failure). Lock records bind a live PID to a
 * random owner token, so an aged-but-live writer is never stolen and cleanup
 * cannot remove a replacement owner's lock. Upserts collapse every definition
 * of the written key so parseDotenv's last-wins read cannot resurrect a stale
 * later line, and preserve unrelated lines, comments, and trailing blanks.
 * The parse, merge, and upsert primitives stay unit-testable without touching
 * the real operator files. Values returned by loadLayeredEnv are real secrets:
 * callers must never render them — the display-safe surface is listPresent(),
 * which only reports presence and the winning source layer.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);

/** Home-layer file: shared across every checkout and worktree of this repo. */
export const HOME_ENV_PATH = join(homedir(), ".eliza", ".env");

/** Precedence order, highest first; the values of the `sources` map. */
export const ENV_LAYER_SOURCES = ["process", "repo", "home"];

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 25;
const WRITE_OWNERSHIP_RETRIES = 3;

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

function readLockOwner(lockPath) {
  let record;
  try {
    record = readFileSync(lockPath, "utf8");
  } catch (err) {
    // error-policy:J3 lock ownership changed while contention was inspected
    if (err.code === "ENOENT") return { state: "missing" };
    throw err;
  }

  const match = /^([1-9][0-9]*)(?::([a-f0-9]{32}))?\n$/.exec(record);
  if (!match) {
    let ageMs;
    try {
      ageMs = Date.now() - statSync(lockPath).mtimeMs;
    } catch (err) {
      // error-policy:J3 malformed lock disappeared before its age was checked
      if (err.code === "ENOENT") return { state: "missing" };
      throw err;
    }
    return ageMs > LOCK_STALE_MS
      ? { state: "reclaim", record }
      : { state: "held" };
  }

  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid)) {
    return { state: "held" };
  }
  try {
    process.kill(pid, 0);
    return { state: "held" };
  } catch (err) {
    // error-policy:J3 process liveness is the lock-owner validity boundary
    if (err.code === "ESRCH") return { state: "reclaim", record };
    if (err.code === "EPERM") return { state: "held" };
    throw err;
  }
}

/**
 * Atomically reclaim a lock whose owner was observed dead. rename() is the
 * ownership-transfer primitive: exactly one reclaimer captures the pathname,
 * so two reclaimers can never both pass a compare-and-unlink and admit
 * concurrent writers. If the captured record is not the observed dead one
 * (the lock was re-acquired between observation and rename), the capture is
 * undone with an exclusive link(); when even that loses to a newer lock, the
 * displaced owner is caught by writeSecret's commit-time ownership check.
 */
export function reclaimObservedLock(lockPath, observedRecord) {
  const quarantine = `${lockPath}.reclaim.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    renameSync(lockPath, quarantine);
  } catch (err) {
    // error-policy:J3 losing the rename race means another reclaimer won
    if (err.code === "ENOENT") return true;
    throw err;
  }
  let quarantined;
  try {
    quarantined = readFileSync(quarantine, "utf8");
  } catch (err) {
    // error-policy:J3 quarantine vanished only if the filesystem is hostile
    if (err.code !== "ENOENT") throw err;
    return true;
  }
  if (quarantined === observedRecord) {
    try {
      unlinkSync(quarantine);
    } catch (err) {
      // error-policy:J6 quarantine cleanup is teardown-only
      if (err.code !== "ENOENT") throw err;
    }
    return true;
  }
  // Captured a live re-acquired lock: restore it if the pathname is still
  // free. link() is exclusive, so a newer lock is never clobbered.
  try {
    linkSync(quarantine, lockPath);
  } catch (err) {
    // error-policy:J3 a newer lock appeared; its owner holds the pathname and
    // the displaced owner aborts at commit-time verification
    if (err.code !== "EEXIST") throw err;
  }
  try {
    unlinkSync(quarantine);
  } catch (err) {
    // error-policy:J6 quarantine cleanup is teardown-only
    if (err.code !== "ENOENT") throw err;
  }
  return false;
}

function removeObservedLock(lockPath, observedRecord) {
  try {
    if (readFileSync(lockPath, "utf8") !== observedRecord) return false;
    unlinkSync(lockPath);
    return true;
  } catch (err) {
    // error-policy:J6 another owner released or reclaimed the observed lock
    if (err.code === "ENOENT") return true;
    throw err;
  }
}

function acquireTargetLock(targetPath, waitMs = LOCK_WAIT_MS) {
  const lockPath = `${targetPath}.lock`;
  mkdirSync(dirname(targetPath), { recursive: true });
  const deadline = Date.now() + waitMs;
  while (true) {
    let fd;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (err) {
      // error-policy:J3 exclusive-create miss means another writer holds the lock
      if (err.code !== "EEXIST") throw err;
      const owner = readLockOwner(lockPath);
      if (owner.state === "missing") continue;
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
      continue;
    }

    const ownerRecord = `${process.pid}:${randomBytes(16).toString("hex")}\n`;
    try {
      writeFileSync(fd, ownerRecord);
      return { fd, lockPath, ownerRecord };
    } catch (err) {
      const cleanupErrors = [];
      try {
        closeSync(fd);
      } catch (candidate) {
        // error-policy:J6 partial lock initialization must close its descriptor
        cleanupErrors.push(candidate);
      }
      try {
        unlinkSync(lockPath);
      } catch (candidate) {
        // error-policy:J6 partial lock initialization must remove its lock path
        if (candidate.code !== "ENOENT") cleanupErrors.push(candidate);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [err, ...cleanupErrors],
          `writeSecret: failed to initialize lock ${lockPath}`,
        );
      }
      throw err;
    }
  }
}

function releaseTargetLock(lock) {
  const errors = [];
  try {
    closeSync(lock.fd);
  } catch (err) {
    // error-policy:J6 release attempts both descriptor and owned-path teardown
    errors.push(err);
  }
  try {
    removeObservedLock(lock.lockPath, lock.ownerRecord);
  } catch (err) {
    // error-policy:J6 release attempts both descriptor and owned-path teardown
    errors.push(err);
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `writeSecret: failed to release lock ${lock.lockPath}`,
    );
  }
}

export function atomicWriteEnvFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
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
 * reread, then written atomically (tmp+rename, mode 600). Also sets the key
 * on processEnv so probes running in the same process observe the save
 * immediately. Values must be single-line; multi-line values would corrupt
 * the dotenv format and are rejected.
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
  for (let attempt = 1; attempt <= WRITE_OWNERSHIP_RETRIES; attempt += 1) {
    const lock = acquireTargetLock(path, lockWaitMs);
    let ownershipLost = false;
    try {
      const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (typeof afterRead === "function") {
        afterRead();
      }
      // Commit-time ownership verification: if this writer's lock record was
      // displaced (the reclaim restore edge), abort before the rename commit
      // and retry the whole read-modify-write instead of losing an update.
      if (!stillOwnsLock(lock)) {
        ownershipLost = true;
      } else {
        atomicWriteEnvFile(path, upsertEnvContent(existing, { [key]: value }));
        chmodSync(path, 0o600);
        processEnv[key] = value;
      }
    } catch (err) {
      try {
        releaseTargetLock(lock);
      } catch (releaseError) {
        // error-policy:J2 preserve both the transaction and teardown failures
        throw new AggregateError(
          [err, releaseError],
          `writeSecret(${key}): write and lock release both failed`,
        );
      }
      throw err;
    }
    releaseTargetLock(lock);
    if (!ownershipLost) {
      return { key, scope, path };
    }
  }
  throw new Error(
    `writeSecret(${key}): lock ownership lost ${WRITE_OWNERSHIP_RETRIES} times`,
  );
}

function stillOwnsLock(lock) {
  try {
    return readFileSync(lock.lockPath, "utf8") === lock.ownerRecord;
  } catch (err) {
    // error-policy:J3 a missing lock record means ownership was displaced
    if (err.code === "ENOENT") return false;
    throw err;
  }
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
