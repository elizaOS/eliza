/**
 * Exercises dormant canonical-claim lifecycle and legacy migration inventory
 * against a real migrated SQL adapter; no service registration or mocks are
 * used for the persistence boundary.
 */

import type { IAgentRuntime, UUID, VerifyIdentityClaimRequest } from "@elizaos/core";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectorAccountsTable } from "../../schema/connectorAccounts";
import { entityTable } from "../../schema/entity";
import { entityIdentityTable } from "../../schema/entityIdentity";
import {
  identityAuthorityStateTable,
  identityClaimJournalTable,
  identityClaimTable,
} from "../../schema/identityAuthority";
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
  const actorId = crypto.randomUUID() as UUID;
  const principalId = crypto.randomUUID() as UUID;
  const conflictingPrincipalId = crypto.randomUUID() as UUID;
  const accountId = crypto.randomUUID() as UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("identity-claim-lifecycle-real");
    cleanup = setup.cleanup;
    db = setup.adapter.getDatabase() as DrizzleDatabase;
    agentId = setup.testAgentId;
    runtime = setup.runtime;
    service = new SqlIdentityResolutionService(runtime);
    await db.insert(entityTable).values(
      [actorId, principalId, conflictingPrincipalId].map((id) => ({
        id,
        agentId,
        names: [id],
        metadata: {},
      }))
    );
    await db.insert(connectorAccountsTable).values({
      id: accountId,
      agentId,
      provider: "discord",
      accountKey: "identity-test-account",
      externalId: "bot-account-1",
      status: "connected",
    });
  });

  afterAll(async () => {
    await cleanup?.();
  });

  function observationRequest(overrides: Record<string, unknown> = {}) {
    const value = {
      agentId,
      actorPrincipalId: actorId,
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
      ...overrides,
    };
    return {
      ...value,
      requestDigest: computeIdentityRequestDigest("observe-claim", value),
    };
  }

  it("persists replay-safe lifecycle events and rejects stale concurrent transitions", async () => {
    const request = observationRequest();
    const observed = await service.observeClaim(request);
    expect(observed).toMatchObject({
      principalEntityId: principalId,
      verification: "observed",
      status: "active",
      version: 1,
    });
    expect(await service.observeClaim(request)).toEqual(observed);

    const verifyValue = {
      agentId,
      actorPrincipalId: actorId,
      claimId: observed.id,
      expectedVersion: 1,
      idempotencyKey: "verify-person-42",
      reason: "connector assertion verified",
      provenance: { verifier: "discord-adapter" },
      evidence: { assertionId: "assertion-1" },
      attestationKind: "connector_assertion" as const,
      verifiedAt: "2026-08-21T20:01:00.000Z",
    };
    const forgedVerification = { ...verifyValue, attestationKind: "owner_override" };
    await expect(
      service.verifyClaim({
        ...forgedVerification,
        requestDigest: computeIdentityRequestDigest("verify-claim", forgedVerification),
      } as VerifyIdentityClaimRequest)
    ).rejects.toMatchObject({ code: "IDENTITY_CLAIM_INPUT_INVALID" });
    const verified = await service.verifyClaim({
      ...verifyValue,
      requestDigest: computeIdentityRequestDigest("verify-claim", verifyValue),
    });
    expect(verified).toMatchObject({ verification: "verified", version: 2 });
    expect(verified.verification).not.toBe("owner_bound");

    const transition = (suffix: string) => {
      const value = {
        agentId,
        actorPrincipalId: actorId,
        claimId: observed.id,
        expectedVersion: 2,
        idempotencyKey: `dispute-person-42-${suffix}`,
        reason: "conflicting evidence",
        provenance: { reviewer: suffix },
        evidence: { contradiction: suffix },
      };
      return {
        ...value,
        requestDigest: computeIdentityRequestDigest("dispute-claim", value),
      };
    };
    const outcomes = await Promise.allSettled([
      service.disputeClaim(transition("left")),
      service.disputeClaim(transition("right")),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

    const disputed = await service.resolveClaim({ agentId, ...request.scope });
    // Disputed claims deliberately leave the active lookup surface.
    expect(disputed).toBeNull();
    const stored = await db
      .select()
      .from(identityClaimTable)
      .where(and(eq(identityClaimTable.id, observed.id), eq(identityClaimTable.agentId, agentId)));
    expect(stored[0]).toMatchObject({ status: "disputed", version: 3 });
    await expect(
      service.observeClaim(observationRequest({ idempotencyKey: "observe-disputed-person-42" }))
    ).rejects.toMatchObject({ code: "IDENTITY_CLAIM_TRANSITION_INVALID" });

    const revokeValue = {
      agentId,
      actorPrincipalId: actorId,
      claimId: observed.id,
      expectedVersion: 3,
      idempotencyKey: "revoke-person-42",
      reason: "provider recycled handle",
      provenance: { provider: "discord" },
      evidence: { eventId: "recycle-1" },
      revokedAt: "2026-08-21T20:02:00.000Z",
    };
    const revoked = await service.revokeClaim({
      ...revokeValue,
      requestDigest: computeIdentityRequestDigest("revoke-claim", revokeValue),
    });
    expect(revoked).toMatchObject({ status: "revoked", version: 4 });

    const journal = await service.listClaimJournal(agentId, observed.id, {
      limit: 10,
      cursor: null,
    });
    expect(journal.items.map((entry) => entry.eventKind).sort()).toEqual([
      "disputed",
      "observed",
      "revoked",
      "verified",
    ]);
    const [state] = await db
      .select()
      .from(identityAuthorityStateTable)
      .where(eq(identityAuthorityStateTable.agentId, agentId));
    expect(state?.generation).toBe(4);

    const restarted = new SqlIdentityResolutionService(runtime);
    expect(
      (await restarted.listClaimJournal(agentId, observed.id, { limit: 10, cursor: null })).items
    ).toHaveLength(4);
  });

  it("rejects cross-principal scoped-subject claims and idempotency-key mutation", async () => {
    const first = observationRequest({
      scope: {
        namespace: "provider_subject",
        connectorId: "discord",
        connectorAccountId: accountId,
        externalSubjectId: "person-99",
      },
      idempotencyKey: "observe-person-99",
    });
    await service.observeClaim(first);
    const conflicting = observationRequest({
      principalEntityId: conflictingPrincipalId,
      scope: first.scope,
      idempotencyKey: "observe-person-99-conflict",
    });
    await expect(service.observeClaim(conflicting)).rejects.toMatchObject({
      code: "IDENTITY_CLAIM_CONFLICT",
    });
    const changedReplay = observationRequest({
      scope: first.scope,
      idempotencyKey: "observe-person-99",
      displayName: "Changed",
    });
    await expect(service.observeClaim(changedReplay)).rejects.toMatchObject({
      code: "IDENTITY_IDEMPOTENCY_CONFLICT",
    });
  });

  it("reports incompatible LifeOps IDs and collisions without writing canonical rows", async () => {
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
    await db
      .update(entityTable)
      .set({
        metadata: { platformIdentities: [{ platform: "email", handle: "john@example.com" }] },
      })
      .where(eq(entityTable.id, principalId));
    await db.insert(relationshipTable).values({
      agentId,
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
      INSERT INTO app_lifeops.life_entities (entity_id, agent_id)
      VALUES ('ent_legacy_john', ${agentId})
    `);
    await db.execute(sql`
      INSERT INTO app_lifeops.life_entity_identities (
        id, agent_id, entity_id, platform, handle, connector_account_id, verified, confidence
      ) VALUES (
        'life-id-1', ${agentId}, 'ent_legacy_john', 'telegram', 'john', 'default', TRUE, 0.8
      )
    `);

    const beforeClaims = await db.select().from(identityClaimTable);
    const beforeJournal = await db.select().from(identityClaimJournalTable);
    const first = await service.inspectLegacyMigration(agentId);
    const second = await service.inspectLegacyMigration(agentId);
    expect(second.digest).toBe(first.digest);
    expect(second.generatedAt).not.toBe("");
    expect(first.rows).toEqual(
      [...first.rows].sort((left, right) =>
        [left.source, left.sourceId]
          .join("\0")
          .localeCompare([right.source, right.sourceId].join("\0"))
      )
    );
    expect(first.rows.find((row) => row.sourceId === "life-id-1")).toMatchObject({
      disposition: "needs_principal_projection",
      reasons: ["lifeops_principal_is_not_uuid", "lifeops_connector_account_is_not_uuid"],
    });
    expect(first.rows.filter((row) => row.source === "entity_identities")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          disposition: "conflict",
          reasons: expect.arrayContaining(["same_legacy_subject_on_multiple_principals"]),
        }),
      ])
    );
    expect(first.rows.find((row) => row.source === "trust_identity_links")).toMatchObject({
      reasons: ["source_is_not_tenant_scoped_and_cannot_be_read_safely"],
    });
    expect(await db.select().from(identityClaimTable)).toEqual(beforeClaims);
    expect(await db.select().from(identityClaimJournalTable)).toEqual(beforeJournal);
  });
});
