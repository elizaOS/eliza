/**
 * Real PGlite integration coverage for the canonical membership authority.
 * The harness runs actual dynamic migrations, SQL transactions, runtime event
 * observers, and service reads without mocking the authority under test.
 */
import {
  EventType,
  type MembershipAuthorizationDecision,
  type MembershipScope,
  type UUID,
} from "@elizaos/core";
import { count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectorAccountsTable } from "../../schema/connectorAccounts";
import { entityTable } from "../../schema/entity";
import { membershipAuthorityJournalTable } from "../../schema/membershipAuthority";
import { SqlMembershipService } from "../../services/sql-membership";
import { type DrizzleDatabase, getDb } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("SqlMembershipService real authority", () => {
  let testSequence = 0;
  let cleanup: () => Promise<void>;
  let service: SqlMembershipService;
  let db: DrizzleDatabase;
  let agentId: UUID;
  let accountId: UUID;
  let principalId: UUID;
  let scope: MembershipScope;
  let runtime: Awaited<ReturnType<typeof createIsolatedTestDatabase>>["runtime"];

  beforeEach(async () => {
    testSequence += 1;
    const setup = await createIsolatedTestDatabase(`membership_${testSequence}`);
    cleanup = setup.cleanup;
    runtime = setup.runtime;
    agentId = setup.testAgentId;
    db = getDb(setup.adapter);
    service = new SqlMembershipService(runtime);
    accountId = crypto.randomUUID() as UUID;
    principalId = crypto.randomUUID() as UUID;
    await db.insert(connectorAccountsTable).values({
      id: accountId,
      agentId,
      provider: "test-connector",
      accountKey: `account-${accountId}`,
    });
    await db.insert(entityTable).values({ id: principalId, agentId, names: ["Member"] });
    scope = {
      agentId,
      connectorId: "test-connector",
      connectorAccountId: accountId,
      externalWorldId: "world-1",
      externalRoomId: "room-1",
    };
  }, 20_000);

  afterEach(async () => {
    await service.stop();
    await cleanup();
  }, 20_000);

  async function setHealth(
    health: "current" | "stale" | "unavailable" | "unsupported",
    expectedGeneration: number,
    sourceVersion: number,
    idempotencyKey = `health-${sourceVersion}`
  ) {
    return service.setScopeHealth({
      ...scope,
      health,
      reason: `${health}-by-test`,
      expectedGeneration,
      sourceVersion,
      sourceCursor: `cursor-${sourceVersion}`,
      idempotencyKey,
      observedAt: new Date(1_700_000_000_000 + sourceVersion).toISOString(),
    });
  }

  async function apply(
    state: "active" | "revoked",
    reason:
      | "joined"
      | "reconciled_present"
      | "permission_restored"
      | "left"
      | "kicked"
      | "banned"
      | "permission_lost"
      | "account_removed"
      | "reconciled_absent",
    expectedGeneration: number,
    sourceVersion: number,
    idempotencyKey = `membership-${sourceVersion}`
  ) {
    return service.applyMembership({
      ...scope,
      canonicalPrincipalId: principalId,
      state,
      reason,
      roles: state === "active" ? ["member"] : [],
      permissionSnapshot: { canRead: state === "active" },
      runtime: { worldId: null, roomId: null, entityId: principalId },
      expectedGeneration,
      sourceVersion,
      sourceCursor: `cursor-${sourceVersion}`,
      idempotencyKey,
      observedAt: new Date(1_700_000_000_000 + sourceVersion).toISOString(),
    });
  }

  it("fails closed without current evidence and persists explicit health states", async () => {
    await expect(service.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "denied",
      reason: "no_scope_evidence",
      generation: null,
    });

    await setHealth("unsupported", 0, 1);
    await expect(service.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "denied",
      reason: "authority_unsupported",
      health: "unsupported",
      generation: 1,
    });

    await setHealth("unavailable", 1, 2);
    await expect(service.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "denied",
      reason: "authority_unavailable",
      health: "unavailable",
      generation: 2,
    });

    await setHealth("stale", 2, 3);
    const restarted = new SqlMembershipService(runtime);
    await expect(restarted.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "denied",
      reason: "authority_stale",
      health: "stale",
      generation: 3,
    });
  });

  it("applies an idempotent join and rejects conflicting key reuse", async () => {
    await setHealth("current", 0, 1);
    const joined = await apply("active", "joined", 1, 2, "join-once");
    expect(joined).toMatchObject({
      operation: "membership",
      idempotentReplay: false,
      committedGeneration: 2,
      membership: { state: "active", roles: ["member"] },
    });
    await expect(service.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "allowed",
      reason: "active_membership",
      generation: 2,
    });

    const replay = await apply("active", "joined", 1, 2, "join-once");
    expect(replay).toEqual({ ...joined, idempotentReplay: true });
    const [journalCount] = await db
      .select({ value: count() })
      .from(membershipAuthorityJournalTable)
      .where(eq(membershipAuthorityJournalTable.idempotencyKey, "join-once"));
    expect(journalCount?.value).toBe(1);

    await expect(apply("revoked", "left", 2, 3, "join-once")).rejects.toMatchObject({
      code: "MEMBERSHIP_IDEMPOTENCY_CONFLICT",
    });
  });

  it("commits denial and invalidates a warm allow cache before observers run", async () => {
    await setHealth("current", 0, 1);
    await apply("active", "joined", 1, 2);
    await expect(service.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "allowed",
    });
    const sibling = new SqlMembershipService(runtime);
    await expect(sibling.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "allowed",
    });

    const dependentAllowCache = new Set([principalId]);
    let invalidatedGeneration: number | null = null;
    service.registerInvalidator((_changedScope, receipt) => {
      dependentAllowCache.delete(principalId);
      invalidatedGeneration = receipt.committedGeneration;
    });

    let observerDecision: MembershipAuthorizationDecision | null = null;
    runtime.registerEvent(EventType.MEMBERSHIP_AUTHORITY_CHANGED, async (event) => {
      if (event.receipt.committedGeneration === 3) {
        expect(dependentAllowCache.has(principalId)).toBe(false);
        expect(invalidatedGeneration).toBe(3);
        observerDecision = await service.authorize(scope, principalId);
      }
    });
    await apply("revoked", "kicked", 2, 3);
    expect(observerDecision).toMatchObject({
      decision: "denied",
      reason: "membership_revoked",
      generation: 3,
    });
    await expect(sibling.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "denied",
      reason: "membership_revoked",
      generation: 3,
    });
  });

  it("prevents duplicate, stale, and out-of-order evidence from resurrecting a revocation", async () => {
    await setHealth("current", 0, 10);
    await apply("active", "joined", 1, 11);
    await apply("revoked", "banned", 2, 12);

    await expect(
      apply("active", "permission_restored", 3, 11, "late-restore")
    ).rejects.toMatchObject({ code: "MEMBERSHIP_SOURCE_VERSION_STALE" });
    await expect(
      apply("active", "permission_restored", 2, 13, "wrong-generation")
    ).rejects.toMatchObject({ code: "MEMBERSHIP_GENERATION_MISMATCH" });
    await expect(service.authorize(scope, principalId)).resolves.toMatchObject({
      decision: "denied",
      reason: "membership_revoked",
      generation: 3,
    });
  });

  it("serializes concurrent commands so only one expected generation can commit", async () => {
    await setHealth("current", 0, 1);
    const outcomes = await Promise.allSettled([
      apply("active", "joined", 1, 2, "concurrent-join"),
      apply("revoked", "reconciled_absent", 1, 3, "concurrent-absent"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(
      (outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason
    ).toMatchObject({ code: "MEMBERSHIP_GENERATION_MISMATCH" });
  });

  it("coalesces concurrent exact retries into one commit and one observer notification", async () => {
    await setHealth("current", 0, 1);
    let membershipNotifications = 0;
    runtime.registerEvent(EventType.MEMBERSHIP_AUTHORITY_CHANGED, async (event) => {
      if (event.receipt.operation === "membership") membershipNotifications += 1;
    });

    const receipts = await Promise.all([
      apply("active", "joined", 1, 2, "same-concurrent-join"),
      apply("active", "joined", 1, 2, "same-concurrent-join"),
    ]);
    expect(receipts.map((receipt) => receipt.idempotentReplay).sort()).toEqual([false, true]);
    expect(membershipNotifications).toBe(1);
  });

  it("rejects cross-tenant scopes and cross-tenant principal mappings", async () => {
    const otherAgentId = crypto.randomUUID() as UUID;
    await expect(
      service.authorize({ ...scope, agentId: otherAgentId }, principalId)
    ).rejects.toMatchObject({ code: "MEMBERSHIP_TENANT_MISMATCH" });

    await setHealth("current", 0, 1);
    await db.delete(entityTable).where(eq(entityTable.id, principalId));
    await expect(apply("active", "joined", 1, 2)).rejects.toMatchObject({
      code: "MEMBERSHIP_PRINCIPAL_NOT_FOUND",
    });
  });
});
