/**
 * Real PGlite coverage for publisher registration, complete-snapshot atomicity,
 * bounded freshness, cursor fencing, restart, and concurrent revocation.
 */
import type { MembershipScope, UUID } from "@elizaos/core";
import { count, eq } from "drizzle-orm";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectorAccountsTable } from "../../schema/connectorAccounts";
import { entityTable } from "../../schema/entity";
import {
  membershipAuthorityJournalTable,
  membershipAuthorityTable,
} from "../../schema/membershipAuthority";
import { SqlMembershipService } from "../../services/sql-membership";
import { type DrizzleDatabase, getDb } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("SqlMembershipService real authority", () => {
  let sequence = 0;
  let cleanup: () => Promise<void>;
  let service: SqlMembershipService;
  let db: DrizzleDatabase;
  let runtime: Awaited<ReturnType<typeof createIsolatedTestDatabase>>["runtime"];
  let scope: MembershipScope;
  let principalId: UUID;
  let secondPrincipalId: UUID;
  let nowMs: number;
  const publisher = {
    publisherInstanceId: "test-process-a",
    publisherGeneration: 0,
    evidenceMode: "ordered_delta" as const,
  };

  beforeEach(async () => {
    const setup = await createIsolatedTestDatabase(`membership_v2_${++sequence}`);
    cleanup = setup.cleanup;
    runtime = setup.runtime;
    db = getDb(setup.adapter);
    nowMs = Date.parse("2026-08-22T12:00:00.000Z");
    service = new SqlMembershipService(runtime, () => new Date(nowMs));
    const accountId = crypto.randomUUID() as UUID;
    principalId = crypto.randomUUID() as UUID;
    secondPrincipalId = crypto.randomUUID() as UUID;
    await db.insert(connectorAccountsTable).values({
      id: accountId,
      agentId: setup.testAgentId,
      provider: "test-connector",
      accountKey: `account-${accountId}`,
    });
    await db.insert(entityTable).values([
      { id: principalId, agentId: setup.testAgentId, names: ["One"] },
      { id: secondPrincipalId, agentId: setup.testAgentId, names: ["Two"] },
    ]);
    scope = {
      agentId: setup.testAgentId,
      connectorId: "test-connector",
      connectorAccountId: accountId,
      externalWorldId: "world",
      externalRoomId: "room",
    };
  }, 20_000);
  afterEach(async () => {
    await service.stop();
    await cleanup();
  }, 20_000);

  const observedAt = () => new Date(nowMs).toISOString();
  const validUntil = () => new Date(nowMs + 60_000).toISOString();
  const member = (canonicalPrincipalId: UUID) => ({
    canonicalPrincipalId,
    roles: ["member"],
    permissionSnapshot: { canRead: true, limits: [1, null] },
    runtime: { worldId: null, roomId: null, entityId: canonicalPrincipalId },
  });
  async function register(
    expectedGeneration = 0,
    idempotencyKey = "publisher-register",
    binding = publisher
  ) {
    return service.registerPublisher({
      ...scope,
      ...binding,
      expectedGeneration,
      idempotencyKey,
      observedAt: observedAt(),
    });
  }
  async function snapshot(
    members = [member(principalId)],
    expectedGeneration = 1,
    sourceVersion = 0,
    previousSourceCursor: string | null = null,
    sourceCursor = "snapshot-0",
    idempotencyKey = `snapshot-${sourceVersion}`
  ) {
    return service.applyCompleteSnapshot({
      ...scope,
      ...publisher,
      completeness: "complete",
      members,
      expectedGeneration,
      sourceVersion,
      previousSourceCursor,
      sourceCursor,
      validUntil: validUntil(),
      idempotencyKey,
      observedAt: observedAt(),
    });
  }
  async function delta(
    state: "active" | "revoked",
    reason: "joined" | "left" | "kicked" | "permission_restored",
    expectedGeneration: number,
    sourceVersion: number,
    previousSourceCursor: string,
    sourceCursor: string,
    idempotencyKey = `delta-${sourceVersion}`
  ) {
    return service.applyMembership({
      ...scope,
      ...publisher,
      canonicalPrincipalId: principalId,
      state,
      reason,
      roles: state === "active" ? ["member"] : [],
      permissionSnapshot: { canRead: state === "active" },
      runtime: { worldId: null, roomId: null, entityId: principalId },
      expectedGeneration,
      sourceVersion,
      previousSourceCursor,
      sourceCursor,
      validUntil: validUntil(),
      idempotencyKey,
      observedAt: observedAt(),
    });
  }

  it("cannot manufacture current authority with health and requires a complete snapshot before ordered deltas", async () => {
    await register();
    await expect(
      service.setScopeHealth({
        ...scope,
        health: "current",
        reason: "trust-me",
        expectedGeneration: 1,
        idempotencyKey: "bad-health",
        observedAt: observedAt(),
      } as never)
    ).rejects.toMatchObject({ code: "MEMBERSHIP_COMMAND_INVALID" });
    await expect(delta("active", "joined", 1, 0, "", "delta-0")).rejects.toMatchObject({
      code: "MEMBERSHIP_SNAPSHOT_REQUIRED",
    });
    await expect(service.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "denied",
      reason: "authority_stale",
    });
  });

  it("atomically upserts a complete snapshot and revokes every absent active fact", async () => {
    await register();
    await snapshot([member(principalId), member(secondPrincipalId)]);
    await expect(service.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "allowed",
    });
    const receipt = await snapshot([member(secondPrincipalId)], 2, 1, "snapshot-0", "snapshot-1");
    expect(receipt).toMatchObject({ operation: "snapshot", revokedPrincipalIds: [principalId] });
    await expect(service.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "denied",
      reason: "membership_revoked",
    });
    await expect(service.authorize(scope, secondPrincipalId)).resolves.toMatchObject({
      decision: "allowed",
    });
    expect(await service.getMembership(scope, principalId)).toMatchObject({
      state: "revoked",
      reason: "reconciled_absent",
    });
  });

  it("property-checks complete-snapshot replacement across roster subsets", async () => {
    let run = 0;
    const roster = fc.uniqueArray(fc.constantFrom(principalId, secondPrincipalId), {
      maxLength: 2,
    });
    await fc.assert(
      fc.asyncProperty(roster, roster, async (first, second) => {
        run += 1;
        const propertyScope = { ...scope, externalRoomId: `property-room-${run}` };
        await service.registerPublisher({
          ...propertyScope,
          ...publisher,
          expectedGeneration: 0,
          idempotencyKey: `property-register-${run}`,
          observedAt: observedAt(),
        });
        await service.applyCompleteSnapshot({
          ...propertyScope,
          ...publisher,
          completeness: "complete",
          members: first.map(member),
          expectedGeneration: 1,
          sourceVersion: 0,
          previousSourceCursor: null,
          sourceCursor: `property-${run}-0`,
          validUntil: validUntil(),
          idempotencyKey: `property-snapshot-${run}-0`,
          observedAt: observedAt(),
        });
        await service.applyCompleteSnapshot({
          ...propertyScope,
          ...publisher,
          completeness: "complete",
          members: second.map(member),
          expectedGeneration: 2,
          sourceVersion: 1,
          previousSourceCursor: `property-${run}-0`,
          sourceCursor: `property-${run}-1`,
          validUntil: validUntil(),
          idempotencyKey: `property-snapshot-${run}-1`,
          observedAt: observedAt(),
        });
        for (const principal of [principalId, secondPrincipalId]) {
          const fact = await service.getMembership(propertyScope, principal);
          if (second.includes(principal)) expect(fact?.state).toBe("active");
          else if (first.includes(principal)) expect(fact?.state).toBe("revoked");
          else expect(fact).toBeNull();
        }
      }),
      { numRuns: 12, seed: 23_101 }
    );
  });

  it("accepts an explicitly complete empty roster but makes incomplete/paginated input stale without changing facts", async () => {
    await register();
    await snapshot();
    const incomplete = await service.reportIncompleteSnapshot({
      ...scope,
      ...publisher,
      completeness: "incomplete",
      reason: "pagination_failed",
      expectedGeneration: 2,
      idempotencyKey: "partial",
      observedAt: observedAt(),
    });
    expect(incomplete).toMatchObject({
      operation: "health",
      committedGeneration: 3,
      health: { health: "stale", reason: "pagination_failed", sourceCursor: "snapshot-0" },
    });
    await expect(
      service.reportIncompleteSnapshot({
        ...scope,
        ...publisher,
        completeness: "incomplete",
        reason: "pagination_failed",
        expectedGeneration: 2,
        idempotencyKey: "partial",
        observedAt: observedAt(),
      })
    ).resolves.toEqual({ ...incomplete, idempotentReplay: true });
    await expect(service.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "denied",
      reason: "authority_stale",
      generation: 3,
    });
    expect(await service.getMembership(scope, principalId)).toMatchObject({
      state: "active",
      generation: 2,
      sourceCursor: "snapshot-0",
    });
    const empty = await snapshot([], 3, 1, "snapshot-0", "empty-complete");
    expect(empty).toMatchObject({
      operation: "snapshot",
      memberships: [],
      revokedPrincipalIds: [principalId],
    });
    await expect(service.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "denied",
      reason: "membership_revoked",
    });
  });

  it("checks persisted validity against the injected trusted clock on every authorization", async () => {
    await register();
    await snapshot();
    await expect(service.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "allowed",
    });
    nowMs += 60_001;
    await expect(service.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "denied",
      reason: "authority_expired",
    });
    await expect(delta("revoked", "left", 2, 1, "snapshot-0", "late-delta")).rejects.toMatchObject({
      code: "MEMBERSHIP_SNAPSHOT_REQUIRED",
    });
    const restarted = new SqlMembershipService(runtime, () => new Date(nowMs));
    await expect(restarted.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "denied",
      reason: "authority_expired",
    });
    await restarted.stop();
  });

  it("rejects validity windows that are expired or unbounded relative to observation time", async () => {
    await register();
    await expect(
      service.applyCompleteSnapshot({
        ...scope,
        ...publisher,
        completeness: "complete",
        members: [member(principalId)],
        expectedGeneration: 1,
        sourceVersion: 0,
        previousSourceCursor: null,
        sourceCursor: "expired",
        observedAt: new Date(nowMs - 60_000).toISOString(),
        validUntil: new Date(nowMs).toISOString(),
        idempotencyKey: "expired",
      })
    ).rejects.toMatchObject({ code: "MEMBERSHIP_COMMAND_INVALID" });
    await expect(
      service.applyCompleteSnapshot({
        ...scope,
        ...publisher,
        completeness: "complete",
        members: [member(principalId)],
        expectedGeneration: 1,
        sourceVersion: 0,
        previousSourceCursor: null,
        sourceCursor: "old-observation",
        observedAt: new Date(nowMs - 2 * 24 * 60 * 60 * 1_000).toISOString(),
        validUntil: new Date(nowMs + 60_000).toISOString(),
        idempotencyKey: "old-observation",
      })
    ).rejects.toMatchObject({ code: "MEMBERSHIP_COMMAND_INVALID" });
    expect(await db.select().from(membershipAuthorityTable)).toHaveLength(0);
  });

  it("binds evidence to publisher instance, generation, mode, and exact cursor continuity", async () => {
    await register();
    await snapshot();
    await expect(
      service.applyMembership({
        ...scope,
        ...publisher,
        publisherInstanceId: "other-process",
        canonicalPrincipalId: principalId,
        state: "revoked",
        reason: "left",
        roles: [],
        permissionSnapshot: {},
        runtime: { worldId: null, roomId: null, entityId: principalId },
        expectedGeneration: 2,
        sourceVersion: 1,
        previousSourceCursor: "snapshot-0",
        sourceCursor: "delta-1",
        validUntil: validUntil(),
        idempotencyKey: "wrong-publisher",
        observedAt: observedAt(),
      })
    ).rejects.toMatchObject({ code: "MEMBERSHIP_PUBLISHER_MISMATCH" });
    await expect(
      delta("revoked", "left", 2, 2, "snapshot-0", "skipped-version")
    ).rejects.toMatchObject({ code: "MEMBERSHIP_CURSOR_DISCONTINUITY" });
    await expect(delta("revoked", "left", 2, 1, "wrong-cursor", "delta-1")).rejects.toMatchObject({
      code: "MEMBERSHIP_CURSOR_DISCONTINUITY",
    });
    await delta("revoked", "left", 2, 1, "snapshot-0", "delta-1");
    await register(3, "publisher-generation-1", {
      ...publisher,
      publisherInstanceId: "replacement",
      publisherGeneration: 1,
    });
    await expect(service.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "denied",
      reason: "authority_stale",
    });
    await expect(
      delta("active", "permission_restored", 4, 2, "delta-1", "delta-2")
    ).rejects.toMatchObject({ code: "MEMBERSHIP_PUBLISHER_MISMATCH" });
  });

  it("preserves revocation against old evidence and exact idempotency across restart", async () => {
    await register();
    const first = await snapshot();
    await delta("revoked", "kicked", 2, 1, "snapshot-0", "delta-1", "kick-once");
    await expect(
      delta("active", "permission_restored", 3, 1, "snapshot-0", "old-restore")
    ).rejects.toMatchObject({ code: "MEMBERSHIP_CURSOR_DISCONTINUITY" });
    const restarted = new SqlMembershipService(runtime, () => new Date(nowMs));
    const replay = await restarted.applyCompleteSnapshot({
      ...scope,
      ...publisher,
      completeness: "complete",
      members: [member(principalId)],
      expectedGeneration: 1,
      sourceVersion: 0,
      previousSourceCursor: null,
      sourceCursor: "snapshot-0",
      validUntil: validUntil(),
      idempotencyKey: "snapshot-0",
      observedAt: observedAt(),
    });
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    await expect(restarted.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "denied",
      reason: "membership_revoked",
    });
    await restarted.stop();
  });

  it("serializes a concurrent complete snapshot against a revocation and coalesces exact retries", async () => {
    await register();
    const same = await Promise.all([snapshot(), snapshot()]);
    expect(same.map((receipt) => receipt.idempotentReplay).sort()).toEqual([false, true]);
    const raced = await Promise.allSettled([
      snapshot([], 2, 1, "snapshot-0", "race-snapshot", "race-snapshot"),
      delta("revoked", "left", 2, 1, "snapshot-0", "race-revocation", "race-revocation"),
    ]);
    expect(raced.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(
      (raced.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason
    ).toMatchObject({ code: "MEMBERSHIP_GENERATION_MISMATCH" });
    const [journal] = await db
      .select({ value: count() })
      .from(membershipAuthorityJournalTable)
      .where(eq(membershipAuthorityJournalTable.idempotencyKey, "snapshot-0"));
    expect(journal?.value).toBe(1);
  });

  it("validates unknown fields, roles, and nested JSON before persistence", async () => {
    await expect(
      service.registerPublisher({
        ...scope,
        ...publisher,
        expectedGeneration: 0,
        idempotencyKey: "extra",
        observedAt: observedAt(),
        trusted: true,
      } as never)
    ).rejects.toMatchObject({ code: "MEMBERSHIP_COMMAND_INVALID" });
    await register();
    await expect(
      snapshot([{ ...member(principalId), roles: ["member", "member"] }])
    ).rejects.toMatchObject({ code: "MEMBERSHIP_COMMAND_INVALID" });
    await expect(
      snapshot([{ ...member(principalId), permissionSnapshot: { impossible: Number.NaN } }])
    ).rejects.toMatchObject({ code: "MEMBERSHIP_COMMAND_INVALID" });
    await expect(
      service.applyCompleteSnapshot({
        ...scope,
        ...publisher,
        evidenceMode: "point_query",
        completeness: "complete",
        members: [member(principalId)],
        expectedGeneration: 1,
        sourceVersion: 0,
        previousSourceCursor: null,
        sourceCursor: "invalid-point-snapshot",
        validUntil: validUntil(),
        idempotencyKey: "invalid-point-snapshot",
        observedAt: observedAt(),
      } as never)
    ).rejects.toMatchObject({ code: "MEMBERSHIP_COMMAND_INVALID" });
    await expect(
      service.applyMembership({
        ...scope,
        ...publisher,
        evidenceMode: "complete_snapshot",
        canonicalPrincipalId: principalId,
        state: "active",
        reason: "joined",
        roles: ["member"],
        permissionSnapshot: {},
        runtime: { worldId: null, roomId: null, entityId: principalId },
        expectedGeneration: 1,
        sourceVersion: 0,
        previousSourceCursor: null,
        sourceCursor: "invalid-single-snapshot",
        validUntil: validUntil(),
        idempotencyKey: "invalid-single-snapshot",
        observedAt: observedAt(),
      } as never)
    ).rejects.toMatchObject({ code: "MEMBERSHIP_COMMAND_INVALID" });
    expect(await db.select().from(membershipAuthorityTable)).toHaveLength(0);
  });

  it("rejects contradictory membership state at the database boundary", async () => {
    await register();
    await expect(
      db.insert(membershipAuthorityTable).values({
        ...scope,
        canonicalPrincipalId: principalId,
        state: "active",
        reason: "left",
        roles: ["member"],
        permissionSnapshot: { canRead: true },
        runtimeWorldId: null,
        runtimeRoomId: null,
        runtimeEntityId: principalId,
        ...publisher,
        generation: 1,
        sourceVersion: 0,
        sourceCursor: "forged",
        observedAt: new Date(nowMs),
        validUntil: new Date(nowMs + 60_000),
      })
    ).rejects.toThrow();
    expect(await db.select().from(membershipAuthorityTable)).toHaveLength(0);
  });

  it("rejects an overlong persisted evidence window at the database boundary", async () => {
    await register();
    await expect(
      db.insert(membershipAuthorityTable).values({
        ...scope,
        canonicalPrincipalId: principalId,
        state: "active",
        reason: "joined",
        roles: ["member"],
        permissionSnapshot: {},
        publisherInstanceId: publisher.publisherInstanceId,
        publisherGeneration: publisher.publisherGeneration,
        evidenceMode: publisher.evidenceMode,
        generation: 1,
        sourceVersion: 0,
        sourceCursor: "forged-long-window",
        observedAt: new Date(nowMs),
        validUntil: new Date(nowMs + 24 * 60 * 60 * 1_000 + 1),
      })
    ).rejects.toThrow();
    expect(await db.select().from(membershipAuthorityTable)).toHaveLength(0);
  });

  it("supports bounded point-query proof without claiming connector or document integration", async () => {
    const pointPublisher = {
      publisherInstanceId: "point-query",
      publisherGeneration: 0,
      evidenceMode: "point_query" as const,
    };
    await register(0, "point-register", pointPublisher);
    await service.applyMembership({
      ...scope,
      ...pointPublisher,
      canonicalPrincipalId: principalId,
      state: "active",
      reason: "reconciled_present",
      roles: ["member"],
      permissionSnapshot: { canRead: true },
      runtime: { worldId: null, roomId: null, entityId: principalId },
      expectedGeneration: 1,
      sourceVersion: 0,
      previousSourceCursor: null,
      sourceCursor: "point-0",
      validUntil: validUntil(),
      idempotencyKey: "point-proof",
      observedAt: observedAt(),
    });
    await expect(service.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "allowed",
    });
    await expect(service.authorize(scope, secondPrincipalId)).resolves.toMatchObject({
      decision: "denied",
      reason: "no_membership",
    });
    await expect(service.getMembership(scope, secondPrincipalId)).resolves.toBeNull();
  });

  it("does not let a new point-query publisher inherit an old publisher's active fact", async () => {
    const firstPublisher = {
      publisherInstanceId: "point-query-a",
      publisherGeneration: 0,
      evidenceMode: "point_query" as const,
    };
    await register(0, "point-register-a", firstPublisher);
    await service.applyMembership({
      ...scope,
      ...firstPublisher,
      canonicalPrincipalId: principalId,
      state: "active",
      reason: "reconciled_present",
      roles: ["member"],
      permissionSnapshot: { canRead: true },
      runtime: { worldId: null, roomId: null, entityId: principalId },
      expectedGeneration: 1,
      sourceVersion: 0,
      previousSourceCursor: null,
      sourceCursor: "point-a-0",
      validUntil: validUntil(),
      idempotencyKey: "point-a-proof",
      observedAt: observedAt(),
    });
    const replacementPublisher = {
      publisherInstanceId: "point-query-b",
      publisherGeneration: 1,
      evidenceMode: "point_query" as const,
    };
    await register(2, "point-register-b", replacementPublisher);
    await service.applyMembership({
      ...scope,
      ...replacementPublisher,
      canonicalPrincipalId: secondPrincipalId,
      state: "active",
      reason: "reconciled_present",
      roles: ["member"],
      permissionSnapshot: { canRead: true },
      runtime: { worldId: null, roomId: null, entityId: secondPrincipalId },
      expectedGeneration: 3,
      sourceVersion: 0,
      previousSourceCursor: null,
      sourceCursor: "point-b-0",
      validUntil: validUntil(),
      idempotencyKey: "point-b-proof",
      observedAt: observedAt(),
    });
    await expect(service.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "denied",
      reason: "membership_evidence_mismatch",
      generation: 4,
    });
    await expect(service.authorize(scope, secondPrincipalId)).resolves.toMatchObject({
      decision: "allowed",
      generation: 4,
    });
  });

  it("fails closed before reading or writing a different runtime tenant", async () => {
    const foreignScope = { ...scope, agentId: crypto.randomUUID() as UUID };
    await expect(service.authorize(foreignScope, principalId)).rejects.toMatchObject({
      code: "MEMBERSHIP_TENANT_MISMATCH",
    });
    await expect(
      service.registerPublisher({
        ...foreignScope,
        ...publisher,
        expectedGeneration: 0,
        idempotencyKey: "foreign-tenant",
        observedAt: observedAt(),
      })
    ).rejects.toMatchObject({ code: "MEMBERSHIP_TENANT_MISMATCH" });
  });
});
