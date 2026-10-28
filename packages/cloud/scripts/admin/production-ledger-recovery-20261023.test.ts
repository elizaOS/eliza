import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadCanonicalMigrations } from "./canonical-migration-ledger";
import {
  ALREADY_EFFECTIVE_TAGS,
  buildRecoverySql,
  loadReviewedEffectFingerprint,
  placeholderSupersededChecks,
  REVIEWED_JOURNAL_LENGTH,
  REVIEWED_PREFIX_LENGTH,
} from "./production-ledger-recovery-20261023";

const migrations = await loadCanonicalMigrations();
const reviewed = migrations.slice(0, REVIEWED_JOURNAL_LENGTH);
const effects = loadReviewedEffectFingerprint();
const committed = readFileSync(
  path.join(import.meta.dir, "production-ledger-recovery-20261023.sql"),
  "utf8",
);

test("committed recovery SQL is exactly what the canonical journal generates", () => {
  expect(buildRecoverySql(migrations, effects)).toBe(committed);
});

test("journal entries after the reviewed length do not change the recovery", () => {
  const extra = {
    ...migrations[migrations.length - 1],
    entry: { ...migrations[migrations.length - 1].entry, tag: "9999_later" },
  };
  expect(buildRecoverySql([...reviewed, extra], effects)).toBe(committed);
  expect(() => buildRecoverySql(reviewed.slice(0, -1), effects)).toThrow(
    "journal_shorter_than_reviewed",
  );
  expect(() => buildRecoverySql(reviewed, [])).toThrow(
    "missing_reviewed_effect_fingerprint",
  );
});

test("recovery writes one canonical receipt per reviewed journal entry after the prefix", () => {
  const receipts =
    committed.match(
      /INSERT INTO drizzle\.__drizzle_migrations\(hash, created_at\)/g,
    ) ?? [];
  expect(receipts.length).toBe(
    REVIEWED_JOURNAL_LENGTH - REVIEWED_PREFIX_LENGTH,
  );
  for (const migration of reviewed.slice(REVIEWED_PREFIX_LENGTH))
    expect(committed).toContain(
      `VALUES ('${migration.hash}', ${migration.entry.when});`,
    );
});

test("already-effective migrations get a receipt only after the fingerprint check", () => {
  const fingerprintCheck = committed.indexOf(
    "already_effective_schema_mismatch",
  );
  const firstMutation = committed.indexOf("CREATE TABLE drizzle.");
  expect(fingerprintCheck).toBeGreaterThan(0);
  expect(fingerprintCheck).toBeLessThan(firstMutation);
  for (const tag of ALREADY_EFFECTIVE_TAGS) {
    expect(committed).toContain(
      `-- already effective in production (fingerprint verified): ${tag}`,
    );
    expect(committed).not.toContain(`-- apply ${tag}`);
  }
  for (const row of effects) expect(committed).toContain(`'${row.name}'`);
});

test("only superseded intermediate CHECKs become placeholders", () => {
  const pending = reviewed
    .slice(REVIEWED_PREFIX_LENGTH)
    .filter((m) => !ALREADY_EFFECTIVE_TAGS.has(m.entry.tag));
  const rewritten = placeholderSupersededChecks(pending);
  const placeholders =
    [...rewritten.values()].join("\n").match(/CHECK \(true\) NOT VALID/g) ?? [];
  expect(placeholders.length).toBe(14);
  expect(committed).toContain("placeholder_constraint_survived");
});

test("admission guard pins every reviewed ledger row before any mutation", () => {
  const guardEnd = committed.indexOf("ledger_shape_mismatch");
  expect(guardEnd).toBeLessThan(committed.indexOf("CREATE TABLE drizzle."));
  const guard = committed.slice(0, guardEnd);
  for (const [index, migration] of reviewed
    .slice(0, REVIEWED_PREFIX_LENGTH)
    .entries())
    expect(guard).toContain(
      `(${index + 1},'${migration.hash}',${migration.entry.when}::bigint)`,
    );
  expect(guard).toContain(
    `(373,'a465de981b9ebd4f0f4c0e60c594c825f3b0110b28fdf64340b8b1ef5c2108a0',${reviewed[372].entry.when}::bigint)`,
  );
  expect(committed.startsWith("\\set ON_ERROR_STOP on\nBEGIN;")).toBe(true);
  expect(committed.trimEnd().endsWith("COMMIT;")).toBe(true);
});

test("the id sequence is restarted transactionally, never with setval", () => {
  expect(committed).not.toContain("setval(");
  expect(committed).toContain("ALTER SEQUENCE %s RESTART WITH 371");
  expect(committed).toContain("ledger_mismatch_after_repair");
  expect(committed).toContain("ledger_sequence_behind_after_repair");
});
