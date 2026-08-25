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
import {
  activateAccountDeletion,
  getAccountDeletionStatusByCredential,
  requestAccountDeletion,
} from "./account-deletion";

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
  test("reserves before fencing, then keeps status available after activation revokes sessions", async () => {
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
      admissionCredential: "p".repeat(43),
      now: new Date("2026-08-22T12:00:00Z"),
    });
    expect(accepted.request).toMatchObject({
      status: "pending_activation",
      accessState: "active",
      canCancel: false,
      nextAction: "confirm_recovery_package",
    });

    const [reservedUser] = await dbWrite.select().from(users).where(eq(users.id, PERSONAL_USER_ID));
    const [reservedOrganization] = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, PERSONAL_ORGANIZATION_ID));
    const [reservedKey] = await dbWrite
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.user_id, PERSONAL_USER_ID));
    const [reservedSession] = await dbWrite
      .select()
      .from(userSessions)
      .where(eq(userSessions.user_id, PERSONAL_USER_ID));
    expect(reservedUser).toMatchObject({
      is_active: true,
      account_lifecycle_state: "active",
    });
    expect(reservedOrganization).toMatchObject({
      is_active: true,
      auto_top_up_enabled: true,
      account_lifecycle_state: "active",
    });
    expect(reservedKey?.is_active).toBe(true);
    expect(reservedSession?.ended_at).toBeNull();

    await expect(
      activateAccountDeletion(accepted.recoveryCredential, new Date("2026-08-22T12:00:00Z")),
    ).resolves.toMatchObject({ status: "reserved", accessState: "fenced" });

    const [activatedUser] = await dbWrite
      .select()
      .from(users)
      .where(eq(users.id, PERSONAL_USER_ID));
    const [activatedOrganization] = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, PERSONAL_ORGANIZATION_ID));
    const [activatedKey] = await dbWrite
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.user_id, PERSONAL_USER_ID));
    const [activatedSession] = await dbWrite
      .select()
      .from(userSessions)
      .where(eq(userSessions.user_id, PERSONAL_USER_ID));
    expect(activatedUser).toMatchObject({
      is_active: false,
      account_lifecycle_state: "deletion_recovery",
    });
    expect(activatedOrganization).toMatchObject({
      is_active: false,
      auto_top_up_enabled: false,
      account_lifecycle_state: "deletion_recovery",
    });
    expect(activatedKey?.is_active).toBe(false);
    expect(activatedSession?.ended_at).not.toBeNull();

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
        admissionCredential: "s".repeat(43),
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
