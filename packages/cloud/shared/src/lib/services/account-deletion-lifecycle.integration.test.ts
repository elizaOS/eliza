/** Runs deletion reservation and shared-owner rejection on isolated PostgreSQL. */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { resolveAccountDeletionTestDatabase } from "../../db/account-deletion-test-database";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import * as dbHelpers from "../../db/helpers";
import { accountDeletionExports } from "../../db/schemas/account-deletion-exports";
import { accountDeletionPhaseReceipts } from "../../db/schemas/account-deletion-phase-receipts";
import { accountDeletionRequests } from "../../db/schemas/account-deletion-requests";
import { apiKeys } from "../../db/schemas/api-keys";
import { nativeAppPublishers } from "../../db/schemas/native-app-publishers";
import { organizationBalanceRevisionSequence, organizations } from "../../db/schemas/organizations";
import { providerAdmissions } from "../../db/schemas/provider-admissions";
import { userSessions } from "../../db/schemas/user-sessions";
import { users } from "../../db/schemas/users";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";
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
const REPLAY_ORGANIZATION_ID = "77777777-7777-4777-8777-777777777777";
const REPLAY_USER_ID = "88888888-8888-4888-8888-888888888888";
const TEST_DATABASE = resolveAccountDeletionTestDatabase();
const originalWriteTransaction = dbHelpers.writeTransaction;
let databaseReady = true;

/**
 * A gate that records each mutation path and `active` value, and refuses while
 * `available` is false or `refuse` matches the mutation.
 */
function recordingGate() {
  const gate = {
    available: true,
    refuse: (_path: string, _active: unknown) => false,
    paths: [] as string[],
    mutations: [] as string[],
    run: <T>(fn: () => Promise<T>) =>
      runWithCloudBindingsAsync(
        {
          VOICE_SPEECH_RELAY_ENABLED: "true",
          INFERENCE_ADMISSION_GATES: {
            getByName: () => ({
              async fetch(request: Request) {
                const path = new URL(request.url).pathname;
                const body = (await request.json()) as { active?: unknown };
                gate.paths.push(path);
                gate.mutations.push(`${path}=${String(body.active)}`);
                const committed = gate.available && !gate.refuse(path, body.active);
                return Response.json({ committed }, { status: committed ? 200 : 503 });
              },
            }),
          },
        },
        fn,
      ),
  };
  return gate;
}

const GATE_FENCED = ["/organization/set-active=false", "/subject/set-active=false"];
const GATE_REOPENED = ["/subject/set-active=true", "/organization/set-active=true"];

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
        nativeAppPublishers,
        providerAdmissions,
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

  test("activation reaches the gate only after its writes, and a rollback can be replayed", async () => {
    await dbWrite.insert(organizations).values({
      id: REPLAY_ORGANIZATION_ID,
      name: "Replayed activation",
      slug: "replayed-account-deletion",
    });
    await dbWrite.insert(users).values({
      id: REPLAY_USER_ID,
      organization_id: REPLAY_ORGANIZATION_ID,
      steward_user_id: "steward-replay",
      role: "owner",
    });
    const accepted = await requestAccountDeletion({
      userId: REPLAY_USER_ID,
      organizationId: REPLAY_ORGANIZATION_ID,
      stewardUserId: "steward-replay",
      admissionCredential: "r".repeat(43),
      now: new Date("2026-08-22T12:00:00Z"),
    });
    const activate = () =>
      activateAccountDeletion(accepted.recoveryCredential, new Date("2026-08-22T12:00:00Z"));
    const expectAccountStillActive = async () => {
      const [user] = await dbWrite.select().from(users).where(eq(users.id, REPLAY_USER_ID));
      const [organization] = await dbWrite
        .select()
        .from(organizations)
        .where(eq(organizations.id, REPLAY_ORGANIZATION_ID));
      expect(user?.is_active).toBe(true);
      expect(organization?.is_active).toBe(true);
    };
    const gate = recordingGate();

    // A rolled-back request stays "requested", which cancellation refuses, so a
    // failed write must leave the gate untouched.
    await dbWrite.execute(sql`
      CREATE FUNCTION refuse_deletion_request_update() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'deletion request write refused'; END;
      $$ LANGUAGE plpgsql
    `);
    await dbWrite.execute(sql`
      CREATE TRIGGER refuse_deletion_request_trigger BEFORE UPDATE ON account_deletion_requests
      FOR EACH ROW EXECUTE FUNCTION refuse_deletion_request_update()
    `);
    try {
      await expect(gate.run(activate)).rejects.toThrow();
    } finally {
      await dbWrite.execute(
        sql`DROP TRIGGER refuse_deletion_request_trigger ON account_deletion_requests`,
      );
      await dbWrite.execute(sql`DROP FUNCTION refuse_deletion_request_update()`);
    }
    expect(gate.paths).toEqual([]);
    await expectAccountStillActive();

    gate.available = false;
    await expect(gate.run(activate)).rejects.toMatchObject({
      code: "INFERENCE_CREDENTIAL_REVOCATION_UNAVAILABLE",
    });
    await expectAccountStillActive();

    gate.available = true;
    gate.paths = [];
    await expect(gate.run(activate)).resolves.toMatchObject({
      status: "reserved",
      accessState: "fenced",
    });
    expect(gate.paths).toEqual(["/organization/set-active", "/subject/set-active"]);
  });

  test("reopens the gate when activation rolls back after fencing it", async () => {
    const organizationId = "99999999-9999-4999-8999-999999999991";
    const userId = "99999999-9999-4999-8999-999999999992";
    await dbWrite.insert(organizations).values({
      id: organizationId,
      name: "Compensated activation",
      slug: "compensated-account-deletion",
    });
    await dbWrite.insert(users).values({
      id: userId,
      organization_id: organizationId,
      steward_user_id: "steward-compensated",
      role: "owner",
    });
    const accepted = await requestAccountDeletion({
      userId,
      organizationId,
      stewardUserId: "steward-compensated",
      admissionCredential: "c".repeat(43),
      now: new Date("2026-08-22T12:00:00Z"),
    });
    const activate = () =>
      activateAccountDeletion(accepted.recoveryCredential, new Date("2026-08-22T12:00:00Z"));
    const readStatus = async () => {
      const [request] = await dbWrite
        .select({ status: accountDeletionRequests.status })
        .from(accountDeletionRequests)
        .where(eq(accountDeletionRequests.organization_id, organizationId));
      return request?.status;
    };
    const gate = recordingGate();

    // The organization fence commits, then the subject fence fails.
    gate.refuse = (path, active) => path === "/subject/set-active" && active === false;
    await expect(gate.run(activate)).rejects.toMatchObject({
      code: "INFERENCE_CREDENTIAL_REVOCATION_UNAVAILABLE",
    });
    expect(gate.mutations).toEqual([...GATE_FENCED, ...GATE_REOPENED]);
    expect(await readStatus()).toBe("requested");

    // Both fences commit, then COMMIT itself fails.
    gate.refuse = () => false;
    gate.mutations = [];
    await dbWrite.execute(sql`
      CREATE FUNCTION refuse_deletion_request_commit() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'deletion request commit refused'; END;
      $$ LANGUAGE plpgsql
    `);
    await dbWrite.execute(sql`
      CREATE CONSTRAINT TRIGGER refuse_deletion_request_commit_trigger
      AFTER UPDATE ON account_deletion_requests
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION refuse_deletion_request_commit()
    `);
    try {
      await expect(gate.run(activate)).rejects.toThrow();
    } finally {
      await dbWrite.execute(
        sql`DROP TRIGGER refuse_deletion_request_commit_trigger ON account_deletion_requests`,
      );
      await dbWrite.execute(sql`DROP FUNCTION refuse_deletion_request_commit()`);
    }
    expect(gate.mutations).toEqual([...GATE_FENCED, ...GATE_REOPENED]);
    expect(await readStatus()).toBe("requested");

    // COMMIT succeeds but its acknowledgement is lost: the fence stays.
    gate.mutations = [];
    const commitThenFail = spyOn(dbHelpers, "writeTransaction").mockImplementation(async (fn) => {
      await originalWriteTransaction(fn);
      throw new Error("commit acknowledgement lost");
    });
    try {
      await expect(gate.run(activate)).rejects.toThrow("commit acknowledgement lost");
    } finally {
      commitThenFail.mockRestore();
    }
    expect(gate.mutations).toEqual(GATE_FENCED);
    expect(await readStatus()).toBe("reserved");
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
