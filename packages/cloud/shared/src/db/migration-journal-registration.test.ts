/**
 * Migration ↔ journal registration gate.
 *
 * The deploy pipeline applies ONLY the migrations listed in
 * `migrations/meta/_journal.json` — a `.sql` file that is not registered
 * there never runs, so the code that depends on it ships against a stale
 * schema and fails at runtime in staging/prod. This has now happened twice
 * (#11493, and #11758's `0168_cloud_files.sql`), and `drizzle-kit check`
 * does NOT catch it (it only validates collisions among registered
 * entries). This suite is the missing gate.
 *
 * Rules enforced:
 *  - every `NNNN_name.sql` file (except `.down.sql` rollbacks) has exactly
 *    one journal entry whose tag is the filename stem, and vice versa;
 *  - journal `idx` values are contiguous from 0 (drizzle's migrator relies
 *    on ordering);
 *  - tags are unique.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

const BACKUP_CATALOGUE_MIGRATION_TAGS = [
  "0218_agent_backup_catalog_columns",
  "0219_agent_backup_catalog_legacy_backfill",
  "0220_agent_backup_catalog_authority",
  "0221_agent_backup_catalog_ownership_fks",
  "0222_agent_backup_catalog_identity_checks",
  "0223_agent_backup_catalog_runtime_checks",
  "0224_agent_backup_catalog_manifest_v2_check",
  "0225_agent_backup_catalog_indexes",
  "0226_agent_backup_objects",
  "0227_agent_backup_gc_outbox",
  "0228_agent_backup_catalog_tenant_authority",
  "0229_agent_backup_catalog_chain_authority",
  "0230_agent_backup_activation_authority_foundation",
  "0231_agent_backup_docker_source_authority",
  "0232_agent_backup_catalog_source_authority",
  "0233_agent_backup_catalog_manifest_v3_columns",
  "0234_agent_backup_catalog_manifest_v3_shape",
  "0235_agent_backup_rpo_scheduler",
  "0236_agent_sandbox_activation_quarantine",
  "0237_agent_restore_authority_prerequisites",
  "0238_agent_backup_restore_lease_core",
  "0239_agent_backup_restore_lease_authority",
  "0240_agent_vault_key_generations",
  "0241_agent_vault_key_current_authority",
  "0242_agent_vault_key_backup_bindings",
  "0243_agent_backup_catalog_authority_guard",
  "0244_agent_backup_restore_lease_guard",
  "0245_agent_vault_key_topology_guard",
  "0246_agent_node_incarnation_histories",
  "0247_agent_activation_publications",
  "0248_agent_vault_key_seed_receipts",
  "0249_agent_backup_restore_receipts",
  "0250_agent_restore_receipt_guards",
  "0251_agent_backup_restore_operations",
  "0252_agent_backup_restore_operation_guard",
  "0253_job_retryable_requeues",
] as const;

function journalEntries(): JournalEntry[] {
  const raw = readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8");
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

function migrationFileStems(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql") && !name.endsWith(".down.sql"))
    .map((name) => name.slice(0, -".sql".length))
    .sort();
}

describe("migrations/meta/_journal.json registration", () => {
  test("every migration .sql file is registered in the journal", () => {
    const stems = migrationFileStems();
    const tags = new Set(journalEntries().map((e) => e.tag));
    const unregistered = stems.filter((stem) => !tags.has(stem));
    expect(
      unregistered,
      `Unregistered migration file(s): ${unregistered.join(", ")} — add a _journal.json entry or the deploy pipeline will never apply them`,
    ).toEqual([]);
  });

  test("every journal entry has a matching .sql file", () => {
    const stems = new Set(migrationFileStems());
    const missing = journalEntries()
      .map((e) => e.tag)
      .filter((tag) => !stems.has(tag));
    expect(missing, `Journal entries without a migration file: ${missing.join(", ")}`).toEqual([]);
  });

  test("journal idx values are contiguous from 0 and tags are unique", () => {
    const entries = journalEntries();
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
    expect(new Set(entries.map((e) => e.tag)).size).toBe(entries.length);
  });

  test("the catalogue, capture, and restore stack is registered in strict deployment order", () => {
    const entries = journalEntries();
    const firstIndex = entries.findIndex(({ tag }) => tag === BACKUP_CATALOGUE_MIGRATION_TAGS[0]);
    const stack = entries.slice(firstIndex, firstIndex + BACKUP_CATALOGUE_MIGRATION_TAGS.length);

    expect(stack.map(({ tag }) => tag)).toEqual([...BACKUP_CATALOGUE_MIGRATION_TAGS]);
    expect(stack.map(({ idx }) => idx)).toEqual(
      BACKUP_CATALOGUE_MIGRATION_TAGS.map((_, offset) => 217 + offset),
    );
    expect(stack.map(({ when }) => when)).toEqual(
      BACKUP_CATALOGUE_MIGRATION_TAGS.map((_, offset) => 1787947200000 + offset * 86_400_000),
    );
  });

  test("each capture and restore-foundation migration remains below the review-size ceiling", () => {
    const captureTags = BACKUP_CATALOGUE_MIGRATION_TAGS.slice(6);

    for (const tag of captureTags) {
      const source = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
      expect(source.split(/\r?\n/).length, `${tag}.sql must stay below 100 lines`).toBeLessThan(
        100,
      );
    }
  });
});
