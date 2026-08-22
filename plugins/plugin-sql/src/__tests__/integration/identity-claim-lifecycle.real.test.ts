/**
 * Exercises dormant claim authorization, deletion-safe immutable receipts,
 * and legacy migration inventory against a real migrated SQL adapter. The
 * persistence boundary is real PGlite or PostgreSQL; no adapter is mocked.
 */

import type {
  DisputeIdentityClaimRequest,
  IAgentRuntime,
  UUID,
  VerifyIdentityClaimRequest,
} from "@elizaos/core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentTable } from "../../schema/agent";
import { authIdentityTable } from "../../schema/authIdentity";
import { authOwnerBindingTable } from "../../schema/authOwnerBinding";
import { connectorAccountsTable } from "../../schema/connectorAccounts";
import { entityTable } from "../../schema/entity";
import { entityIdentityTable } from "../../schema/entityIdentity";
import { identityClaimJournalTable, identityClaimTable } from "../../schema/identityAuthority";
import { relationshipTable } from "../../schema/relationship";
import {
  computeIdentityRequestDigest,
  SqlIdentityResolutionService,
} from "../../services/sql-identity-resolution";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("SQL identity claim lifecycle and migration inventory", () => {
  let cleanup: () => Promise<void>;
  let db: DrizzleDatabase;
  let service: SqlIdentityResolutionService;
  let runtime: IAgentRuntime;
  let agentId: UUID;
  const ownerPrincipalId = crypto.randomUUID() as UUID;
  const principalId = crypto.randomUUID() as UUID;
  const conflictingPrincipalId = crypto.randomUUID() as UUID;
  const accountId = crypto.randomUUID() as UUID;
  const ownerAccountId = crypto.randomUUID() as UUID;
  const ownerBindingId = crypto.randomUUID();

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("identity-claim-lifecycle-real");
    cleanup = setup.cleanup;
    db = setup.adapter.getDatabase() as DrizzleDatabase;
    agentId = setup.testAgentId;
    runtime = setup.runtime;
    const getSetting = runtime.getSetting.bind(runtime);
    runtime.getSetting = (key) =>
      key === "ELIZA_INSTANCE_ID" ? "identity-claim-lifecycle-test" : getSetting(key);
    service = new SqlIdentityResolutionService(runtime);
    await db.insert(entityTable).values(
      [ownerPrincipalId, principalId, conflictingPrincipalId].map((id) => ({
        id,
        agentId,
        names: [id],
        metadata: {},
      }))
    );
    const identityId = crypto.randomUUID();
    await db.insert(authIdentityTable).values({
      id: identityId,
      kind: "owner",
      displayName: "Claim administrator",
      createdAt: Date.now(),
    });
    await db.insert(authOwnerBindingTable).values({
      id: ownerBindingId,
      identityId,
      connector: "telegram",
      externalId: "owner-subject",
      displayHandle: "owner",
      instanceId: "identity-claim-lifecycle-test",
      verifiedAt: Date.now(),
    });
    await db.insert(connectorAccountsTable).values([
      {
        id: accountId,
        agentId,
        provider: "discord",
        accountKey: "identity-test-account",
        externalId: "bot-account-1",
        status: "connected",
      },
      {
        id: ownerAccountId,
        agentId,
        provider: "telegram",
        accountKey: "identity-owner-account",
        externalId: "owner-subject",
        ownerBindingId,
        ownerIdentityId: identityId,
        accessGate: "owner_binding",
        status: "connected",
      },
    ]);
    await db.insert(identityClaimTable).values({
      agentId,
      principalEntityId: ownerPrincipalId,
      namespace: "connector_subject",
      connectorId: "telegram",
      connectorAccountId: ownerAccountId,
      externalSubjectId: "owner-subject",
      verification: "owner_bound",
      ownerBindingId,
      status: "active",
      confidence: 1,
      verifiedAt: new Date(),
    });
  }, 120_000);

  afterAll(async () => cleanup?.(), 120_000);

  function observationRequest() {
    const value = {
      agentId,
      actorPrincipalId: principalId,
      principalEntityId: principalId,
      scope: {
        namespace: "provider_subject",
        connectorId: "discord",
        connectorAccountId: accountId,
        externalSubjectId: "person-42",
      },
      handle: "john",
      displayName: "John",
      confidence: 0.7,
      observedAt: "2026-08-21T20:00:00.000Z",
      idempotencyKey: "observe-person-42",
      reason: "provider inbound observation",
      provenance: { providerEventId: "event-1" },
      evidence: { kind: "provider_event" },
    };
    return { ...value, requestDigest: computeIdentityRequestDigest("observe-claim", value) };
  }

  async function seedTargetClaim(subject: string): Promise<UUID> {
    const [claim] = await db
      .insert(identityClaimTable)
      .values({
        agentId,
        principalEntityId: principalId,
        namespace: "provider_subject",
        connectorId: "discord",
        connectorAccountId: accountId,
        externalSubjectId: subject,
        verification: "observed",
        status: "active",
        confidence: 0.7,
      })
      .returning({ id: identityClaimTable.id });
    if (!claim) throw new Error("claim fixture was not persisted");
    return claim.id as UUID;
  }

  it("fails closed without a capability-bound observation or verification producer", async () => {
    await expect(service.observeClaim(observationRequest())).rejects.toMatchObject({
      code: "IDENTITY_CLAIM_OBSERVATION_AUTHORITY_UNAVAILABLE",
    });
    const { requestDigest: ignoredDigest, ...invalidObservation } = observationRequest();
    void ignoredDigest;
    const nonCanonicalObservation = { ...invalidObservation, observedAt: "0" };
    await expect(
      service.observeClaim({
        ...nonCanonicalObservation,
        requestDigest: computeIdentityRequestDigest("observe-claim", nonCanonicalObservation),
      })
    ).rejects.toMatchObject({ code: "IDENTITY_CLAIM_INPUT_INVALID" });
    expect(
      await db
        .select()
        .from(identityClaimTable)
        .where(eq(identityClaimTable.externalSubjectId, "person-42"))
    ).toHaveLength(0);

    const claimId = await seedTargetClaim("person-unverified");
    const value = {
      agentId,
      actorPrincipalId: principalId,
      claimId,
      expectedVersion: 1,
      idempotencyKey: "verify-unavailable",
      reason: "caller cannot mint authority",
      provenance: {},
      evidence: {},
      verifiedAt: "2026-08-21T20:01:00.000Z",
    };
    await expect(
      service.verifyClaim({
        ...value,
        requestDigest: computeIdentityRequestDigest("verify-claim", value),
      })
    ).rejects.toMatchObject({ code: "IDENTITY_VERIFICATION_AUTHORITY_UNAVAILABLE" });
    const nonCanonicalVerification = { ...value, verifiedAt: "2026-08-21T20:01:00Z" };
    await expect(
      service.verifyClaim({
        ...nonCanonicalVerification,
        requestDigest: computeIdentityRequestDigest("verify-claim", nonCanonicalVerification),
      })
    ).rejects.toMatchObject({ code: "IDENTITY_CLAIM_INPUT_INVALID" });
    await expect(service.resolveVerifiedDeliveryClaims(agentId, principalId)).resolves.toEqual([]);
    await expect(service.resolveVerifiedDeliveryClaims(agentId, ownerPrincipalId)).resolves.toEqual(
      []
    );
    await expect(
      service.evaluateOwnerBinding({
        agentId,
        actorPrincipalId: ownerPrincipalId,
        candidateOwnerPrincipalIds: [ownerPrincipalId],
      })
    ).resolves.toEqual({ decision: "unavailable", reason: "service_unavailable" });

    const forged = {
      ...value,
      authority: { kind: "connector_assertion", auditEventId: crypto.randomUUID() },
    };
    await expect(
      service.verifyClaim({
        ...forged,
        requestDigest: computeIdentityRequestDigest("verify-claim", forged),
      } as unknown as VerifyIdentityClaimRequest)
    ).rejects.toMatchObject({ code: "IDENTITY_CLAIM_INPUT_INVALID" });
  });

  it("fails dispute and revoke closed without an authenticated administration producer", async () => {
    const claimId = await seedTargetClaim("person-administered");
    const dispute = {
      agentId,
      actorPrincipalId: ownerPrincipalId,
      claimId,
      expectedVersion: 1,
      idempotencyKey: "dispute-unavailable",
      reason: "owner reviewed conflicting evidence",
      provenance: {},
      evidence: {},
    };
    await expect(
      service.disputeClaim({
        ...dispute,
        requestDigest: computeIdentityRequestDigest("dispute-claim", dispute),
      })
    ).rejects.toMatchObject({ code: "IDENTITY_ADMIN_AUTHORITY_UNAVAILABLE" });

    const forged = {
      ...dispute,
      authority: { kind: "owner_binding", ownerBindingId },
    };
    await expect(
      service.disputeClaim({
        ...forged,
        requestDigest: computeIdentityRequestDigest("dispute-claim", forged),
      } as unknown as DisputeIdentityClaimRequest)
    ).rejects.toMatchObject({ code: "IDENTITY_CLAIM_INPUT_INVALID" });

    const revoke = {
      agentId,
      actorPrincipalId: ownerPrincipalId,
      claimId,
      expectedVersion: 1,
      idempotencyKey: "revoke-unavailable",
      reason: "recycled subject",
      provenance: {},
      evidence: {},
      revokedAt: "2026-08-21T20:02:00.000Z",
    };
    await expect(
      service.revokeClaim({
        ...revoke,
        requestDigest: computeIdentityRequestDigest("revoke-claim", revoke),
      })
    ).rejects.toMatchObject({ code: "IDENTITY_ADMIN_AUTHORITY_UNAVAILABLE" });

    const invalidRevocation = { ...revoke, revokedAt: "not-a-timestamp" };
    await expect(
      service.revokeClaim({
        ...invalidRevocation,
        requestDigest: computeIdentityRequestDigest("revoke-claim", invalidRevocation),
      })
    ).rejects.toMatchObject({ code: "IDENTITY_CLAIM_INPUT_INVALID" });
    await expect(
      service.listClaimJournal(agentId, claimId, { limit: 10, cursor: "not-a-uuid" })
    ).rejects.toMatchObject({ code: "IDENTITY_JOURNAL_CURSOR_INVALID" });
  });

  it("denies journal mutation while allowing the parent-agent deletion cascade", async () => {
    const deletionAgentId = crypto.randomUUID() as UUID;
    const deletionPrincipalId = crypto.randomUUID() as UUID;
    const deletionAccountId = crypto.randomUUID() as UUID;
    await db.insert(agentTable).values({ id: deletionAgentId, name: "deletion-fixture" });
    await db.insert(entityTable).values({
      id: deletionPrincipalId,
      agentId: deletionAgentId,
      names: ["deletion-fixture"],
      metadata: {},
    });
    await db.insert(connectorAccountsTable).values({
      id: deletionAccountId,
      agentId: deletionAgentId,
      provider: "discord",
      accountKey: "deletion-account",
      externalId: "deleted-subject",
      status: "connected",
    });
    const [claim] = await db
      .insert(identityClaimTable)
      .values({
        agentId: deletionAgentId,
        principalEntityId: deletionPrincipalId,
        namespace: "provider_subject",
        connectorId: "discord",
        connectorAccountId: deletionAccountId,
        externalSubjectId: "deleted-subject",
        verification: "observed",
        status: "active",
        confidence: 0.5,
      })
      .returning();
    if (!claim) throw new Error("deletion claim was not persisted");
    await db.insert(identityClaimJournalTable).values({
      agentId: deletionAgentId,
      claimId: claim.id,
      principalEntityId: deletionPrincipalId,
      eventKind: "observed",
      priorVersion: null,
      resultingVersion: 1,
      actorPrincipalId: deletionPrincipalId,
      idempotencyKey: "deletion-event",
      requestDigest: "secret-request-digest",
      reason: "contains identifying free text",
      provenance: { subject: "deleted-subject" },
      evidence: { principal: deletionPrincipalId },
      beforeClaim: null,
      afterClaim: claim,
    });
    await expect(
      Promise.resolve(
        db
          .update(identityClaimJournalTable)
          .set({ reason: "tampered" })
          .where(eq(identityClaimJournalTable.claimId, claim.id))
      )
    ).rejects.toBeDefined();
    await expect(
      Promise.resolve(
        db.delete(identityClaimJournalTable).where(eq(identityClaimJournalTable.claimId, claim.id))
      )
    ).rejects.toBeDefined();

    await db.delete(agentTable).where(eq(agentTable.id, deletionAgentId));
    expect(
      await db
        .select()
        .from(identityClaimJournalTable)
        .where(eq(identityClaimJournalTable.agentId, deletionAgentId))
    ).toHaveLength(0);
  });

  it("reports wrong-instance, unverified, disconnected, mismatched, and orphan identities", async () => {
    const wrongIdentityId = crypto.randomUUID();
    const wrongBindingId = crypto.randomUUID();
    const wrongAccountId = crypto.randomUUID() as UUID;
    await db.insert(authIdentityTable).values({
      id: wrongIdentityId,
      kind: "owner",
      displayName: "Wrong instance",
      createdAt: Date.now(),
    });
    await db.insert(authOwnerBindingTable).values({
      id: wrongBindingId,
      identityId: wrongIdentityId,
      connector: "discord",
      externalId: "expected-owner-subject",
      displayHandle: "wrong",
      instanceId: "another-instance",
      verifiedAt: 0,
    });
    await db.insert(connectorAccountsTable).values({
      id: wrongAccountId,
      agentId,
      provider: "discord",
      accountKey: "wrong-owner-account",
      externalId: "different-subject",
      ownerBindingId: wrongBindingId,
      status: "disabled",
    });
    await db.insert(entityIdentityTable).values([
      {
        agentId,
        entityId: principalId,
        platform: "telegram",
        handle: "same-handle",
        verified: true,
        confidence: 0.9,
      },
      {
        agentId,
        entityId: conflictingPrincipalId,
        platform: "telegram",
        handle: "same-handle",
        verified: true,
        confidence: 0.9,
      },
    ]);
    const foreignAgentId = crypto.randomUUID() as UUID;
    const foreignPrincipalId = crypto.randomUUID() as UUID;
    const foreignAccountId = crypto.randomUUID() as UUID;
    await db.insert(agentTable).values({ id: foreignAgentId, name: "foreign-inventory-agent" });
    await db.insert(entityTable).values({
      id: foreignPrincipalId,
      agentId: foreignAgentId,
      names: ["foreign principal"],
      metadata: {},
    });
    await db.insert(connectorAccountsTable).values({
      id: foreignAccountId,
      agentId: foreignAgentId,
      provider: "discord",
      accountKey: "foreign-inventory-account",
      externalId: "foreign-account",
      status: "connected",
    });
    await db.insert(entityIdentityTable).values({
      agentId: foreignAgentId,
      entityId: principalId,
      platform: "discord",
      handle: "cross-tenant-handle",
      verified: false,
      confidence: 0.2,
    });
    await db.insert(relationshipTable).values({
      agentId: foreignAgentId,
      sourceEntityId: principalId,
      targetEntityId: conflictingPrincipalId,
      tags: ["identity_link"],
      metadata: { status: "confirmed" },
    });
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS app_lifeops`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS app_lifeops.life_entities (
        entity_id text NOT NULL,
        agent_id text NOT NULL
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS app_lifeops.life_entity_identities (
        id text PRIMARY KEY,
        agent_id text NOT NULL,
        entity_id text NOT NULL,
        platform text NOT NULL,
        handle text NOT NULL,
        connector_account_id text NOT NULL,
        verified boolean NOT NULL,
        confidence real NOT NULL
      )
    `);
    await db.execute(sql`
      INSERT INTO app_lifeops.life_entity_identities (
        id, agent_id, entity_id, platform, handle, connector_account_id, verified, confidence
      ) VALUES (
        'life-id-missing', ${agentId}, 'ent_missing', 'telegram', 'missing', 'default', FALSE, 0.4
      )
    `);
    await db.execute(sql`
      INSERT INTO app_lifeops.life_entity_identities (
        id, agent_id, entity_id, platform, handle, connector_account_id, verified, confidence
      ) VALUES
        ('life-foreign-target-principal', ${foreignAgentId}, ${principalId}, 'discord', 'foreign-principal-ref', ${foreignAccountId}, FALSE, 0.3),
        ('life-foreign-target-account', ${foreignAgentId}, ${foreignPrincipalId}, 'discord', 'foreign-account-ref', ${accountId}, FALSE, 0.3)
    `);
    await db.execute(sql`
      INSERT INTO app_lifeops.life_entity_identities (
        id, agent_id, entity_id, platform, handle, connector_account_id, verified, confidence
      ) VALUES (
        'life-id-provider-mismatch', ${agentId}, ${principalId}, 'telegram', 'mismatch', ${accountId}, TRUE, 0.8
      )
    `);

    const beforeClaims = await db.select().from(identityClaimTable);
    const first = await service.inspectLegacyMigration(agentId);
    expect((await service.inspectLegacyMigration(agentId)).digest).toBe(first.digest);
    expect(first.rows.find((row) => row.sourceId === wrongBindingId)).toMatchObject({
      disposition: "conflict",
      reasons: expect.arrayContaining([
        "owner_binding_wrong_instance",
        "owner_binding_unverified",
        "owner_binding_connector_account_disconnected",
        "owner_binding_external_subject_mismatch",
        "owner_binding_identity_mismatch",
      ]),
    });
    expect(first.rows.find((row) => row.sourceId === wrongAccountId)).toMatchObject({
      disposition: "conflict",
      reasons: expect.arrayContaining(["connector_account_owner_binding_invalid"]),
    });
    expect(first.rows.find((row) => row.sourceId === "life-id-missing")).toMatchObject({
      reasons: expect.arrayContaining([
        "lifeops_entity_missing",
        "lifeops_principal_is_not_uuid",
        "lifeops_connector_account_is_not_uuid",
      ]),
    });
    expect(first.rows.find((row) => row.sourceId === "life-id-provider-mismatch")).toMatchObject({
      disposition: "conflict",
      reasons: expect.arrayContaining(["lifeops_connector_account_provider_mismatch"]),
    });
    expect(
      first.rows.find((row) => row.sourceId === "life-foreign-target-principal")
    ).toMatchObject({
      disposition: "conflict",
      reasons: expect.arrayContaining([
        "lifeops_identity_wrong_tenant",
        "lifeops_connector_account_wrong_tenant",
      ]),
    });
    expect(first.rows.find((row) => row.sourceId === "life-foreign-target-account")).toMatchObject({
      disposition: "conflict",
      reasons: expect.arrayContaining([
        "lifeops_identity_wrong_tenant",
        "lifeops_canonical_principal_wrong_tenant",
      ]),
    });
    expect(
      first.rows.find(
        (row) =>
          row.source === "entity_identities" &&
          row.externalSubjectReference === "cross-tenant-handle"
      )
    ).toMatchObject({
      disposition: "conflict",
      reasons: expect.arrayContaining(["legacy_identity_agent_entity_tenant_mismatch"]),
    });
    expect(first.rows.find((row) => row.source === "relationships_identity_link")).toMatchObject({
      disposition: "conflict",
      reasons: expect.arrayContaining(["relationship_identity_link_cross_tenant"]),
    });
    expect(first.sources.identity_claims).toBeGreaterThan(0);
    expect(first.rows.filter((row) => row.source === "entity_identities")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          disposition: "conflict",
          reasons: expect.arrayContaining(["same_legacy_subject_on_multiple_principals"]),
        }),
      ])
    );
    expect(await db.select().from(identityClaimTable)).toEqual(beforeClaims);
  });
});
