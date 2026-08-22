/**
 * Proves identity journal privileges, append-only triggers, and parent-agent
 * deletion cascades against an explicitly enabled real PostgreSQL service.
 * This lane never substitutes PGlite and requires an administrative test URL.
 */

import type { UUID } from "@elizaos/core";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyIdentityClaimJournalGuard } from "../../../identity-claim-journal-guard";
import { plugin as sqlPlugin } from "../../../index";
import { DatabaseMigrationService } from "../../../migration-service";
import { agentTable } from "../../../schema/agent";
import { connectorAccountsTable } from "../../../schema/connectorAccounts";
import { entityTable } from "../../../schema/entity";
import { identityClaimJournalTable, identityClaimTable } from "../../../schema/identityAuthority";
import type { DrizzleDatabase } from "../../../types";
import { createIsolatedTestDatabase } from "../../test-helpers";

const enabled =
  process.env.ELIZA_IDENTITY_REAL_POSTGRES_TEST === "1" && Boolean(process.env.POSTGRES_URL);

(enabled ? describe : describe.skip)("PostgreSQL identity claim journal privileges", () => {
  let cleanup: () => Promise<void>;
  let db: DrizzleDatabase;
  let admin: Pool;
  let restricted: Pool;
  let roleName: string;
  let deletionAgentId: UUID;
  let claimId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("identity-claim-postgres-privileges");
    cleanup = setup.cleanup;
    db = setup.adapter.getDatabase() as DrizzleDatabase;
    const postgresUrl = process.env.POSTGRES_URL;
    if (!postgresUrl) throw new Error("POSTGRES_URL is required for this explicit lane");
    admin = new Pool({ connectionString: postgresUrl, max: 2 });
    roleName = `eliza_identity_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const password = crypto.randomUUID();
    await admin.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    await admin.query(
      `GRANT SELECT, UPDATE, DELETE, TRUNCATE ON identity_claim_journal TO ${roleName}`
    );
    await admin.query(`GRANT SELECT, DELETE, TRUNCATE ON agents TO ${roleName}`);
    await admin.query(`GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO ${roleName}`);
    const restrictedUrl = new URL(postgresUrl);
    restrictedUrl.username = roleName;
    restrictedUrl.password = password;
    restricted = new Pool({ connectionString: restrictedUrl.toString(), max: 1 });

    deletionAgentId = crypto.randomUUID() as UUID;
    const principalId = crypto.randomUUID() as UUID;
    const accountId = crypto.randomUUID() as UUID;
    await db.insert(agentTable).values({ id: deletionAgentId, name: "postgres-deletion-fixture" });
    await db.insert(entityTable).values({
      id: principalId,
      agentId: deletionAgentId,
      names: ["postgres deletion fixture"],
      metadata: {},
    });
    await db.insert(connectorAccountsTable).values({
      id: accountId,
      agentId: deletionAgentId,
      provider: "discord",
      accountKey: "postgres-deletion-account",
      externalId: "postgres-deleted-subject",
      status: "connected",
    });
    const [claim] = await db
      .insert(identityClaimTable)
      .values({
        agentId: deletionAgentId,
        principalEntityId: principalId,
        namespace: "provider_subject",
        connectorId: "discord",
        connectorAccountId: accountId,
        externalSubjectId: "postgres-deleted-subject",
        verification: "observed",
        status: "active",
        confidence: 0.5,
      })
      .returning();
    if (!claim) throw new Error("PostgreSQL claim fixture was not persisted");
    claimId = claim.id as UUID;
    await db.insert(identityClaimJournalTable).values({
      agentId: deletionAgentId,
      claimId,
      principalEntityId: principalId,
      eventKind: "observed",
      priorVersion: null,
      resultingVersion: 1,
      actorPrincipalId: principalId,
      idempotencyKey: "postgres-deletion-event",
      requestDigest: "postgres-secret-digest",
      reason: "postgres identifying reason",
      provenance: { subject: "postgres-deleted-subject" },
      evidence: { principalId },
      beforeClaim: null,
      afterClaim: claim,
    });
  }, 120_000);

  afterAll(async () => {
    await restricted?.end();
    if (admin && roleName) {
      await admin.query(`REASSIGN OWNED BY ${roleName} TO CURRENT_USER`);
      await admin.query(`DROP OWNED BY ${roleName}`);
      await admin.query(`DROP ROLE ${roleName}`);
      await admin.end();
    }
    await cleanup?.();
  }, 120_000);

  it("denies direct mutation but permits the unspoofable FK cascade path", async () => {
    await expect(
      restricted.query(
        "UPDATE identity_claim_journal SET reason = 'tampered' WHERE claim_id = $1",
        [claimId]
      )
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      restricted.query("DELETE FROM identity_claim_journal WHERE claim_id = $1", [claimId])
    ).rejects.toMatchObject({ code: "55000" });
    await expect(restricted.query("TRUNCATE identity_claim_journal")).rejects.toMatchObject({
      code: "55000",
    });
    await expect(restricted.query("TRUNCATE agents CASCADE")).rejects.toMatchObject({
      code: "55000",
    });

    const unavailable = await admin.query(`
      SELECT to_regclass('public.identity_claim_retention_ledger') AS ledger,
             to_regprocedure('public.retain_identity_claim_deletion_receipt()') AS producer
    `);
    expect(unavailable.rows[0]).toEqual({ ledger: null, producer: null });
    const grants = await admin.query(
      "SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name = 'identity_claim_retention_ledger'",
      [roleName]
    );
    expect(grants.rows).toHaveLength(0);
    await expect(
      restricted.query("INSERT INTO identity_claim_retention_ledger DEFAULT VALUES")
    ).rejects.toMatchObject({ code: "42P01" });
    await expect(
      restricted.query("SELECT retain_identity_claim_deletion_receipt()")
    ).rejects.toMatchObject({ code: "42883" });

    await restricted.query("BEGIN");
    await restricted.query("DELETE FROM agents WHERE id = $1", [deletionAgentId]);
    expect(
      Number(
        (
          await restricted.query(
            "SELECT count(*) AS count FROM identity_claim_journal WHERE agent_id = $1",
            [deletionAgentId]
          )
        ).rows[0]?.count
      )
    ).toBe(0);
    await restricted.query("ROLLBACK");
    expect(
      Number(
        (
          await restricted.query(
            "SELECT count(*) AS count FROM identity_claim_journal WHERE agent_id = $1",
            [deletionAgentId]
          )
        ).rows[0]?.count
      )
    ).toBe(1);

    await restricted.query("DELETE FROM agents WHERE id = $1", [deletionAgentId]);
    expect(
      await db
        .select()
        .from(identityClaimJournalTable)
        .where(eq(identityClaimJournalTable.agentId, deletionAgentId))
    ).toHaveLength(0);
  });

  it("installs and enforces the same authority in a non-public visible schema", async () => {
    const schemaName = `identity_authority_${crypto.randomUUID().replaceAll("-", "")}`;
    const customAgentId = crypto.randomUUID();
    const client = await admin.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`
        CREATE TABLE ${schemaName}.agents (id uuid PRIMARY KEY);
        CREATE TABLE ${schemaName}.identity_claim_journal (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          agent_id uuid NOT NULL REFERENCES ${schemaName}.agents(id) ON DELETE CASCADE
        )
      `);
      await client.query(`SET search_path TO ${schemaName}, public`);
      expect(await applyIdentityClaimJournalGuard(drizzle(client) as DrizzleDatabase)).toBe(true);
      await client.query(`INSERT INTO ${schemaName}.agents (id) VALUES ($1)`, [customAgentId]);
      await client.query(
        `INSERT INTO ${schemaName}.identity_claim_journal (agent_id) VALUES ($1), ($1)`,
        [customAgentId]
      );
      await expect(
        client.query(`TRUNCATE ${schemaName}.identity_claim_journal`)
      ).rejects.toMatchObject({ code: "55000" });
      await expect(client.query(`TRUNCATE ${schemaName}.agents CASCADE`)).rejects.toMatchObject({
        code: "55000",
      });
      await client.query(`DELETE FROM ${schemaName}.agents WHERE id = $1`, [customAgentId]);
      expect(
        Number(
          (await client.query(`SELECT count(*) AS count FROM ${schemaName}.identity_claim_journal`))
            .rows[0]?.count
        )
      ).toBe(0);
    } finally {
      await client.query("RESET search_path");
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      client.release();
    }
  });

  it("keeps migration dry-run free of post-migration guard DDL", async () => {
    await admin.query(
      "DROP TRIGGER identity_claim_journal_no_truncate ON public.identity_claim_journal"
    );
    const before = await admin.query(
      "SELECT 1 FROM pg_trigger WHERE tgname = 'identity_claim_journal_no_truncate' AND NOT tgisinternal"
    );
    expect(before.rows).toHaveLength(0);

    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([sqlPlugin]);
    await migrationService.runAllPluginMigrations({ dryRun: true });

    const after = await admin.query(
      "SELECT 1 FROM pg_trigger WHERE tgname = 'identity_claim_journal_no_truncate' AND NOT tgisinternal"
    );
    expect(after.rows).toHaveLength(0);
  });
});
