#!/usr/bin/env node
/**
 * Committed evidence ledger for HITL connector auth-path validation (#11632).
 * docs/testing/hitl-ledger.json records, per connector auth path (a
 * CONNECTOR_PATHS id), when that path last ran and last succeeded against the
 * real provider: { pathId, lastSuccessAt, lastRunAt, lane, commit, counts }.
 * `counts` mirrors the run-11632-live-lanes summary shape
 * { passed, failed, skipped }. The HITL dashboard writes one entry per probe
 * (lane "dashboard-probe"); lane drivers can record with their own lane ids.
 * The file is committed evidence, so it must never contain secrets — only
 * path ids, timestamps, lane names, commit shas, and counts — and entries are
 * kept sorted by pathId for stable diffs.
 *
 * Freshness policy (locked): green when lastSuccessAt is within 7 days,
 * yellow beyond 7, red beyond 30 or never proven.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);

export const LEDGER_PATH = join(ROOT, "docs/testing/hitl-ledger.json");

export const FRESH_DAYS = 7;
export const STALE_DAYS = 30;
const DAY_MS = 86_400_000;
const LEDGER_KEYS = new Set(["version", "updatedAt", "entries"]);
const ENTRY_KEYS = new Set([
  "pathId",
  "lastSuccessAt",
  "lastRunAt",
  "lane",
  "commit",
  "counts",
]);
const OUTCOME_KEYS = new Set([
  "pathId",
  "ok",
  "at",
  "lane",
  "commit",
  "counts",
]);
const COUNT_KEYS = new Set(["passed", "failed", "skipped"]);
const SECRET_SHAPED_KEY_PATTERN =
  /(token|secret|password|credential|private[_-]?key|api[_-]?key|auth)/i;

function assertNoUnknownKeys(label, object, allowed) {
  for (const key of Object.keys(object)) {
    if (SECRET_SHAPED_KEY_PATTERN.test(key)) {
      throw new Error(
        `hitl-ledger(${label}): secret-shaped field '${key}' is forbidden`,
      );
    }
    if (!allowed.has(key)) {
      throw new Error(`hitl-ledger(${label}): unknown field '${key}'`);
    }
  }
}

function assertCounts(counts, label) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    throw new Error(`hitl-ledger(${label}): counts must be an object`);
  }
  assertNoUnknownKeys(`${label}.counts`, counts, COUNT_KEYS);
  for (const key of COUNT_KEYS) {
    if (!Number.isInteger(counts[key]) || counts[key] < 0) {
      throw new Error(
        `hitl-ledger(${label}): counts.${key} must be a non-negative integer`,
      );
    }
  }
}

function assertIsoOrNull(value, label) {
  if (value === null) return;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`hitl-ledger(${label}): timestamp must be ISO or null`);
  }
}

function assertLedgerEntry(pathId, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`hitl-ledger(${pathId}): entry must be an object`);
  }
  assertNoUnknownKeys(pathId, entry, ENTRY_KEYS);
  if (entry.pathId !== pathId) {
    throw new Error(
      `hitl-ledger(${pathId}): entry.pathId must match its ledger key`,
    );
  }
  assertIsoOrNull(entry.lastSuccessAt, `${pathId}.lastSuccessAt`);
  assertIsoOrNull(entry.lastRunAt, `${pathId}.lastRunAt`);
  if (typeof entry.lane !== "string" || typeof entry.commit !== "string") {
    throw new Error(`hitl-ledger(${pathId}): lane and commit are required`);
  }
  assertCounts(entry.counts, pathId);
}

/**
 * Read the ledger, or the empty shape when the file does not exist yet. A
 * malformed file throws: this is committed evidence, not a regenerable cache,
 * so silent discard would erase proof history.
 */
export function readLedger(path = LEDGER_PATH) {
  if (!existsSync(path)) return { version: 1, updatedAt: null, entries: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof parsed.entries !== "object" ||
    parsed.entries === null
  ) {
    throw new Error(
      `hitl-ledger: malformed ledger at ${path} — restore it from git history rather than regenerating`,
    );
  }
  assertNoUnknownKeys("root", parsed, LEDGER_KEYS);
  for (const [pathId, entry] of Object.entries(parsed.entries)) {
    assertLedgerEntry(pathId, entry);
  }
  return {
    version: parsed.version ?? 1,
    updatedAt: parsed.updatedAt ?? null,
    entries: parsed.entries,
  };
}

/**
 * Locked freshness bands from lastSuccessAt: green ≤7d, yellow >7d,
 * red >30d-or-never. Returns { state, ageDays, label } for direct rendering.
 */
export function freshness(lastSuccessAt, now = Date.now()) {
  if (typeof lastSuccessAt !== "string" || lastSuccessAt.length === 0) {
    return { state: "red", ageDays: null, label: "never proven" };
  }
  const successMs = Date.parse(lastSuccessAt);
  if (Number.isNaN(successMs)) {
    throw new Error(`hitl-ledger: unparseable lastSuccessAt ${lastSuccessAt}`);
  }
  const ageDays = Math.max(0, Math.floor((now - successMs) / DAY_MS));
  if (ageDays <= FRESH_DAYS) {
    return { state: "green", ageDays, label: `proven ${ageDays}d ago` };
  }
  if (ageDays <= STALE_DAYS) {
    return { state: "yellow", ageDays, label: `stale — ${ageDays}d ago` };
  }
  return { state: "red", ageDays, label: `stale — ${ageDays}d ago` };
}

function assertOutcome(outcome) {
  const { pathId, ok, at, lane, commit, counts } = outcome;
  assertNoUnknownKeys("outcome", outcome, OUTCOME_KEYS);
  if (typeof pathId !== "string" || pathId.length === 0) {
    throw new Error("hitl-ledger: outcome.pathId must be a non-empty string");
  }
  if (ok !== true && ok !== false && ok !== null) {
    throw new Error(`hitl-ledger(${pathId}): ok must be true, false, or null`);
  }
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) {
    throw new Error(`hitl-ledger(${pathId}): at must be an ISO timestamp`);
  }
  if (typeof lane !== "string" || typeof commit !== "string") {
    throw new Error(`hitl-ledger(${pathId}): lane and commit are required`);
  }
  assertCounts(counts, pathId);
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/**
 * Merge a batch of outcomes into the ledger with a single read+write, so
 * probe-all's parallel results cannot lose updates to read-modify-write
 * interleaving. `lastSuccessAt` only advances on ok === true; a failed or
 * skipped run updates lastRunAt but preserves the last proof.
 */
export function recordOutcomes(outcomes, path = LEDGER_PATH) {
  for (const outcome of outcomes) assertOutcome(outcome);
  const ledger = readLedger(path);
  for (const { pathId, ok, at, lane, commit, counts } of outcomes) {
    const prior = ledger.entries[pathId];
    ledger.entries[pathId] = {
      pathId,
      lastSuccessAt: ok === true ? at : (prior?.lastSuccessAt ?? null),
      lastRunAt: at,
      lane,
      commit,
      counts: {
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
      },
    };
  }
  const entries = Object.fromEntries(
    Object.keys(ledger.entries)
      .sort()
      .map((key) => [key, ledger.entries[key]]),
  );
  const next = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries,
  };
  atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function recordOutcome(outcome, path = LEDGER_PATH) {
  return recordOutcomes([outcome], path).entries[outcome.pathId];
}
