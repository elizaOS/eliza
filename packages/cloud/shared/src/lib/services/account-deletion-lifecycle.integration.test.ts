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
import type { RuntimeR2Bucket } from "../storage/r2-runtime-binding";
import { processDueAccountDeletions, requestAccountDeletion } from "./account-deletion";

const PGLITE_TIMEOUT = 60_000;
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const STEWARD_USER_ID = "steward-user";
const SHARED_ORGANIZATION_ID = "44444444-4444-4444-8444-444444444444";
const SHARED_USER_ID = "55555555-5555-4555-8555-555555555555";
const SHARED_OWNER_ID = "66666666-6666-4666-8666-666666666666";
const SHARED_STEWARD_USER_ID = "steward-shared-member";
const TEST_DATABASE = resolveAccountDeletionTestDatabase();
let databaseReady = true;
const requestIds: string[] = [];

const blob: RuntimeR2Bucket = {
  get: mock(async () => null),
  put: mock(async () => undefined),
  delete: mock(async () => undefined),
};

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
  }
  await closeDatabaseConnectionsForTests();
});

describe("account deletion end-to-end lifecycle", () => {
  test("deactivates immediately, purges when due, and retains only an identifier-free receipt", async () => {
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

    const requestedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    const deactivateStewardUser = mock(async () => ({ userId: STEWARD_USER_ID }));
    const request = await requestAccountDeletion(
      {
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        stewardUserId: STEWARD_USER_ID,
        now: requestedAt,
      },
      {
        deactivateStewardUser,
        updateUser: (userId, data) => usersRepository.update(userId, data),
        deactivateApiKeys: mock(async () => undefined),
        endUserSessions: mock(async () => undefined),
        updateOrganization: (organizationId, data) =>
          organizationsRepository.update(organizationId, data),
      },
    );
    requestIds.push(request.id);

    expect(request.status).toBe("scheduled");
    expect((await usersRepository.findByIdForWrite(USER_ID))?.is_active).toBe(false);
    expect((await organizationsRepository.findById(ORGANIZATION_ID))?.is_active).toBe(false);

    const purgeOrganizationResources = mock(async () => undefined);
    const deleteStewardUser = mock(async () => ({ userId: STEWARD_USER_ID }));
    const result = await processDueAccountDeletions(10, {
      blob,
      purgeOrganizationResources,
      deleteStewardUser,
      listOrganizationMembers: (organizationId) =>
        usersRepository.listByOrganization(organizationId),
      findUserForWrite: (userId) => usersRepository.findByIdForWrite(userId),
      deletePersonalAccount: (userId, organizationId) =>
        usersRepository.deletePersonalOrganizationAtomically(userId, organizationId),
    });

    expect(result).toEqual({ recovered: 0, processed: 1, completed: 1, actionRequired: 0 });
    expect(purgeOrganizationResources).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      blob,
    });
    expect(deleteStewardUser).toHaveBeenCalledWith(STEWARD_USER_ID);
    expect(await usersRepository.findByIdForWrite(USER_ID)).toBeUndefined();
    expect(await organizationsRepository.findById(ORGANIZATION_ID)).toBeUndefined();

    const [receipt] = await dbWrite
      .select()
      .from(accountDeletionRequests)
      .where(eq(accountDeletionRequests.id, request.id));
    expect(receipt).toMatchObject({
      status: "completed",
      user_id: null,
      organization_id: null,
      steward_user_id: null,
      last_error_code: null,
    });
    expect(receipt?.completed_at).toBeInstanceOf(Date);
    expect(await accountDeletionRequestsRepository.findOpenByUserId(USER_ID)).toBeUndefined();
  });

  test("deletes only the requester from a shared organization", async () => {
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

    const requestedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    const request = await requestAccountDeletion(
      {
        userId: SHARED_USER_ID,
        organizationId: SHARED_ORGANIZATION_ID,
        stewardUserId: SHARED_STEWARD_USER_ID,
        now: requestedAt,
      },
      {
        deactivateStewardUser: mock(async () => ({ userId: SHARED_STEWARD_USER_ID })),
        updateUser: (userId, data) => usersRepository.update(userId, data),
        deactivateApiKeys: mock(async () => undefined),
        endUserSessions: mock(async () => undefined),
        updateOrganization: (organizationId, data) =>
          organizationsRepository.update(organizationId, data),
      },
    );
    requestIds.push(request.id);

    expect((await organizationsRepository.findById(SHARED_ORGANIZATION_ID))?.is_active).toBe(true);
    const purgeOrganizationResources = mock(async () => undefined);
    const result = await processDueAccountDeletions(10, {
      blob,
      purgeOrganizationResources,
      deleteStewardUser: mock(async () => ({ userId: SHARED_STEWARD_USER_ID })),
      listOrganizationMembers: (organizationId) =>
        usersRepository.listByOrganization(organizationId),
      findUserForWrite: (userId) => usersRepository.findByIdForWrite(userId),
      deleteSharedOrganizationUser: (userId) => usersRepository.delete(userId),
    });

    expect(result).toEqual({ recovered: 0, processed: 1, completed: 1, actionRequired: 0 });
    expect(purgeOrganizationResources).not.toHaveBeenCalled();
    expect(await usersRepository.findByIdForWrite(SHARED_USER_ID)).toBeUndefined();
    expect(await usersRepository.findByIdForWrite(SHARED_OWNER_ID)).toMatchObject({
      id: SHARED_OWNER_ID,
      is_active: true,
    });
    expect(await organizationsRepository.findById(SHARED_ORGANIZATION_ID)).toMatchObject({
      id: SHARED_ORGANIZATION_ID,
      is_active: true,
    });
  });
});
