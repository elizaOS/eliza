/**
 * Exercises the production SQL identity authority against a real migrated
 * PGlite database, proving durable merge, replay, split, and tenant fencing.
 */

import type { UUID } from "@elizaos/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entityTable } from "../../schema/entity";
import {
  identityAuthorityStateTable,
  identityCanonicalRedirectTable,
  identityMergeConfirmationTable,
  identityMergeJournalTable,
} from "../../schema/identityAuthority";
import {
  computeIdentityRequestDigest,
  SqlIdentityResolutionService,
} from "../../services/sql-identity-resolution";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("SQL identity authority", () => {
  let cleanup: () => Promise<void>;
  let db: DrizzleDatabase;
  let service: SqlIdentityResolutionService;
  let agentId: UUID;
  const actorId = crypto.randomUUID() as UUID;
  const canonicalId = crypto.randomUUID() as UUID;
  const sourceA = crypto.randomUUID() as UUID;
  const sourceB = crypto.randomUUID() as UUID;
  const sourceC = crypto.randomUUID() as UUID;
  const sourceD = crypto.randomUUID() as UUID;
  const sourceE = crypto.randomUUID() as UUID;
  const sourceF = crypto.randomUUID() as UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("identity-authority-real");
    cleanup = setup.cleanup;
    db = setup.adapter.getDatabase() as DrizzleDatabase;
    agentId = setup.testAgentId;
    service = new SqlIdentityResolutionService(setup.runtime);
    await db.insert(entityTable).values(
      [actorId, canonicalId, sourceA, sourceB, sourceC, sourceD, sourceE, sourceF].map((id) => ({
        id,
        agentId,
        names: [id],
        metadata: {},
      }))
    );
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("merges non-destructively, replays exactly, then splits one source", async () => {
    const proposalKey = "proposal-1";
    const proposalValue = {
      agentId,
      canonicalPrincipalId: canonicalId,
      sourcePrincipalIds: [sourceA, sourceB],
      actorPrincipalId: actorId,
      reason: "verified same person",
      idempotencyKey: proposalKey,
    };
    const requestDigest = computeIdentityRequestDigest("propose-merge", proposalValue);
    const plan = await service.proposeMerge({ ...proposalValue, requestDigest });
    expect(plan.expectedGeneration).toBe(0);

    const confirmation = await service.confirmMerge({
      agentId,
      planId: plan.id,
      expectedGeneration: 0,
      actorPrincipalId: actorId,
    });
    const commitKey = "commit-1";
    const commitValue = {
      agentId,
      planId: plan.id,
      confirmationId: confirmation.id,
      expectedGeneration: 0,
      actorPrincipalId: actorId,
      idempotencyKey: commitKey,
    };
    const commitDigest = computeIdentityRequestDigest("commit-merge", commitValue);
    const committed = await service.commitMerge({ ...commitValue, requestDigest: commitDigest });
    const replayed = await service.commitMerge({ ...commitValue, requestDigest: commitDigest });
    expect(replayed).toEqual(committed);
    expect((await service.resolveForDataAccess(agentId, sourceA)).canonicalPrincipalId).toBe(
      canonicalId
    );
    expect((await service.resolveForDataAccess(agentId, sourceB)).canonicalPrincipalId).toBe(
      canonicalId
    );

    const sourceRows = await db
      .select({ id: entityTable.id })
      .from(entityTable)
      .where(and(eq(entityTable.agentId, agentId), eq(entityTable.id, sourceA)));
    expect(sourceRows).toHaveLength(1);
    const [stateAfterMerge] = await db
      .select()
      .from(identityAuthorityStateTable)
      .where(eq(identityAuthorityStateTable.agentId, agentId));
    expect(stateAfterMerge?.generation).toBe(1);

    const splitKey = "split-1";
    const splitValue = {
      agentId,
      parentJournalId: plan.id,
      principalIds: [sourceA],
      expectedGeneration: 1,
      actorPrincipalId: actorId,
      reason: "verified distinct person",
      idempotencyKey: splitKey,
    };
    const splitDigest = computeIdentityRequestDigest("split", splitValue);
    const split = await service.split({ ...splitValue, requestDigest: splitDigest });
    const splitReplay = await service.split({ ...splitValue, requestDigest: splitDigest });
    expect(splitReplay).toEqual(split);
    expect((await service.resolveCanonicalPrincipal(agentId, sourceA)).canonicalPrincipalId).toBe(
      sourceA
    );
    expect((await service.resolveCanonicalPrincipal(agentId, sourceB)).canonicalPrincipalId).toBe(
      canonicalId
    );

    const [stateAfterSplit] = await db
      .select()
      .from(identityAuthorityStateTable)
      .where(eq(identityAuthorityStateTable.agentId, agentId));
    expect(stateAfterSplit?.generation).toBe(2);
    expect(await db.select().from(identityCanonicalRedirectTable)).toHaveLength(2);
    expect(await db.select().from(identityMergeJournalTable)).toHaveLength(2);
    const [consumed] = await db.select().from(identityMergeConfirmationTable);
    expect(consumed?.status).toBe("consumed");
  });

  it("rejects foreign runtime tenants before reading", async () => {
    const foreignAgentId = crypto.randomUUID() as UUID;
    await expect(service.resolveCanonicalPrincipal(foreignAgentId, sourceA)).rejects.toMatchObject({
      code: "IDENTITY_TENANT_MISMATCH",
    });
  });

  it("serializes concurrent commits at one generation without partial writes", async () => {
    const [state] = await db
      .select()
      .from(identityAuthorityStateTable)
      .where(eq(identityAuthorityStateTable.agentId, agentId));
    const generation = state?.generation ?? -1;
    const prepare = async (sourcePrincipalId: UUID, suffix: string) => {
      const proposalValue = {
        agentId,
        canonicalPrincipalId: canonicalId,
        sourcePrincipalIds: [sourcePrincipalId],
        actorPrincipalId: actorId,
        reason: `concurrent-${suffix}`,
        idempotencyKey: `proposal-${suffix}`,
      };
      const plan = await service.proposeMerge({
        ...proposalValue,
        requestDigest: computeIdentityRequestDigest("propose-merge", proposalValue),
      });
      const confirmation = await service.confirmMerge({
        agentId,
        planId: plan.id,
        expectedGeneration: generation,
        actorPrincipalId: actorId,
      });
      const commitValue = {
        agentId,
        planId: plan.id,
        confirmationId: confirmation.id,
        expectedGeneration: generation,
        actorPrincipalId: actorId,
        idempotencyKey: `commit-${suffix}`,
      };
      return {
        request: {
          ...commitValue,
          requestDigest: computeIdentityRequestDigest("commit-merge", commitValue),
        },
      };
    };

    const left = await prepare(sourceC, "left");
    const right = await prepare(sourceD, "right");
    const outcomes = await Promise.allSettled([
      service.commitMerge(left.request),
      service.commitMerge(right.request),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const [after] = await db
      .select()
      .from(identityAuthorityStateTable)
      .where(eq(identityAuthorityStateTable.agentId, agentId));
    expect(after?.generation).toBe(generation + 1);

    const active = await db
      .select()
      .from(identityCanonicalRedirectTable)
      .where(
        and(
          eq(identityCanonicalRedirectTable.agentId, agentId),
          eq(identityCanonicalRedirectTable.status, "active")
        )
      );
    expect(
      active.filter((row) => row.sourcePrincipalId === sourceC || row.sourcePrincipalId === sourceD)
    ).toHaveLength(1);
  });

  it("rolls back confirmation, redirects, journal, and generation on a database fault", async () => {
    const [state] = await db
      .select()
      .from(identityAuthorityStateTable)
      .where(eq(identityAuthorityStateTable.agentId, agentId));
    const generation = state?.generation ?? -1;
    const proposalValue = {
      agentId,
      canonicalPrincipalId: canonicalId,
      sourcePrincipalIds: [sourceE, sourceF],
      actorPrincipalId: actorId,
      reason: "forced rollback proof",
      idempotencyKey: "proposal-rollback",
    };
    const plan = await service.proposeMerge({
      ...proposalValue,
      requestDigest: computeIdentityRequestDigest("propose-merge", proposalValue),
    });
    const confirmation = await service.confirmMerge({
      agentId,
      planId: plan.id,
      expectedGeneration: generation,
      actorPrincipalId: actorId,
    });
    const commitValue = {
      agentId,
      planId: plan.id,
      confirmationId: confirmation.id,
      expectedGeneration: generation,
      actorPrincipalId: actorId,
      idempotencyKey: "commit-rollback",
    };
    await db.execute(
      sql.raw(
        `ALTER TABLE identity_canonical_redirects ADD CONSTRAINT identity_test_forced_rollback CHECK (source_principal_id <> '${sourceF}'::uuid)`
      )
    );
    try {
      await expect(
        service.commitMerge({
          ...commitValue,
          requestDigest: computeIdentityRequestDigest("commit-merge", commitValue),
        })
      ).rejects.toBeDefined();
    } finally {
      await db.execute(
        sql.raw(
          "ALTER TABLE identity_canonical_redirects DROP CONSTRAINT identity_test_forced_rollback"
        )
      );
    }

    const [after] = await db
      .select()
      .from(identityAuthorityStateTable)
      .where(eq(identityAuthorityStateTable.agentId, agentId));
    expect(after?.generation).toBe(generation);
    expect(
      await db
        .select()
        .from(identityCanonicalRedirectTable)
        .where(inArray(identityCanonicalRedirectTable.sourcePrincipalId, [sourceE, sourceF]))
    ).toHaveLength(0);
    const [confirmationAfter] = await db
      .select()
      .from(identityMergeConfirmationTable)
      .where(eq(identityMergeConfirmationTable.id, confirmation.id));
    expect(confirmationAfter?.status).toBe("active");
    const [journalAfter] = await db
      .select()
      .from(identityMergeJournalTable)
      .where(eq(identityMergeJournalTable.id, plan.id));
    expect(journalAfter?.status).toBe("planned");
    expect(journalAfter?.commitIdempotencyKey).toBeNull();
  });
});
