/** Raw-PostgreSQL proofs for the exact restore image platform authority. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION_TAG = "0372_agent_backup_restore_exact_image_authority";
const MIGRATION = readFileSync(join(import.meta.dir, "migrations", MIGRATION_TAG + ".sql"), "utf8");
const OPERATION = "00000000-0000-4000-8000-000000000901";
const NODE = "00000000-0000-4000-8000-000000000902";
const HISTORY = "00000000-0000-4000-8000-000000000903";
const INCARNATION = "00000000-0000-4000-8000-000000000904";
const PARENT = "a".repeat(64);
const CHILD = "b".repeat(64);
const REFERENCE = "ghcr.io/elizaos/eliza@sha256:" + PARENT;

const PRE_MIGRATION_TABLE = [
  "CREATE TABLE agent_backup_restore_operations (",
  "  id uuid PRIMARY KEY,",
  "  attempts integer NOT NULL DEFAULT 0,",
  "  catalog_epoch bigint NOT NULL DEFAULT 1,",
  "  expected_lifecycle_revision numeric(20, 0) NOT NULL DEFAULT 1,",
  "  expected_manifest_sha256 text NOT NULL,",
  "  copy_role text NOT NULL DEFAULT 'primary',",
  "  lease_owner_id text NOT NULL DEFAULT 'restore-worker',",
  "  phase text NOT NULL DEFAULT 'reserved',",
  "  expected_node_history_id uuid,",
  "  expected_node_record_id uuid,",
  "  expected_node_incarnation uuid,",
  "  expected_container_id text,",
  "  expected_image_digest text,",
  "  CONSTRAINT agent_backup_restore_operations_expected_shape_check CHECK ((",
  "    (expected_node_record_id IS NULL) = (expected_node_incarnation IS NULL)",
  "  ) IS TRUE)",
  ");",
].join("\n");

function insertOperation(targetBound = false): string {
  const targetColumns = targetBound
    ? ", expected_node_history_id, expected_node_record_id, expected_node_incarnation, expected_image_digest"
    : "";
  const targetValues = targetBound
    ? ", '" + HISTORY + "', '" + NODE + "', '" + INCARNATION + "', 'sha256:" + PARENT + "'"
    : "";
  return (
    "INSERT INTO agent_backup_restore_operations (" +
    "id, expected_manifest_sha256" +
    targetColumns +
    ") VALUES ('" +
    OPERATION +
    "', '" +
    PARENT +
    "'" +
    targetValues +
    ")"
  );
}

async function databaseBeforeMigration(targetBound = false): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(PRE_MIGRATION_TABLE);
  await database.exec(insertOperation(targetBound));
  return database;
}

function bindTarget(platform = "linux/amd64"): string {
  return (
    "UPDATE agent_backup_restore_operations SET " +
    "expected_node_history_id = '" +
    HISTORY +
    "', expected_node_record_id = '" +
    NODE +
    "', expected_node_incarnation = '" +
    INCARNATION +
    "', expected_image_digest = 'sha256:" +
    PARENT +
    "', expected_image_platform = '" +
    platform +
    "' WHERE id = '" +
    OPERATION +
    "'"
  );
}

describe("0372 exact restore image platform authority", () => {
  test("requires the reserved target platform and exact image pair as complete bundles", async () => {
    const database = await databaseBeforeMigration();
    try {
      await database.exec(MIGRATION);
      await expect(
        database.exec(
          "UPDATE agent_backup_restore_operations SET expected_image_platform = 'linux/amd64'",
        ),
      ).rejects.toThrow(/expected_shape_check/);
      await expect(database.exec(bindTarget("linux/s390x"))).rejects.toThrow(
        /expected_shape_check/,
      );
      await database.exec(bindTarget("linux/arm64"));

      await expect(
        database.exec(
          "UPDATE agent_backup_restore_operations SET expected_image_reference = '" +
            REFERENCE +
            "'",
        ),
      ).rejects.toThrow(/exact_image_shape_check/);
      await expect(
        database.exec(
          "UPDATE agent_backup_restore_operations SET " +
            "expected_image_reference = 'ghcr.io/elizaos/eliza:latest', " +
            "expected_image_platform_digest = 'sha256:" +
            CHILD +
            "'",
        ),
      ).rejects.toThrow(/exact_image_shape_check/);
      await expect(
        database.exec(
          "UPDATE agent_backup_restore_operations SET " +
            "expected_image_reference = 'ghcr.io/elizaos/eliza@sha256:" +
            "c".repeat(64) +
            "', expected_image_platform_digest = 'sha256:" +
            CHILD +
            "'",
        ),
      ).rejects.toThrow(/exact_image_shape_check/);
      await expect(
        database.exec(
          "UPDATE agent_backup_restore_operations SET " +
            "expected_image_reference = '" +
            REFERENCE +
            "', expected_image_platform_digest = 'sha256:" +
            CHILD.toUpperCase() +
            "'",
        ),
      ).rejects.toThrow(/exact_image_shape_check/);

      const [unbound] = (
        await database.query<{
          expected_image_reference: string | null;
          expected_image_platform_digest: string | null;
        }>(
          "SELECT expected_image_reference, expected_image_platform_digest " +
            "FROM agent_backup_restore_operations",
        )
      ).rows;
      expect(unbound).toEqual({
        expected_image_reference: null,
        expected_image_platform_digest: null,
      });
    } finally {
      await database.close();
    }
  }, 60_000);

  test("permits one atomic bind and byte-identical replay but rejects every drift", async () => {
    const database = await databaseBeforeMigration();
    try {
      await database.exec(MIGRATION);
      await database.exec(bindTarget());
      const bindImage =
        "UPDATE agent_backup_restore_operations SET expected_image_reference = '" +
        REFERENCE +
        "', expected_image_platform_digest = 'sha256:" +
        CHILD +
        "'";
      await database.exec(bindImage);
      await database.exec(bindTarget());
      await database.exec(bindImage);

      for (const mutation of [
        "expected_image_platform = 'linux/arm64'",
        "expected_image_reference = 'ghcr.io/elizaos/other@sha256:" + PARENT + "'",
        "expected_image_platform_digest = 'sha256:" + "c".repeat(64) + "'",
        "expected_image_reference = NULL, expected_image_platform_digest = NULL",
      ]) {
        await expect(
          database.exec("UPDATE agent_backup_restore_operations SET " + mutation),
        ).rejects.toThrow(/exact image authority is write-once/);
      }
    } finally {
      await database.close();
    }
  }, 60_000);

  test("fails closed instead of inventing platform authority for an old bound target", async () => {
    const database = await databaseBeforeMigration(true);
    try {
      await expect(database.exec(MIGRATION)).rejects.toThrow(/expected_shape_check/);
    } finally {
      await database.close();
    }
  }, 60_000);

  test("is re-runnable, journaled, and reflected in the Drizzle schema", async () => {
    const database = await databaseBeforeMigration();
    try {
      await database.exec(MIGRATION);
      await database.exec(MIGRATION);
    } finally {
      await database.close();
    }
    const journal = JSON.parse(
      readFileSync(join(import.meta.dir, "migrations", "meta", "_journal.json"), "utf8"),
    ) as {
      entries: Array<{
        idx: number;
        version: string;
        when: number;
        tag: string;
        breakpoints: boolean;
      }>;
    };
    expect(journal.entries.find(({ tag }) => tag === MIGRATION_TAG)).toEqual({
      idx: 355,
      version: "7",
      when: 1794254400063,
      tag: MIGRATION_TAG,
      breakpoints: true,
    });
    const schema = readFileSync(
      join(import.meta.dir, "schemas", "agent-backup-catalog.ts"),
      "utf8",
    );
    for (const column of [
      "expected_image_platform",
      "expected_image_reference",
      "expected_image_platform_digest",
    ]) {
      expect(schema).toContain(column);
    }
  }, 60_000);
});
