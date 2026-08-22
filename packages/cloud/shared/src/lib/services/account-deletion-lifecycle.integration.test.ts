/** Runs deletion reservation and shared-owner rejection on isolated PostgreSQL. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { resolveAccountDeletionTestDatabase } from "../../db/account-deletion-test-database";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { accountDeletionExports } from "../../db/schemas/account-deletion-exports";
import { accountDeletionPhaseReceipts } from "../../db/schemas/account-deletion-phase-receipts";
import { accountDeletionRequests } from "../../db/schemas/account-deletion-requests";
import { apiKeys } from "../../db/schemas/api-keys";
import { organizationBalanceRevisionSequence, organizations } from "../../db/schemas/organizations";
import { userSessions } from "../../db/schemas/user-sessions";
import { users } from "../../db/schemas/users";
import { getAccountDeletionStatusByCredential, requestAccountDeletion } from "./account-deletion";

const PERSONAL_ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const PERSONAL_USER_ID = "22222222-2222-4222-8222-222222222222";
const SHARED_ORGANIZATION_ID = "44444444-4444-4444-8444-444444444444";
const SHARED_USER_ID = "55555555-5555-4555-8555-555555555555";
const SHARED_OWNER_ID = "66666666-6666-4666-8666-666666666666";
const TEST_DATABASE = resolveAccountDeletionTestDatabase();
let databaseReady = true;

beforeAll(async () => {
  if (!TEST_DATABASE) {
    databaseReady = false;
    return;
  }
  if (TEST_DATABASE === "pglite") {
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
  }
});

afterAll(async () => {
  if (databaseReady) {
    await dbWrite.delete(accountDeletionRequests);
    await dbWrite.delete(organizations);
  }
  await closeDatabaseConnectionsForTests();
});

describe("account deletion reservation lifecycle", () => {
  test("fences a personal account and keeps status available after session revocation", async () => {
    expect(databaseReady).toBe(true);
    await dbWrite.insert(organizations).values({
      id: PERSONAL_ORGANIZATION_ID,
      name: "Personal account",
      slug: "personal-account-deletion",
      auto_top_up_enabled: true,
    });
    await dbWrite.insert(users).values({
      id: PERSONAL_USER_ID,
      organization_id: PERSONAL_ORGANIZATION_ID,
      steward_user_id: "steward-personal",
      role: "owner",
    });
    await dbWrite.insert(apiKeys).values({
      name: "personal-key",
      key_hash: "personal-key-hash",
      key_prefix: "eliza_personal",
      organization_id: PERSONAL_ORGANIZATION_ID,
      user_id: PERSONAL_USER_ID,
    });
    await dbWrite.insert(userSessions).values({
      user_id: PERSONAL_USER_ID,
      organization_id: PERSONAL_ORGANIZATION_ID,
      session_token: "personal-session",
    });

    const accepted = await requestAccountDeletion({
      userId: PERSONAL_USER_ID,
      organizationId: PERSONAL_ORGANIZATION_ID,
      stewardUserId: "steward-personal",
      now: new Date("2026-08-22T12:00:00Z"),
    });
    expect(accepted.request).toMatchObject({
      status: "reserved",
      canCancel: true,
    });

    const [user] = await dbWrite.select().from(users).where(eq(users.id, PERSONAL_USER_ID));
    const [organization] = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, PERSONAL_ORGANIZATION_ID));
    const [key] = await dbWrite.select().from(apiKeys).where(eq(apiKeys.user_id, PERSONAL_USER_ID));
    const [session] = await dbWrite
      .select()
      .from(userSessions)
      .where(eq(userSessions.user_id, PERSONAL_USER_ID));
    expect(user).toMatchObject({
      is_active: false,
      account_lifecycle_state: "deletion_recovery",
    });
    expect(organization).toMatchObject({
      is_active: false,
      auto_top_up_enabled: false,
      account_lifecycle_state: "deletion_recovery",
    });
    expect(key?.is_active).toBe(false);
    expect(session?.ended_at).not.toBeNull();

    const status = await getAccountDeletionStatusByCredential(accepted.statusCredential);
    expect(status).toMatchObject({
      requestId: accepted.request.requestId,
      status: "reserved",
      export: { status: "pending" },
    });
  });

  test("requires explicit successor transfer for a shared member without fencing the tenant", async () => {
    await dbWrite.insert(organizations).values({
      id: SHARED_ORGANIZATION_ID,
      name: "Shared organization",
      slug: "shared-account-deletion",
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
        steward_user_id: "steward-shared-member",
        role: "member",
      },
    ]);

    await expect(
      requestAccountDeletion({
        userId: SHARED_USER_ID,
        organizationId: SHARED_ORGANIZATION_ID,
        stewardUserId: "steward-shared-member",
      }),
    ).rejects.toMatchObject({
      code: "TRANSFER_REQUIRED",
      details: { successorOwnerRequired: true, activeOwnerCount: 1 },
    });
    const [organization] = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, SHARED_ORGANIZATION_ID));
    expect(organization).toMatchObject({
      is_active: true,
      account_lifecycle_state: "active",
    });
  });
});
