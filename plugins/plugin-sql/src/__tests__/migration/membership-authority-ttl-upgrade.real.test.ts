/**
 * Real-PGlite upgrade coverage proving startup replaces the exact pre-#25474
 * membership TTL checks, preserves authority rows, skips dry runs and settled
 * restarts, and defers until both authority tables exist.
 */
import type { UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plugin as sqlPlugin } from "../../index";
import { applyMembershipAuthorityTtlConstraints } from "../../membership-authority-ttl-constraints";
import { DatabaseMigrationService } from "../../migration-service";
import { connectorAccountsTable } from "../../schema/connectorAccounts";
import { entityTable } from "../../schema/entity";
import {
  membershipAuthorityScopeTable,
  membershipAuthorityTable,
} from "../../schema/membershipAuthority";
import { type DrizzleDatabase, getDb } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

interface ConstraintRow {
  [key: string]: unknown;
  id: number;
  name: string;
  definition: string;
  version: string | null;
}

const constraintQuery = sql`
  SELECT oid::integer AS id,
         conname AS name,
         pg_get_constraintdef(oid) AS definition,
         obj_description(oid, 'pg_constraint') AS version
    FROM pg_constraint
   WHERE conname IN (
     'membership_authority_scope_current_check',
     'membership_authority_version_check'
   )
   ORDER BY conname
`;

describe("membership authority TTL constraint upgrade", () => {
  let cleanup: () => Promise<void>;
  let db: DrizzleDatabase;
  let agentId: UUID;
  const accountId = crypto.randomUUID() as UUID;
  const principalId = crypto.randomUUID() as UUID;
  const observedAt = new Date("2026-08-23T00:00:00.000Z");
  const legacyValidUntil = new Date("2026-08-25T00:00:00.000Z");

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("membership_ttl_upgrade");
    cleanup = setup.cleanup;
    db = getDb(setup.adapter);
    agentId = setup.testAgentId;

    await db.execute(sql`
      ALTER TABLE membership_authority_scopes
        DROP CONSTRAINT membership_authority_scope_current_check
    `);
    await db.execute(sql`
      ALTER TABLE membership_authority_scopes
        ADD CONSTRAINT membership_authority_scope_current_check
        CHECK (
          health <> 'current'
          OR (
            valid_until IS NOT NULL
            AND valid_until > observed_at
            AND publisher_instance_id IS NOT NULL
            AND source_version >= 0
            AND source_cursor IS NOT NULL
          )
        )
    `);
    await db.execute(sql`
      ALTER TABLE membership_authority
        DROP CONSTRAINT membership_authority_version_check
    `);
    await db.execute(sql`
      ALTER TABLE membership_authority
        ADD CONSTRAINT membership_authority_version_check
        CHECK (generation > 0 AND source_version >= 0 AND valid_until > observed_at)
    `);

    await db.insert(connectorAccountsTable).values({
      id: accountId,
      agentId,
      provider: "upgrade-test",
      accountKey: "legacy-account",
    });
    await db.insert(entityTable).values({
      id: principalId,
      agentId,
      names: ["Retained principal"],
    });
    const scope = {
      agentId,
      connectorId: "upgrade-test",
      connectorAccountId: accountId,
      externalWorldId: "legacy-world",
      externalRoomId: "legacy-room",
    };
    await db.insert(membershipAuthorityScopeTable).values({
      ...scope,
      health: "current",
      reason: "complete_snapshot",
      generation: 2,
      sourceVersion: 0,
      sourceCursor: "legacy-cursor",
      validUntil: legacyValidUntil,
      publisherInstanceId: "legacy-publisher",
      publisherGeneration: 0,
      evidenceMode: "complete_snapshot",
      observedAt,
      updatedAt: observedAt,
    });
    await db.insert(membershipAuthorityTable).values({
      ...scope,
      canonicalPrincipalId: principalId,
      state: "active",
      reason: "reconciled_present",
      roles: ["member"],
      permissionSnapshot: { canRead: true },
      publisherInstanceId: "legacy-publisher",
      publisherGeneration: 0,
      evidenceMode: "complete_snapshot",
      generation: 2,
      sourceVersion: 0,
      sourceCursor: "legacy-cursor",
      observedAt,
      validUntil: legacyValidUntil,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
  }, 30_000);

  afterAll(async () => {
    await cleanup();
  });

  it("replaces same-named legacy checks on restart without deleting or fabricating rows", async () => {
    const before = await db.execute<ConstraintRow>(constraintQuery);
    expect(before.rows).toHaveLength(2);
    expect(before.rows.every((row) => !row.definition.includes("24:00:00"))).toBe(true);

    const dryRunService = new DatabaseMigrationService({ databaseBackend: "pglite" });
    await dryRunService.initializeWithDatabase(db);
    dryRunService.discoverAndRegisterPluginSchemas([sqlPlugin]);
    await dryRunService.runAllPluginMigrations({ dryRun: true, verbose: false });

    const afterDryRun = await db.execute<ConstraintRow>(constraintQuery);
    expect(afterDryRun.rows).toEqual(before.rows);
    expect((await db.select().from(membershipAuthorityTable))[0]?.validUntil.getTime()).toBe(
      legacyValidUntil.getTime()
    );

    const migrationService = new DatabaseMigrationService({ databaseBackend: "pglite" });
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([sqlPlugin]);
    await migrationService.runAllPluginMigrations({ verbose: false });

    const after = await db.execute<ConstraintRow>(constraintQuery);
    expect(after.rows).toHaveLength(2);
    expect(after.rows.every((row) => row.definition.includes("24:00:00"))).toBe(true);
    expect(after.rows.every((row) => row.version === "elizaos:membership-authority-ttl:v1")).toBe(
      true
    );

    const scopes = await db.select().from(membershipAuthorityScopeTable);
    const memberships = await db.select().from(membershipAuthorityTable);
    expect(scopes).toHaveLength(1);
    expect(memberships).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      agentId,
      connectorAccountId: accountId,
      health: "current",
      generation: 2,
      sourceCursor: "legacy-cursor",
    });
    expect(memberships[0]).toMatchObject({
      agentId,
      connectorAccountId: accountId,
      canonicalPrincipalId: principalId,
      state: "active",
      roles: ["member"],
      permissionSnapshot: { canRead: true },
      generation: 2,
      sourceCursor: "legacy-cursor",
    });
    const boundedValidUntil = new Date("2026-08-24T00:00:00.000Z").getTime();
    expect(scopes[0]?.validUntil?.getTime()).toBe(boundedValidUntil);
    expect(memberships[0]?.validUntil.getTime()).toBe(boundedValidUntil);

    await expect(
      db.execute(sql`
        UPDATE membership_authority_scopes
           SET valid_until = observed_at + INTERVAL '48 hours'
         WHERE connector_account_id = ${accountId}
      `)
    ).rejects.toThrow();
    await expect(
      db.execute(sql`
        UPDATE membership_authority
           SET valid_until = observed_at + INTERVAL '48 hours'
         WHERE canonical_principal_id = ${principalId}
      `)
    ).rejects.toThrow();

    const restartService = new DatabaseMigrationService({ databaseBackend: "pglite" });
    await restartService.initializeWithDatabase(db);
    restartService.discoverAndRegisterPluginSchemas([sqlPlugin]);
    await restartService.runAllPluginMigrations({ verbose: false });
    expect((await db.execute<ConstraintRow>(constraintQuery)).rows).toEqual(after.rows);
  }, 30_000);

  it("defers without mutation when either authority table is absent", async () => {
    for (const retainedTable of ["membership_authority", "membership_authority_scopes"] as const) {
      const setup = await createIsolatedTestDatabase(`membership_ttl_partial_${retainedTable}`);
      try {
        const partialDb = getDb(setup.adapter);
        const partialAccountId = crypto.randomUUID() as UUID;
        const partialPrincipalId = crypto.randomUUID() as UUID;
        const droppedTable =
          retainedTable === "membership_authority"
            ? "membership_authority_scopes"
            : "membership_authority";
        await partialDb.execute(sql.raw(`DROP TABLE ${droppedTable} CASCADE`));
        await partialDb.insert(connectorAccountsTable).values({
          id: partialAccountId,
          agentId: setup.testAgentId,
          provider: "partial-upgrade-test",
          accountKey: retainedTable,
        });
        const partialScope = {
          agentId: setup.testAgentId,
          connectorId: "partial-upgrade-test",
          connectorAccountId: partialAccountId,
          externalWorldId: "partial-world",
          externalRoomId: "partial-room",
        };
        if (retainedTable === "membership_authority_scopes") {
          await partialDb.insert(membershipAuthorityScopeTable).values({
            ...partialScope,
            health: "stale",
            reason: "publisher_not_registered",
            generation: 0,
            sourceVersion: -1,
            observedAt,
            updatedAt: observedAt,
          });
        } else {
          await partialDb.insert(entityTable).values({
            id: partialPrincipalId,
            agentId: setup.testAgentId,
            names: ["Partial retained principal"],
          });
          await partialDb.insert(membershipAuthorityTable).values({
            ...partialScope,
            canonicalPrincipalId: partialPrincipalId,
            state: "active",
            reason: "reconciled_present",
            roles: ["member"],
            permissionSnapshot: { canRead: true },
            publisherInstanceId: "partial-publisher",
            publisherGeneration: 0,
            evidenceMode: "complete_snapshot",
            generation: 1,
            sourceVersion: 0,
            sourceCursor: "partial-cursor",
            observedAt,
            validUntil: new Date("2026-08-23T12:00:00.000Z"),
            createdAt: observedAt,
            updatedAt: observedAt,
          });
        }

        const retainedRowsBefore =
          retainedTable === "membership_authority"
            ? await partialDb.select().from(membershipAuthorityTable)
            : await partialDb.select().from(membershipAuthorityScopeTable);
        const retainedConstraintsBefore = await partialDb.execute<ConstraintRow>(sql`
          SELECT constraint_record.oid::integer AS id,
                 constraint_record.conname AS name,
                 pg_get_constraintdef(constraint_record.oid) AS definition,
                 obj_description(constraint_record.oid, 'pg_constraint') AS version
            FROM pg_constraint AS constraint_record
            JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
           WHERE relation.relname = ${retainedTable}
           ORDER BY constraint_record.conname
        `);

        expect(await applyMembershipAuthorityTtlConstraints(partialDb, "pglite")).toBe(false);
        const retainedRowsAfter =
          retainedTable === "membership_authority"
            ? await partialDb.select().from(membershipAuthorityTable)
            : await partialDb.select().from(membershipAuthorityScopeTable);
        const retainedConstraintsAfter = await partialDb.execute<ConstraintRow>(sql`
          SELECT constraint_record.oid::integer AS id,
                 constraint_record.conname AS name,
                 pg_get_constraintdef(constraint_record.oid) AS definition,
                 obj_description(constraint_record.oid, 'pg_constraint') AS version
            FROM pg_constraint AS constraint_record
            JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
           WHERE relation.relname = ${retainedTable}
           ORDER BY constraint_record.conname
        `);
        expect(retainedRowsAfter).toEqual(retainedRowsBefore);
        expect(retainedConstraintsAfter.rows).toEqual(retainedConstraintsBefore.rows);
      } finally {
        await setup.cleanup();
      }
    }
  }, 60_000);
});
