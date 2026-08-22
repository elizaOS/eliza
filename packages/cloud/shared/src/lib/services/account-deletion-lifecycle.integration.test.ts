/** Runs the complete account-deletion lifecycle on isolated PGlite or loopback PostgreSQL. */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { resolveAccountDeletionTestDatabase } from "../../db/account-deletion-test-database";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { accountDeletionRequestsRepository } from "../../db/repositories/account-deletion-requests";
import { organizationsRepository } from "../../db/repositories/organizations";
import { usersRepository } from "../../db/repositories/users";
import { accountDeletionRequests } from "../../db/schemas/account-deletion-requests";
import { organizationBalanceRevisionSequence, organizations } from "../../db/schemas/organizations";
import { userIdentities } from "../../db/schemas/user-identities";
import { users } from "../../db/schemas/users";
import { getAccountDeletionStatus, requestAccountDeletion } from "./account-deletion";

const PGLITE_TIMEOUT = 60_000;
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const STEWARD_USER_ID = "steward-user";
const SHARED_ORGANIZATION_ID = "44444444-4444-4444-8444-444444444444";
const SHARED_USER_ID = "55555555-5555-4555-8555-555555555555";
const SHARED_OWNER_ID = "66666666-6666-4666-8666-666666666666";
const SHARED_STEWARD_USER_ID = "steward-shared-member";
const ADVERSARIAL_ORGANIZATION_ID = "77777777-7777-4777-8777-777777777777";
const ADVERSARIAL_USER_ID = "88888888-8888-4888-8888-888888888888";
const MISMATCHED_RECEIPT_ORGANIZATION_ID = "99999999-9999-4999-8999-999999999999";
const TEST_DATABASE = resolveAccountDeletionTestDatabase();
let databaseReady = true;
const requestIds: string[] = [];

beforeAll(async () => {
  if (!TEST_DATABASE) {
    databaseReady = false;
    console.warn(
      "[account-deletion-lifecycle.integration.test] refusing to mutate an unapproved database target.",
    );
    return;
  }

  try {
    if (TEST_DATABASE === "pglite") {
      const { apply } = await pushSchema(
        {
          accountDeletionRequests,
          organizationBalanceRevisionSequence,
          organizations,
          users,
          userIdentities,
        } as never,
        dbWrite as never,
      );
      await apply();
    } else {
      await dbWrite.execute(sql`
        UPDATE auto_top_up_control
        SET mode = 'durable', legacy_reconciled_through = paused_at
        WHERE singleton = true
      `);
    }
  } catch (error) {
    // error-policy:J1 The test boundary records schema setup failure and the case fails loudly.
    databaseReady = false;
    console.error("[account-deletion-lifecycle.integration.test] database setup failed.", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (databaseReady) {
    for (const requestId of requestIds) {
      await dbWrite
        .delete(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, requestId));
    }
    await dbWrite.delete(organizations).where(eq(organizations.id, SHARED_ORGANIZATION_ID));
    await dbWrite.delete(organizations).where(eq(organizations.id, ADVERSARIAL_ORGANIZATION_ID));
  }
  await closeDatabaseConnectionsForTests();
});

describe("account deletion end-to-end lifecycle", () => {
  test("fences stale claim generations before any irreversible deletion", async () => {
    expect(databaseReady).toBe(true);
    await dbWrite.insert(organizations).values({
      id: ORGANIZATION_ID,
      name: "Personal account",
      slug: "personal-account",
    });
    await dbWrite.insert(users).values({
      id: USER_ID,
      organization_id: ORGANIZATION_ID,
      steward_user_id: STEWARD_USER_ID,
      email: "person@example.com",
      name: "Person",
    });
    await dbWrite.insert(userIdentities).values({
      user_id: USER_ID,
      steward_user_id: STEWARD_USER_ID,
    });

    expect(
      await getAccountDeletionStatus({ userId: USER_ID, organizationId: ORGANIZATION_ID }),
    ).toEqual({
      state: "lifecycle_unavailable",
      request: null,
      code: "LIFECYCLE_RESERVATION_REQUIRED",
      message:
        "Permanent account deletion is unavailable until lifecycle recovery and provider reconciliation are reserved",
    });
    expect(await accountDeletionRequestsRepository.findOpenByUserId(USER_ID, true)).toBeUndefined();

    const requestedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    await expect(
      requestAccountDeletion({
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        stewardUserId: STEWARD_USER_ID,
        now: requestedAt,
      }),
    ).rejects.toMatchObject({ code: "LIFECYCLE_RESERVATION_REQUIRED" });
    expect(await usersRepository.findByIdForWrite(USER_ID)).toMatchObject({ is_active: true });
    expect(await organizationsRepository.findById(ORGANIZATION_ID)).toMatchObject({
      is_active: true,
    });

    const request = await accountDeletionRequestsRepository.createIdempotent({
      user_id: USER_ID,
      organization_id: ORGANIZATION_ID,
      steward_user_id: STEWARD_USER_ID,
      status: "scheduled",
      requested_at: requestedAt,
      execute_after: new Date(requestedAt.getTime() + 30 * 24 * 60 * 60 * 1_000),
    });
    requestIds.push(request.id);

    expect(request.status).toBe("scheduled");
    expect(
      await getAccountDeletionStatus({ userId: USER_ID, organizationId: ORGANIZATION_ID }),
    ).toMatchObject({
      state: "existing_request",
      request: { requestId: request.id, status: "scheduled" },
    });

    const purgeOrganizationResources = mock(async () => undefined);
    const t1ClaimedAt = new Date(request.execute_after.getTime() + 1_000);
    const [t1] = await accountDeletionRequestsRepository.claimDue(1, t1ClaimedAt);
    expect(t1?.processing_started_at).toEqual(t1ClaimedAt);

    expect(
      await accountDeletionRequestsRepository.recoverStaleProcessing(
        new Date(t1ClaimedAt.getTime() + 1),
      ),
    ).toBe(1);
    const t2ClaimedAt = new Date(t1ClaimedAt.getTime() + 2_000);
    const [t2] = await accountDeletionRequestsRepository.claimDue(1, t2ClaimedAt);
    expect(t2?.processing_started_at).toEqual(t2ClaimedAt);

    expect(
      await accountDeletionRequestsRepository.markActionRequired(
        request.id,
        t1ClaimedAt,
        "STALE_T1_MUST_NOT_WIN",
      ),
    ).toBe(false);
    expect(
      await accountDeletionRequestsRepository.recordPurgeFailure(
        request.id,
        t1ClaimedAt,
        "STALE_T1_FAILURE_MUST_NOT_WIN",
      ),
    ).toBeUndefined();

    const [ownedByT2] = await dbWrite
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, request.id));
    expect(ownedByT2).toMatchObject({
      status: "processing",
      processing_started_at: t2ClaimedAt,
      last_error_code: null,
      attempts: 0,
    });
    expect(purgeOrganizationResources).not.toHaveBeenCalled();

    expect(
      await accountDeletionRequestsRepository.markActionRequired(
        request.id,
        t2ClaimedAt,
        "LIFECYCLE_RESERVATION_REQUIRED",
      ),
    ).toBe(true);
    expect(await usersRepository.findByIdForWrite(USER_ID)).toMatchObject({
      id: USER_ID,
      is_active: true,
    });
    expect(await organizationsRepository.findById(ORGANIZATION_ID)).toMatchObject({
      id: ORGANIZATION_ID,
      is_active: true,
    });

    const [receipt] = await dbWrite
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, request.id));
    expect(receipt).toMatchObject({
      status: "action_required",
      processing_started_at: null,
      user_id: USER_ID,
      organization_id: ORGANIZATION_ID,
      steward_user_id: STEWARD_USER_ID,
      last_error_code: "LIFECYCLE_RESERVATION_REQUIRED",
      attempts: 0,
    });
    expect(receipt?.completed_at).toBeNull();
  });

  test("rejects a shared member before deleting its identity or organization", async () => {
    await dbWrite.insert(organizations).values({
      id: SHARED_ORGANIZATION_ID,
      name: "Shared organization",
      slug: "shared-account-deletion-org",
    });
    await dbWrite.insert(users).values([
      {
        id: SHARED_OWNER_ID,
        organization_id: SHARED_ORGANIZATION_ID,
        steward_user_id: "steward-shared-owner",
        role: "owner",
      },
      {
        id: SHARED_USER_ID,
        organization_id: SHARED_ORGANIZATION_ID,
        steward_user_id: SHARED_STEWARD_USER_ID,
        role: "member",
      },
    ]);
    await dbWrite.insert(userIdentities).values([
      { user_id: SHARED_OWNER_ID, steward_user_id: "steward-shared-owner" },
      { user_id: SHARED_USER_ID, steward_user_id: SHARED_STEWARD_USER_ID },
    ]);

    expect(
      await getAccountDeletionStatus({
        userId: SHARED_USER_ID,
        organizationId: SHARED_ORGANIZATION_ID,
      }),
    ).toEqual({
      state: "transfer_required",
      request: null,
      code: "TRANSFER_REQUIRED",
      message: "Transfer or revoke shared organization resources before deleting this account",
    });
    expect(await accountDeletionRequestsRepository.findOpenByUserId(SHARED_USER_ID, true)).toBe(
      undefined,
    );

    await expect(
      requestAccountDeletion({
        userId: SHARED_USER_ID,
        organizationId: SHARED_ORGANIZATION_ID,
        stewardUserId: SHARED_STEWARD_USER_ID,
      }),
    ).rejects.toMatchObject({ code: "TRANSFER_REQUIRED" });

    expect((await organizationsRepository.findById(SHARED_ORGANIZATION_ID))?.is_active).toBe(true);
    expect(await usersRepository.findByIdForWrite(SHARED_USER_ID)).toMatchObject({
      id: SHARED_USER_ID,
      is_active: true,
    });
    expect(await usersRepository.findByIdForWrite(SHARED_OWNER_ID)).toMatchObject({
      id: SHARED_OWNER_ID,
      is_active: true,
    });
    expect(await organizationsRepository.findById(SHARED_ORGANIZATION_ID)).toMatchObject({
      id: SHARED_ORGANIZATION_ID,
      is_active: true,
    });
    expect(await accountDeletionRequestsRepository.findOpenByUserId(SHARED_USER_ID, true)).toBe(
      undefined,
    );
  });

  test("never admits a stale cross-organization receipt or an unavailable current account", async () => {
    await dbWrite.insert(organizations).values({
      id: ADVERSARIAL_ORGANIZATION_ID,
      name: "Adversarial account",
      slug: "account-deletion-adversarial-org",
    });
    await dbWrite.insert(users).values({
      id: ADVERSARIAL_USER_ID,
      organization_id: ADVERSARIAL_ORGANIZATION_ID,
      steward_user_id: "steward-adversarial-user",
      role: "owner",
    });

    const staleReceipt = await accountDeletionRequestsRepository.createIdempotent({
      user_id: ADVERSARIAL_USER_ID,
      organization_id: MISMATCHED_RECEIPT_ORGANIZATION_ID,
      steward_user_id: "steward-adversarial-user",
      status: "scheduled",
      requested_at: new Date("2026-08-01T00:00:00Z"),
      execute_after: new Date("2026-08-31T00:00:00Z"),
    });
    requestIds.push(staleReceipt.id);

    expect(
      await getAccountDeletionStatus({
        userId: ADVERSARIAL_USER_ID,
        organizationId: ADVERSARIAL_ORGANIZATION_ID,
      }),
    ).toMatchObject({ state: "lifecycle_unavailable", request: null });
    await expect(
      requestAccountDeletion({
        userId: ADVERSARIAL_USER_ID,
        organizationId: ADVERSARIAL_ORGANIZATION_ID,
        stewardUserId: "steward-adversarial-user",
      }),
    ).rejects.toMatchObject({ code: "LIFECYCLE_RESERVATION_REQUIRED" });
    await expect(
      accountDeletionRequestsRepository.createIdempotent({
        user_id: ADVERSARIAL_USER_ID,
        organization_id: ADVERSARIAL_ORGANIZATION_ID,
        steward_user_id: "steward-adversarial-user",
        status: "scheduled",
        execute_after: new Date("2026-09-30T00:00:00Z"),
      }),
    ).rejects.toThrow("conflicted but no open request was found");

    for (const state of [
      { name: "inactive", values: { is_active: false, deleted_at: null, is_anonymous: false } },
      {
        name: "deleted",
        values: {
          is_active: true,
          deleted_at: new Date("2026-08-21T00:00:00Z"),
          is_anonymous: false,
        },
      },
      { name: "anonymous", values: { is_active: true, deleted_at: null, is_anonymous: true } },
    ] as const) {
      await dbWrite.update(users).set(state.values).where(eq(users.id, ADVERSARIAL_USER_ID));
      const expectedCode = state.name === "anonymous" ? "ANONYMOUS_ACCOUNT" : "ACCOUNT_UNAVAILABLE";

      await expect(
        getAccountDeletionStatus({
          userId: ADVERSARIAL_USER_ID,
          organizationId: ADVERSARIAL_ORGANIZATION_ID,
        }),
      ).rejects.toMatchObject({ code: expectedCode });
      await expect(
        requestAccountDeletion({
          userId: ADVERSARIAL_USER_ID,
          organizationId: ADVERSARIAL_ORGANIZATION_ID,
          stewardUserId: "steward-adversarial-user",
        }),
      ).rejects.toMatchObject({ code: expectedCode });
    }

    expect(
      await accountDeletionRequestsRepository.findOpenByUserAndOrganizationId(
        ADVERSARIAL_USER_ID,
        ADVERSARIAL_ORGANIZATION_ID,
        true,
      ),
    ).toBeUndefined();
    expect(
      await accountDeletionRequestsRepository.findOpenByUserId(ADVERSARIAL_USER_ID, true),
    ).toMatchObject({ id: staleReceipt.id, organization_id: MISMATCHED_RECEIPT_ORGANIZATION_ID });
  });
});
