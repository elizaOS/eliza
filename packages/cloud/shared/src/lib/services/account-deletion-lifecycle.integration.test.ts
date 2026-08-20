/** Runs the complete account-deletion service lifecycle on real isolated PGlite. */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
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
let pgliteReady = true;

const blob: RuntimeR2Bucket = {
  get: mock(async () => null),
  put: mock(async () => undefined),
  delete: mock(async () => undefined),
};

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[account-deletion-lifecycle.integration.test] isolated PGlite is required; refusing to mutate an ambient Postgres database.",
    );
    return;
  }

  try {
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
  } catch (error) {
    // error-policy:J1 The test boundary records schema setup failure and the case fails loudly.
    pgliteReady = false;
    console.error("[account-deletion-lifecycle.integration.test] PGlite setup failed.", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("account deletion end-to-end lifecycle", () => {
  test("deactivates immediately, purges when due, and retains only an identifier-free receipt", async () => {
    expect(pgliteReady).toBe(true);
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
});
