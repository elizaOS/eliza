/**
 * Proves identity journal privileges, append-only triggers, and parent-agent
 * deletion cascades against an explicitly enabled real PostgreSQL service.
 * This lane never substitutes PGlite and requires an administrative test URL.
 */

import type { UUID } from "@elizaos/core";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentTable } from "../../../schema/agent";
import { connectorAccountsTable } from "../../../schema/connectorAccounts";
import { entityTable } from "../../../schema/entity";
import {
  identityClaimJournalTable,
  identityClaimRetentionLedgerTable,
  identityClaimTable,
} from "../../../schema/identityAuthority";
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
      `GRANT SELECT, UPDATE, DELETE ON identity_claim_journal, identity_claim_retention_ledger TO ${roleName}`
    );
    await admin.query(`GRANT INSERT ON identity_claim_retention_ledger TO ${roleName}`);
    await admin.query(`GRANT SELECT, DELETE ON agents TO ${roleName}`);
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

    await restricted.query("DELETE FROM agents WHERE id = $1", [deletionAgentId]);
    expect(
      await db
        .select()
        .from(identityClaimJournalTable)
        .where(eq(identityClaimJournalTable.agentId, deletionAgentId))
    ).toHaveLength(0);
    const receipts = await db.select().from(identityClaimRetentionLedgerTable);
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventKind: "observed", resultingVersion: 1 }),
      ])
    );
  });
});
