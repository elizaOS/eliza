/**
 * Unit tests for the committed HITL evidence ledger: locked freshness bands
 * (green ≤7d, yellow >7d, red >30d-or-never), upsert semantics (lastSuccessAt
 * only advances on success), stable serialization for clean diffs, and outcome
 * validation — all against real temp-dir files, no mocks.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FRESH_DAYS,
  freshness,
  readLedger,
  recordOutcome,
  recordOutcomes,
  STALE_DAYS,
} from "./hitl-ledger.mjs";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-07-06T00:00:00.000Z");

function daysAgo(days) {
  return new Date(NOW - days * DAY_MS).toISOString();
}

function outcome(overrides = {}) {
  return {
    pathId: "telegram.bot",
    ok: true,
    at: "2026-07-06T00:00:00.000Z",
    lane: "live-lane-9",
    commit: "abc1234",
    counts: { passed: 3, failed: 0, skipped: 0 },
    ...overrides,
  };
}

// --- freshness ----------------------------------------------------------------

test("freshness: never proven reads red", () => {
  assert.deepEqual(freshness(null, NOW), {
    state: "red",
    ageDays: null,
    label: "never proven",
  });
  assert.equal(freshness("", NOW).state, "red");
  assert.equal(freshness(undefined, NOW).state, "red");
});

test("freshness: locked band boundaries (green ≤7d, yellow >7d, red >30d)", () => {
  assert.equal(freshness(daysAgo(0), NOW).state, "green");
  assert.equal(freshness(daysAgo(FRESH_DAYS), NOW).state, "green");
  assert.equal(freshness(daysAgo(FRESH_DAYS + 1), NOW).state, "yellow");
  assert.equal(freshness(daysAgo(STALE_DAYS), NOW).state, "yellow");
  assert.equal(freshness(daysAgo(STALE_DAYS + 1), NOW).state, "red");
});

test("freshness: reports age in whole days and clamps future timestamps", () => {
  assert.equal(freshness(daysAgo(3), NOW).ageDays, 3);
  assert.equal(freshness(daysAgo(3.9), NOW).ageDays, 3);
  const future = freshness(daysAgo(-2), NOW);
  assert.equal(future.state, "green");
  assert.equal(future.ageDays, 0);
});

test("freshness: unparseable timestamp throws instead of masking", () => {
  assert.throws(() => freshness("not-a-date", NOW), /unparseable/);
});

// --- readLedger ----------------------------------------------------------------

test("readLedger: missing file yields the empty shape", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hitl-ledger-")), "ledger.json");
  assert.deepEqual(readLedger(path), {
    version: 1,
    updatedAt: null,
    entries: {},
  });
});

test("readLedger: malformed ledger throws (committed evidence, not a cache)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hitl-ledger-"));
  const path = join(dir, "ledger.json");
  writeFileSync(path, JSON.stringify({ entries: null }), "utf8");
  assert.throws(() => readLedger(path), /malformed ledger/);
  writeFileSync(path, JSON.stringify([1, 2]), "utf8");
  assert.throws(() => readLedger(path), /malformed ledger/);
});

test("readLedger: committed entries are schema-checked and secret-shaped fields are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "hitl-ledger-"));
  const path = join(dir, "ledger.json");
  recordOutcome(outcome(), path);
  const parsed = JSON.parse(readFileSync(path, "utf8"));

  parsed.entries["telegram.bot"].token = "xoxb-secret-value";
  writeFileSync(path, JSON.stringify(parsed), "utf8");
  assert.throws(() => readLedger(path), /secret-shaped field 'token'/);

  delete parsed.entries["telegram.bot"].token;
  parsed.entries["telegram.bot"].operatorEmail = "owner@example.com";
  writeFileSync(path, JSON.stringify(parsed), "utf8");
  assert.throws(() => readLedger(path), /unknown field 'operatorEmail'/);

  delete parsed.entries["telegram.bot"].operatorEmail;
  parsed.entries["telegram.bot"].counts.retried = 1;
  writeFileSync(path, JSON.stringify(parsed), "utf8");
  assert.throws(() => readLedger(path), /unknown field 'retried'/);
});

// --- recordOutcome upsert semantics ----------------------------------------------

test("recordOutcome: creates the ledger and stamps the success entry", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hitl-ledger-")), "ledger.json");
  const entry = recordOutcome(outcome(), path);
  assert.deepEqual(entry, {
    pathId: "telegram.bot",
    lastSuccessAt: "2026-07-06T00:00:00.000Z",
    lastRunAt: "2026-07-06T00:00:00.000Z",
    lane: "live-lane-9",
    commit: "abc1234",
    counts: { passed: 3, failed: 0, skipped: 0 },
  });
  const onDisk = readLedger(path);
  assert.equal(onDisk.version, 1);
  assert.ok(typeof onDisk.updatedAt === "string");
  assert.deepEqual(onDisk.entries["telegram.bot"], entry);
});

test("recordOutcome: failed and skipped runs advance lastRunAt but preserve proof", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hitl-ledger-")), "ledger.json");
  recordOutcome(outcome(), path);
  const afterFail = recordOutcome(
    outcome({
      ok: false,
      at: "2026-07-07T00:00:00.000Z",
      commit: "def5678",
      counts: { passed: 1, failed: 2, skipped: 0 },
    }),
    path,
  );
  assert.equal(afterFail.lastSuccessAt, "2026-07-06T00:00:00.000Z");
  assert.equal(afterFail.lastRunAt, "2026-07-07T00:00:00.000Z");
  assert.equal(afterFail.commit, "def5678");
  assert.deepEqual(afterFail.counts, { passed: 1, failed: 2, skipped: 0 });

  const afterSkip = recordOutcome(
    outcome({
      ok: null,
      at: "2026-07-08T00:00:00.000Z",
      counts: { passed: 0, failed: 0, skipped: 0 },
    }),
    path,
  );
  assert.equal(afterSkip.lastSuccessAt, "2026-07-06T00:00:00.000Z");
  assert.equal(afterSkip.lastRunAt, "2026-07-08T00:00:00.000Z");
});

test("recordOutcome: a path that never succeeded keeps lastSuccessAt null", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hitl-ledger-")), "ledger.json");
  const entry = recordOutcome(
    outcome({ pathId: "x.bearer-app", ok: false }),
    path,
  );
  assert.equal(entry.lastSuccessAt, null);
  assert.equal(freshness(entry.lastSuccessAt, NOW).state, "red");
});

test("recordOutcomes: batch upsert lands every outcome in one write", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hitl-ledger-")), "ledger.json");
  const next = recordOutcomes(
    [
      outcome({ pathId: "slack.bot" }),
      outcome({ pathId: "discord.bot", ok: null }),
    ],
    path,
  );
  assert.deepEqual(Object.keys(next.entries), ["discord.bot", "slack.bot"]);
  assert.deepEqual(readLedger(path).entries, next.entries);
});

test("recordOutcomes: entries serialize sorted by pathId for stable diffs", () => {
  const dir = mkdtempSync(join(tmpdir(), "hitl-ledger-"));
  const path = join(dir, "ledger.json");
  recordOutcome(outcome({ pathId: "zz.last" }), path);
  recordOutcome(outcome({ pathId: "aa.first" }), path);
  const raw = readFileSync(path, "utf8");
  assert.ok(raw.indexOf('"aa.first"') < raw.indexOf('"zz.last"'));
  assert.ok(raw.endsWith("}\n"), "file ends with a single trailing newline");
  // Atomic write: the tmp file is renamed away, never left behind.
  assert.deepEqual(readdirSync(dir), ["ledger.json"]);
});

test("recordOutcome: rewriting identical outcomes keeps key order byte-stable", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hitl-ledger-")), "ledger.json");
  recordOutcome(outcome({ pathId: "b.path" }), path);
  recordOutcome(outcome({ pathId: "a.path" }), path);
  const first = readFileSync(path, "utf8");
  recordOutcome(outcome({ pathId: "a.path" }), path);
  const second = readFileSync(path, "utf8");
  const stripUpdatedAt = (text) => text.replace(/"updatedAt": "[^"]+"/, "");
  assert.equal(stripUpdatedAt(first), stripUpdatedAt(second));
});

// --- outcome validation -----------------------------------------------------------

test("recordOutcome: rejects malformed outcomes before touching the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "hitl-ledger-"));
  const path = join(dir, "ledger.json");
  assert.throws(() => recordOutcome(outcome({ pathId: "" }), path), /pathId/);
  assert.throws(() => recordOutcome(outcome({ ok: "yes" }), path), /ok must/);
  assert.throws(() => recordOutcome(outcome({ at: "garbage" }), path), /ISO/);
  assert.throws(() => recordOutcome(outcome({ lane: 7 }), path), /lane/);
  assert.throws(
    () => recordOutcome(outcome({ counts: { passed: 1, failed: 0 } }), path),
    /counts\.skipped/,
  );
  assert.throws(
    () =>
      recordOutcome(
        outcome({ counts: { passed: -1, failed: 0, skipped: 0 } }),
        path,
      ),
    /counts\.passed/,
  );
  assert.throws(
    () => recordOutcome(outcome({ token: "xoxb-secret-value" }), path),
    /secret-shaped field 'token'/,
  );
  assert.throws(
    () => recordOutcome(outcome({ notes: "operator said it passed" }), path),
    /unknown field 'notes'/,
  );
  assert.throws(
    () =>
      recordOutcome(
        outcome({ counts: { passed: 1, failed: 0, skipped: 0, retried: 1 } }),
        path,
      ),
    /unknown field 'retried'/,
  );
  assert.deepEqual(readdirSync(dir), [], "no file created on rejected input");
});
