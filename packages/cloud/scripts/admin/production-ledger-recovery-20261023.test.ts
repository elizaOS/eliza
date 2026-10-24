import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadCanonicalMigrations } from "./canonical-migration-ledger";
import {
  ALREADY_EFFECTIVE_TAGS,
  buildRecoverySql,
  placeholderSupersededChecks,
  REVIEWED_PREFIX_LENGTH,
} from "./production-ledger-recovery-20261023";

const migrations = await loadCanonicalMigrations();
const committed = readFileSync(
  path.join(import.meta.dir, "production-ledger-recovery-20261023.sql"),
  "utf8",
);

test("committed recovery SQL is exactly what the canonical journal generates", () => {
  expect(buildRecoverySql(migrations)).toBe(committed);
});

test("recovery writes one canonical receipt per journal entry after the prefix", () => {
  const receipts =
    committed.match(
      /INSERT INTO drizzle\.__drizzle_migrations\(hash, created_at\)/g,
    ) ?? [];
  expect(receipts.length).toBe(migrations.length - REVIEWED_PREFIX_LENGTH);
  for (const migration of migrations.slice(REVIEWED_PREFIX_LENGTH))
    expect(committed).toContain(
      `VALUES ('${migration.hash}', ${migration.entry.when});`,
    );
});

test("already-effective migrations get a receipt but no SQL", () => {
  for (const tag of ALREADY_EFFECTIVE_TAGS) {
    expect(committed).toContain(`-- already effective in production: ${tag}`);
    expect(committed).not.toContain(`-- apply ${tag}`);
  }
});

test("only superseded intermediate CHECKs become placeholders", () => {
  const pending = migrations
    .slice(REVIEWED_PREFIX_LENGTH)
    .filter((m) => !ALREADY_EFFECTIVE_TAGS.has(m.entry.tag));
  const rewritten = placeholderSupersededChecks(pending);
  const placeholders =
    [...rewritten.values()].join("\n").match(/CHECK \(true\) NOT VALID/g) ?? [];
  expect(placeholders.length).toBe(14);
  expect(committed).toContain("placeholder_constraint_survived");
});

test("recovery refuses any ledger other than the reviewed 373-row state", () => {
  expect(committed).toContain("ledger_shape_mismatch");
  expect(committed).toContain(
    "a465de981b9ebd4f0f4c0e60c594c825f3b0110b28fdf64340b8b1ef5c2108a0",
  );
  expect(committed.startsWith("\\set ON_ERROR_STOP on\nBEGIN;")).toBe(true);
  expect(committed.trimEnd().endsWith("COMMIT;")).toBe(true);
});
