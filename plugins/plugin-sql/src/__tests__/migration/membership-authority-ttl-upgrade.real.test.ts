/**
 * Real-PGlite upgrade coverage proving startup replaces the exact pre-#25474
 * membership TTL checks while preserving existing authority rows.
 */
import type { UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plugin as sqlPlugin } from "../../index";
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
  name: string;
  definition: string;
}

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
    const before = await db.execute<ConstraintRow>(sql`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname IN (
         'membership_authority_scope_current_check',
         'membership_authority_version_check'
       )
       ORDER BY conname
    `);
    expect(before.rows).toHaveLength(2);
    expect(before.rows.every((row) => !row.definition.includes("24:00:00"))).toBe(true);

    const migrationService = new DatabaseMigrationService({ databaseBackend: "pglite" });
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([sqlPlugin]);
    await migrationService.runAllPluginMigrations({ verbose: false });

    const after = await db.execute<ConstraintRow>(sql`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname IN (
         'membership_authority_scope_current_check',
         'membership_authority_version_check'
       )
       ORDER BY conname
    `);
    expect(after.rows).toHaveLength(2);
    expect(after.rows.every((row) => row.definition.includes("24:00:00"))).toBe(true);

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
  }, 30_000);
});
