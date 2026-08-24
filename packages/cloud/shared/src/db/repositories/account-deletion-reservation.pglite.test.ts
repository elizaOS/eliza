/** Proves locked account deletion reservation and immediate local fences in PostgreSQL. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../client";
import { accountDeletionExports } from "../schemas/account-deletion-exports";
import { accountDeletionPhaseReceipts } from "../schemas/account-deletion-phase-receipts";
import { accountDeletionRequests } from "../schemas/account-deletion-requests";
import { apiKeys } from "../schemas/api-keys";
import { organizationBalanceRevisionSequence, organizations } from "../schemas/organizations";
import { userSessions } from "../schemas/user-sessions";
import { users } from "../schemas/users";
import { accountDeletionRequestsRepository } from "./account-deletion-requests";

const organizationId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";
const now = new Date("2026-08-22T12:00:00Z");
const recoveryExpiresAt = new Date("2026-09-21T12:00:00Z");

function reservationInput(requestId: string, tokenSuffix: string) {
  return {
    requestId,
    userId,
    organizationId,
    stewardUserId: "steward-personal",
    now,
    recoveryExpiresAt,
    statusTokenHash: `status-${tokenSuffix}`,
    statusTokenExpiresAt: new Date("2026-12-20T12:00:00Z"),
    recoveryTokenHash: `recovery-${tokenSuffix}`,
    recoveryTokenExpiresAt: recoveryExpiresAt,
    admissionTokenHash: `admission-${tokenSuffix}`,
    admissionTokenExpiresAt: recoveryExpiresAt,
    requestDigest: `request-${tokenSuffix}`,
    phases: [
      {
        phase: "account_authority",
        phaseOrder: 0,
        idempotencyKeyDigest: `authority-${tokenSuffix}`,
        completed: true,
      },
      {
        phase: "export",
        phaseOrder: 1,
        idempotencyKeyDigest: `export-${tokenSuffix}`,
      },
      {
        phase: "steward_deactivation",
        phaseOrder: 2,
        idempotencyKeyDigest: `steward-${tokenSuffix}`,
      },
    ],
  };
}

beforeAll(async () => {
  const { apply } = await pushSchema(
    {
      accountDeletionExports,
      accountDeletionPhaseReceipts,
      accountDeletionRequests,
      apiKeys,
      organizationBalanceRevisionSequence,
      organizations,
      userSessions,
      users,
    } as never,
    dbWrite as never,
  );
  await apply();
  await dbWrite.execute(`
    CREATE TABLE account_deletion_restrictive_fixture (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT
    )
  `);
  await dbWrite.execute(`
    CREATE TABLE agent_sandbox_replacement_attempts (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT
    )
  `);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function seedPersonalAccount(): Promise<void> {
  await dbWrite.insert(organizations).values({
    id: organizationId,
    name: "Personal",
    slug: "personal-reservation",
    auto_top_up_enabled: true,
    pay_as_you_go_from_earnings: true,
  });
  await dbWrite.insert(users).values({
    id: userId,
    organization_id: organizationId,
    steward_user_id: "steward-personal",
    role: "owner",
  });
  await dbWrite.insert(apiKeys).values({
    id: "30000000-0000-4000-8000-000000000001",
    name: "test",
    key_hash: "key-hash",
    key_prefix: "eliza_test",
    organization_id: organizationId,
    user_id: userId,
  });
  await dbWrite.insert(userSessions).values({
    id: "40000000-0000-4000-8000-000000000001",
    user_id: userId,
    organization_id: organizationId,
    session_token: "session-token",
  });
}

beforeEach(async () => {
  await dbWrite.execute("DELETE FROM account_deletion_restrictive_fixture");
  await dbWrite.execute("DELETE FROM agent_sandbox_replacement_attempts");
  await dbWrite.delete(accountDeletionRequests);
  await dbWrite.delete(organizations);
  await seedPersonalAccount();
});

describe("personal account deletion reservation", () => {
  test("never returns an open receipt from a different organization", async () => {
    const otherOrganizationId = "10000000-0000-4000-8000-000000000002";
    await dbWrite.insert(organizations).values({
      id: otherOrganizationId,
      name: "Other",
      slug: "other-reservation",
    });
    await dbWrite.insert(accountDeletionRequests).values({
      id: "50000000-0000-4000-8000-000000000099",
      user_id: userId,
      organization_id: otherOrganizationId,
      steward_user_id: "steward-personal",
      status: "reserved",
      execute_after: recoveryExpiresAt,
    });

    await expect(
      accountDeletionRequestsRepository.findOpenByUserAndOrganizationId(
        userId,
        organizationId,
        true,
      ),
    ).resolves.toBeUndefined();
    await expect(
      accountDeletionRequestsRepository.findOpenByUserAndOrganizationId(
        userId,
        otherOrganizationId,
        true,
      ),
    ).resolves.toMatchObject({
      id: "50000000-0000-4000-8000-000000000099",
      organization_id: otherOrganizationId,
    });
  });

  test("publishes receipt, authority revision, credential, key, and session fences atomically", async () => {
    const result = await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000001", "one"),
    );
    expect(result.outcome).toBe("reserved");
    if (result.outcome !== "reserved") throw new Error("reservation failed");

    const [organization] = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    const [user] = await dbWrite.select().from(users).where(eq(users.id, userId));
    const [key] = await dbWrite.select().from(apiKeys).where(eq(apiKeys.user_id, userId));
    const [session] = await dbWrite
      .select()
      .from(userSessions)
      .where(eq(userSessions.user_id, userId));
    const phases = await dbWrite
      .select()
      .from(accountDeletionPhaseReceipts)
      .where(eq(accountDeletionPhaseReceipts.request_id, result.request.id));
    const exports = await dbWrite
      .select()
      .from(accountDeletionExports)
      .where(eq(accountDeletionExports.request_id, result.request.id));

    expect(result.request).toMatchObject({
      status: "reserved",
      admission_token_hash: "admission-one",
      restore_auto_top_up_enabled: true,
      restore_pay_as_you_go_from_earnings: true,
    });
    expect(organization).toMatchObject({
      is_active: false,
      auto_top_up_enabled: false,
      pay_as_you_go_from_earnings: false,
      account_lifecycle_state: "deletion_recovery",
      account_lifecycle_revision: 1,
    });
    expect(user).toMatchObject({
      is_active: false,
      account_lifecycle_state: "deletion_recovery",
      account_lifecycle_revision: 1,
    });
    expect(key?.is_active).toBe(false);
    expect(session?.ended_at).toEqual(now);
    expect(phases).toHaveLength(3);
    expect(phases.find((phase) => phase.phase === "account_authority")?.status).toBe("completed");
    expect(exports).toHaveLength(1);

    const status = await accountDeletionRequestsRepository.findByStatusTokenHash("status-one", now);
    expect(status?.request.id).toBe(result.request.id);
    expect(status?.exportReceipt?.status).toBe("pending");
    const admission = await accountDeletionRequestsRepository.findByAdmissionTokenHash(
      "admission-one",
      now,
    );
    expect(admission?.request.id).toBe(result.request.id);
  });

  test("replays only the matching admission hash after a committed response is lost", async () => {
    const first = await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000010", "lost-response"),
    );
    const retry = await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000011", "lost-response"),
    );
    const wrongSecret = await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000012", "wrong-secret"),
    );

    expect(first.outcome).toBe("reserved");
    expect(retry.outcome).toBe("replayed");
    expect(wrongSecret.outcome).toBe("existing");
    if (!("request" in first) || !("request" in retry) || !("request" in wrongSecret)) {
      throw new Error("reservation receipts were not returned");
    }
    expect(retry.request.id).toBe(first.request.id);
    expect(wrongSecret.request.id).toBe(first.request.id);
    expect(await dbWrite.select().from(accountDeletionRequests)).toHaveLength(1);
  });

  test("serializes concurrent retries without rotating the winner capabilities", async () => {
    const [left, right] = await Promise.all([
      accountDeletionRequestsRepository.reservePersonalAccountDeletion(
        reservationInput("50000000-0000-4000-8000-000000000002", "two"),
      ),
      accountDeletionRequestsRepository.reservePersonalAccountDeletion(
        reservationInput("50000000-0000-4000-8000-000000000003", "three"),
      ),
    ]);
    expect([left.outcome, right.outcome].sort()).toEqual(["existing", "reserved"]);
    if (!("request" in left) || !("request" in right)) {
      throw new Error("concurrent reservations did not return receipts");
    }
    expect(left.request.id).toBe(right.request.id);
    const winnerToken = left.outcome === "reserved" ? "status-two" : "status-three";
    expect(left.request.status_token_hash).toBe(winnerToken);
    expect(right.request.status_token_hash).toBe(winnerToken);
    const receipts = await dbWrite.select().from(accountDeletionRequests);
    expect(receipts).toHaveLength(1);
  });

  test("undo restores lifecycle authority but leaves sessions and API keys revoked", async () => {
    const reserved = await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000004", "undo"),
    );
    expect(reserved.outcome).toBe("reserved");
    if (reserved.outcome !== "reserved") throw new Error("reservation failed");

    const staleDeactivation = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "steward_deactivation",
      leaseOwnerDigest: "stale-deactivation-worker",
      now,
      leaseMilliseconds: 60_000,
    });
    if (!staleDeactivation) throw new Error("Steward deactivation lease failed");
    expect(
      await accountDeletionRequestsRepository.markPhaseProviderCallStarted(
        staleDeactivation.receipt.id,
        staleDeactivation.generation,
        now,
      ),
    ).toBe(true);

    const canceled = await accountDeletionRequestsRepository.cancelDuringRecovery({
      recoveryTokenHash: "recovery-undo",
      reactivationIdempotencyKeyDigest: "reactivation-undo",
      exportRevocationIdempotencyKeyDigest: "export-revoke-undo",
      exportRevocationNotBefore: new Date("2026-08-23T12:15:00Z"),
      now: new Date("2026-08-23T12:00:00Z"),
    });
    expect(canceled.outcome).toBe("canceling");
    const retriedCancellation = await accountDeletionRequestsRepository.cancelDuringRecovery({
      recoveryTokenHash: "recovery-undo",
      reactivationIdempotencyKeyDigest: "reactivation-undo",
      exportRevocationIdempotencyKeyDigest: "export-revoke-undo",
      exportRevocationNotBefore: new Date("2026-08-23T12:15:00Z"),
      now: new Date("2026-08-23T12:00:01Z"),
    });
    expect(retriedCancellation.outcome).toBe("already_canceling");
    if (retriedCancellation.outcome !== "already_canceling") {
      throw new Error("cancel replay did not return the fenced receipt");
    }
    expect(retriedCancellation.request).toMatchObject({
      status: "canceling",
      recovery_token_hash: "recovery-undo",
    });

    const [organization] = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    const [user] = await dbWrite.select().from(users).where(eq(users.id, userId));
    const [key] = await dbWrite.select().from(apiKeys).where(eq(apiKeys.user_id, userId));
    const [session] = await dbWrite
      .select()
      .from(userSessions)
      .where(eq(userSessions.user_id, userId));
    const phases = await dbWrite
      .select()
      .from(accountDeletionPhaseReceipts)
      .where(eq(accountDeletionPhaseReceipts.request_id, reserved.request.id));
    const [exportReceipt] = await dbWrite
      .select()
      .from(accountDeletionExports)
      .where(eq(accountDeletionExports.request_id, reserved.request.id));

    expect(organization).toMatchObject({
      is_active: false,
      auto_top_up_enabled: false,
      pay_as_you_go_from_earnings: false,
      account_lifecycle_state: "deletion_recovery",
      account_lifecycle_revision: 1,
      account_deletion_request_id: reserved.request.id,
    });
    expect(user).toMatchObject({
      is_active: false,
      account_lifecycle_state: "deletion_recovery",
      account_lifecycle_revision: 1,
      account_deletion_request_id: reserved.request.id,
      auth_fenced_at: now,
    });
    expect(key?.is_active).toBe(false);
    expect(session?.ended_at).toEqual(now);
    expect(exportReceipt?.status).toBe("expired");
    expect(phases.find((phase) => phase.phase === "steward_reactivation")).toMatchObject({
      status: "pending",
    });
    expect(phases.find((phase) => phase.phase === "export_revoke")).toMatchObject({
      status: "pending",
      idempotency_key_digest: "export-revoke-undo",
    });
    expect(
      await accountDeletionRequestsRepository.completeStewardDeactivationPhase({
        requestId: reserved.request.id,
        phaseReceiptId: staleDeactivation.receipt.id,
        generation: staleDeactivation.generation,
        providerReceiptDigest: "stale-provider-callback",
        now: new Date("2026-08-23T12:01:00Z"),
      }),
    ).toBe(false);

    const reactivationLease = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "steward_reactivation",
      leaseOwnerDigest: "reactivation-worker",
      now: new Date("2026-08-23T12:01:00Z"),
      leaseMilliseconds: 60_000,
    });
    if (!reactivationLease) throw new Error("Steward reactivation lease failed");
    expect(
      await accountDeletionRequestsRepository.markPhaseProviderCallStarted(
        reactivationLease.receipt.id,
        reactivationLease.generation,
        new Date("2026-08-23T12:01:00Z"),
      ),
    ).toBe(true);
    expect(
      await accountDeletionRequestsRepository.completeStewardReactivationPhase({
        requestId: reserved.request.id,
        phaseReceiptId: reactivationLease.receipt.id,
        generation: reactivationLease.generation,
        providerReceiptDigest: "reactivation-receipt",
        now: new Date("2026-08-23T12:01:01Z"),
      }),
    ).toBe(true);
    expect(
      await accountDeletionRequestsRepository.finalizeCancellationIfComplete({
        requestId: reserved.request.id,
        now: new Date("2026-08-23T12:01:02Z"),
      }),
    ).toBe(false);

    const revokeLease = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "export_revoke",
      leaseOwnerDigest: "export-revoke-worker",
      now: new Date("2026-08-23T12:15:01Z"),
      leaseMilliseconds: 60_000,
    });
    if (!revokeLease) throw new Error("export revocation lease failed");
    expect(
      await accountDeletionRequestsRepository.completeExportRevocation({
        requestId: reserved.request.id,
        phaseReceiptId: revokeLease.receipt.id,
        generation: revokeLease.generation,
        providerReceiptDigest: "export-delete-receipt",
        now: new Date("2026-08-23T12:15:01Z"),
      }),
    ).toBe(true);
    const [deletedExport] = await dbWrite
      .select()
      .from(accountDeletionExports)
      .where(eq(accountDeletionExports.request_id, reserved.request.id));
    expect(deletedExport).toMatchObject({
      status: "deleted",
      content_digest: null,
      byte_count: null,
      object_receipt_digest: "export-delete-receipt",
    });

    expect(
      await accountDeletionRequestsRepository.finalizeCancellationIfComplete({
        requestId: reserved.request.id,
        now: new Date("2026-08-23T12:15:02Z"),
      }),
    ).toBe(true);

    const [request] = await dbWrite
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, reserved.request.id));
    expect(request).toMatchObject({
      status: "canceled",
      lifecycle_revision: 2,
      recovery_token_hash: null,
      recovery_token_expires_at: null,
      last_error_code: null,
    });
    const [restoredOrganization] = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    const [restoredUser] = await dbWrite.select().from(users).where(eq(users.id, userId));
    expect(restoredOrganization).toMatchObject({
      is_active: true,
      auto_top_up_enabled: true,
      pay_as_you_go_from_earnings: true,
      account_lifecycle_state: "active",
      account_lifecycle_revision: 2,
      account_deletion_request_id: null,
      paid_work_fenced_at: null,
    });
    expect(restoredUser).toMatchObject({
      is_active: true,
      account_lifecycle_state: "active",
      account_lifecycle_revision: 2,
      account_deletion_request_id: null,
      auth_fenced_at: null,
    });
  });

  test("never restores authority after the recovery deadline", async () => {
    await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000005", "expired"),
    );
    const result = await accountDeletionRequestsRepository.cancelDuringRecovery({
      recoveryTokenHash: "recovery-expired",
      reactivationIdempotencyKeyDigest: "reactivation-expired",
      exportRevocationIdempotencyKeyDigest: "export-revoke-expired",
      exportRevocationNotBefore: new Date("2026-09-22T12:15:00Z"),
      now: new Date("2026-09-21T12:00:00Z"),
    });
    expect(result).toEqual({ outcome: "recovery_expired" });

    const [organization] = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    expect(organization).toMatchObject({
      is_active: false,
      account_lifecycle_state: "deletion_recovery",
      account_lifecycle_revision: 1,
    });
  });

  test("reconciles export completion only for the newest worker generation", async () => {
    const reserved = await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000006", "export"),
    );
    expect(reserved.outcome).toBe("reserved");
    if (reserved.outcome !== "reserved") throw new Error("reservation failed");

    const firstLease = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "export",
      leaseOwnerDigest: "export-worker-one",
      now,
      leaseMilliseconds: 1_000,
    });
    expect(firstLease).toBeDefined();
    if (!firstLease) throw new Error("export was not leased");
    expect(
      await accountDeletionRequestsRepository.markExportBuilding({
        requestId: reserved.request.id,
        phaseReceiptId: firstLease.receipt.id,
        generation: firstLease.generation,
        now,
      }),
    ).toBe(true);
    expect(
      await accountDeletionRequestsRepository.markPhaseProviderCallStarted(
        firstLease.receipt.id,
        firstLease.generation,
        now,
      ),
    ).toBe(true);

    const secondLease = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "export",
      leaseOwnerDigest: "export-worker-two",
      now: new Date(now.getTime() + 2_000),
      leaseMilliseconds: 1_000,
    });
    expect(secondLease?.receipt.status).toBe("reconciling");
    if (!secondLease) throw new Error("stale export was not reconciled");

    expect(
      await accountDeletionRequestsRepository.completeExportPhase({
        requestId: reserved.request.id,
        phaseReceiptId: firstLease.receipt.id,
        generation: firstLease.generation,
        contentDigest: "content-digest",
        objectReceiptDigest: "object-receipt-digest",
        byteCount: 123,
        now: new Date(now.getTime() + 2_000),
      }),
    ).toBe(false);
    expect(
      await accountDeletionRequestsRepository.completeExportPhase({
        requestId: reserved.request.id,
        phaseReceiptId: secondLease.receipt.id,
        generation: secondLease.generation,
        contentDigest: "content-digest",
        objectReceiptDigest: "object-receipt-digest",
        byteCount: 123,
        now: new Date(now.getTime() + 2_000),
      }),
    ).toBe(true);

    const [request] = await dbWrite
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, reserved.request.id));
    const [exportReceipt] = await dbWrite
      .select()
      .from(accountDeletionExports)
      .where(eq(accountDeletionExports.request_id, reserved.request.id));
    const [phase] = await dbWrite
      .select()
      .from(accountDeletionPhaseReceipts)
      .where(eq(accountDeletionPhaseReceipts.id, secondLease.receipt.id));
    expect(request?.status).toBe("recovery");
    expect(exportReceipt).toMatchObject({
      status: "ready",
      content_digest: "content-digest",
      object_receipt_digest: "object-receipt-digest",
      byte_count: 123,
    });
    expect(phase).toMatchObject({
      status: "completed",
      lease_generation: secondLease.generation,
    });
  });

  test("preserves reconciliation mode across an explicit lost-response retry", async () => {
    const reserved = await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000006", "reconcile"),
    );
    if (reserved.outcome !== "reserved") throw new Error("reservation failed");
    const leased = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "export",
      leaseOwnerDigest: "worker-one",
      now,
      leaseMilliseconds: 60_000,
    });
    if (!leased) throw new Error("export lease failed");
    expect(
      await accountDeletionRequestsRepository.markPhaseProviderCallStarted(
        leased.receipt.id,
        leased.generation,
        now,
      ),
    ).toBe(true);
    expect(
      await accountDeletionRequestsRepository.markPhaseForReconciliation({
        phaseReceiptId: leased.receipt.id,
        generation: leased.generation,
        errorCode: "EXPORT_OBJECT_OUTCOME_AMBIGUOUS",
        now,
        retryAt: new Date(now.getTime() + 60_000),
      }),
    ).toBe(true);

    const reconciliation = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "export",
      leaseOwnerDigest: "worker-two",
      now: new Date(now.getTime() + 60_001),
      leaseMilliseconds: 60_000,
    });
    expect(reconciliation?.receipt.status).toBe("reconciling");
    expect(reconciliation?.generation).toBe(leased.generation + 1);
  });

  test("publishes irreversible authority once across concurrent expiry workers", async () => {
    const reserved = await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000007", "expiry"),
    );
    if (reserved.outcome !== "reserved") throw new Error("reservation failed");

    const exportLease = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "export",
      leaseOwnerDigest: "export-worker",
      now,
      leaseMilliseconds: 60_000,
    });
    if (!exportLease) throw new Error("export lease failed");
    expect(
      await accountDeletionRequestsRepository.markExportBuilding({
        requestId: reserved.request.id,
        phaseReceiptId: exportLease.receipt.id,
        generation: exportLease.generation,
        now,
      }),
    ).toBe(true);
    expect(
      await accountDeletionRequestsRepository.markPhaseProviderCallStarted(
        exportLease.receipt.id,
        exportLease.generation,
        now,
      ),
    ).toBe(true);
    expect(
      await accountDeletionRequestsRepository.completeExportPhase({
        requestId: reserved.request.id,
        phaseReceiptId: exportLease.receipt.id,
        generation: exportLease.generation,
        contentDigest: "content-digest",
        objectReceiptDigest: "object-receipt-digest",
        byteCount: 123,
        now,
      }),
    ).toBe(true);

    const stewardLease = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "steward_deactivation",
      leaseOwnerDigest: "steward-worker",
      now,
      leaseMilliseconds: 60_000,
    });
    if (!stewardLease) throw new Error("Steward lease failed");
    expect(
      await accountDeletionRequestsRepository.completeStewardDeactivationPhase({
        requestId: reserved.request.id,
        phaseReceiptId: stewardLease.receipt.id,
        generation: stewardLease.generation,
        providerReceiptDigest: "steward-receipt",
        now,
      }),
    ).toBe(true);

    const expiry = new Date(recoveryExpiresAt.getTime() + 1);
    const input = {
      requestId: reserved.request.id,
      exportRevocationIdempotencyKeyDigest: "export-revoke-expiry",
      exportRevocationNotBefore: new Date(expiry.getTime() + 60_000),
      now: expiry,
    };
    const [left, right] = await Promise.all([
      accountDeletionRequestsRepository.activateExpiredPersonalAccountDeletion(input),
      accountDeletionRequestsRepository.activateExpiredPersonalAccountDeletion(input),
    ]);
    expect([left.outcome, right.outcome].sort()).toEqual(["activated", "already_activated"]);

    const [request] = await dbWrite
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, reserved.request.id));
    const [organization] = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    const [user] = await dbWrite.select().from(users).where(eq(users.id, userId));
    const phases = await dbWrite
      .select()
      .from(accountDeletionPhaseReceipts)
      .where(eq(accountDeletionPhaseReceipts.request_id, reserved.request.id));
    expect(request).toMatchObject({
      status: "scheduled",
      lifecycle_revision: 2,
      recovery_token_hash: null,
    });
    expect(organization).toMatchObject({
      account_lifecycle_state: "deletion_irreversible",
      account_lifecycle_revision: 2,
    });
    expect(user).toMatchObject({
      account_lifecycle_state: "deletion_irreversible",
      account_lifecycle_revision: 2,
    });
    expect(phases.filter((phase) => phase.phase === "export_revoke")).toHaveLength(1);
  });

  test("fails closed at expiry until export and Steward receipts are complete", async () => {
    const reserved = await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000008", "incomplete"),
    );
    if (reserved.outcome !== "reserved") throw new Error("reservation failed");

    const activation =
      await accountDeletionRequestsRepository.activateExpiredPersonalAccountDeletion({
        requestId: reserved.request.id,
        exportRevocationIdempotencyKeyDigest: "export-revoke-incomplete",
        exportRevocationNotBefore: new Date(recoveryExpiresAt.getTime() + 60_000),
        now: new Date(recoveryExpiresAt.getTime() + 1),
      });
    expect(activation).toEqual({ outcome: "export_required" });

    const [request] = await dbWrite
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, reserved.request.id));
    const [organization] = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    expect(request).toMatchObject({ status: "reserved", lifecycle_revision: 1 });
    expect(organization).toMatchObject({
      account_lifecycle_state: "deletion_recovery",
      account_lifecycle_revision: 1,
    });
  });

  test("atomically erases the personal database graph and retains only an anonymous receipt", async () => {
    const input = reservationInput("50000000-0000-4000-8000-000000000009", "erase");
    input.phases.push({
      phase: "database_erasure",
      phaseOrder: 130,
      idempotencyKeyDigest: "database-erasure",
    });
    const reserved = await accountDeletionRequestsRepository.reservePersonalAccountDeletion(input);
    if (reserved.outcome !== "reserved") throw new Error("reservation failed");
    await dbWrite.execute(`
      INSERT INTO agent_sandbox_replacement_attempts (id, organization_id)
      VALUES ('71000000-0000-4000-8000-000000000001', '${organizationId}')
    `);

    const exportLease = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "export",
      leaseOwnerDigest: "export-worker",
      now,
      leaseMilliseconds: 60_000,
    });
    if (!exportLease) throw new Error("export lease failed");
    await accountDeletionRequestsRepository.markExportBuilding({
      requestId: reserved.request.id,
      phaseReceiptId: exportLease.receipt.id,
      generation: exportLease.generation,
      now,
    });
    await accountDeletionRequestsRepository.markPhaseProviderCallStarted(
      exportLease.receipt.id,
      exportLease.generation,
      now,
    );
    expect(
      await accountDeletionRequestsRepository.completeExportPhase({
        requestId: reserved.request.id,
        phaseReceiptId: exportLease.receipt.id,
        generation: exportLease.generation,
        contentDigest: "content-digest",
        objectReceiptDigest: "object-receipt",
        byteCount: 123,
        now,
      }),
    ).toBe(true);
    const stewardLease = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "steward_deactivation",
      leaseOwnerDigest: "steward-worker",
      now,
      leaseMilliseconds: 60_000,
    });
    if (!stewardLease) throw new Error("Steward lease failed");
    expect(
      await accountDeletionRequestsRepository.completeStewardDeactivationPhase({
        requestId: reserved.request.id,
        phaseReceiptId: stewardLease.receipt.id,
        generation: stewardLease.generation,
        providerReceiptDigest: "steward-receipt",
        now,
      }),
    ).toBe(true);
    const irreversibleAt = new Date(recoveryExpiresAt.getTime() + 1);
    expect(
      await accountDeletionRequestsRepository.activateExpiredPersonalAccountDeletion({
        requestId: reserved.request.id,
        exportRevocationIdempotencyKeyDigest: "export-revoke",
        exportRevocationNotBefore: irreversibleAt,
        now: irreversibleAt,
      }),
    ).toMatchObject({ outcome: "activated" });
    const revokeLease = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "export_revoke",
      leaseOwnerDigest: "revoke-worker",
      now: irreversibleAt,
      leaseMilliseconds: 60_000,
    });
    if (!revokeLease) throw new Error("export revocation lease failed");
    expect(
      await accountDeletionRequestsRepository.completeExportRevocation({
        requestId: reserved.request.id,
        phaseReceiptId: revokeLease.receipt.id,
        generation: revokeLease.generation,
        providerReceiptDigest: "export-revoked",
        now: irreversibleAt,
      }),
    ).toBe(true);
    const databaseLease = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "database_erasure",
      leaseOwnerDigest: "database-worker",
      now: irreversibleAt,
      leaseMilliseconds: 60_000,
    });
    if (!databaseLease) throw new Error("database erasure lease failed");
    const finalized = await accountDeletionRequestsRepository.finalizePersonalAccountDeletion({
      requestId: reserved.request.id,
      phaseReceiptId: databaseLease.receipt.id,
      generation: databaseLease.generation,
      completionReceiptDigest: "f".repeat(64),
      now: irreversibleAt,
    });
    expect(finalized).toMatchObject({ outcome: "completed" });
    expect(await dbWrite.select().from(organizations)).toHaveLength(0);
    expect(await dbWrite.select().from(users)).toHaveLength(0);
    expect(await dbWrite.select().from(accountDeletionPhaseReceipts)).toHaveLength(0);
    expect(await dbWrite.select().from(accountDeletionExports)).toHaveLength(0);
    const replacementAttempts = await dbWrite.execute(
      "SELECT id FROM agent_sandbox_replacement_attempts",
    );
    expect(replacementAttempts.rows).toHaveLength(0);
    const [receipt] = await dbWrite.select().from(accountDeletionRequests);
    expect(receipt).toMatchObject({
      status: "completed",
      user_id: null,
      organization_id: null,
      steward_user_id: null,
      completion_receipt_digest: "f".repeat(64),
      status_token_hash: "status-erase",
    });
  });

  test("rolls back identifier nulling when a restrictive foreign key survives purge", async () => {
    const input = reservationInput("50000000-0000-4000-8000-000000000010", "blocked");
    input.phases = [
      {
        phase: "account_authority",
        phaseOrder: 0,
        idempotencyKeyDigest: "authority-blocked",
        completed: true,
      },
      {
        phase: "database_erasure",
        phaseOrder: 130,
        idempotencyKeyDigest: "database-blocked",
      },
    ];
    const reserved = await accountDeletionRequestsRepository.reservePersonalAccountDeletion(input);
    if (reserved.outcome !== "reserved") throw new Error("reservation failed");
    await dbWrite.execute(`
      INSERT INTO account_deletion_restrictive_fixture (id, organization_id)
      VALUES ('70000000-0000-4000-8000-000000000001', '${organizationId}')
    `);
    await dbWrite
      .update(organizations)
      .set({ account_lifecycle_state: "deletion_irreversible", account_lifecycle_revision: 2 });
    await dbWrite
      .update(users)
      .set({ account_lifecycle_state: "deletion_irreversible", account_lifecycle_revision: 2 });
    await dbWrite.update(accountDeletionRequests).set({
      status: "scheduled",
      lifecycle_revision: 2,
      irreversible_at: recoveryExpiresAt,
    });
    const databaseLease = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "database_erasure",
      leaseOwnerDigest: "database-worker",
      now: recoveryExpiresAt,
      leaseMilliseconds: 60_000,
    });
    if (!databaseLease) throw new Error("database erasure lease failed");

    await expect(
      accountDeletionRequestsRepository.finalizePersonalAccountDeletion({
        requestId: reserved.request.id,
        phaseReceiptId: databaseLease.receipt.id,
        generation: databaseLease.generation,
        completionReceiptDigest: "e".repeat(64),
        now: recoveryExpiresAt,
      }),
    ).rejects.toThrow();
    const [request] = await dbWrite.select().from(accountDeletionRequests);
    expect(request).toMatchObject({
      status: "scheduled",
      user_id: userId,
      organization_id: organizationId,
      completion_receipt_digest: null,
    });
    expect(await dbWrite.select().from(organizations)).toHaveLength(1);
  });
});
