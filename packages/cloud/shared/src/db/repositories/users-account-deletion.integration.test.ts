/** Proves personal-account erasure on isolated PGlite or loopback PostgreSQL. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { resolveAccountDeletionTestDatabase } from "../account-deletion-test-database";
import { closeDatabaseConnectionsForTests, dbWrite } from "../client";
import { organizationBalanceRevisionSequence, organizations } from "../schemas/organizations";
import { userIdentities } from "../schemas/user-identities";
import { users } from "../schemas/users";
import { usersRepository } from "./users";

const PGLITE_TIMEOUT = 60_000;
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const TEST_DATABASE = resolveAccountDeletionTestDatabase();
let databaseReady = true;

async function seedPersonalAccount(): Promise<void> {
  await dbWrite.insert(organizations).values({
    id: ORGANIZATION_ID,
    name: "Personal account",
    slug: "personal-account",
  });
  await dbWrite.insert(users).values({
    id: USER_ID,
    organization_id: ORGANIZATION_ID,
    steward_user_id: "steward-user",
  });
  await dbWrite.insert(userIdentities).values({
    user_id: USER_ID,
    steward_user_id: "steward-user",
  });
}

beforeAll(async () => {
  if (!TEST_DATABASE) {
    databaseReady = false;
    console.warn(
      "[users-account-deletion.integration.test] refusing to mutate an unapproved database target.",
    );
    return;
  }

  try {
    if (TEST_DATABASE === "pglite") {
      const { apply } = await pushSchema(
        {
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
    await dbWrite.execute(sql`
      CREATE TABLE IF NOT EXISTS account_deletion_restrict_probe (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT
      )
    `);
  } catch (error) {
    // error-policy:J1 The test boundary records schema setup failure and every case fails loudly.
    databaseReady = false;
    console.error("[users-account-deletion.integration.test] database setup failed.", error);
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(databaseReady).toBe(true);
  await dbWrite.execute(sql`
    DELETE FROM account_deletion_restrict_probe WHERE organization_id = ${ORGANIZATION_ID}
  `);
  await dbWrite.delete(userIdentities).where(eq(userIdentities.user_id, USER_ID));
  await dbWrite.delete(users).where(eq(users.id, USER_ID));
  await dbWrite.delete(organizations).where(eq(organizations.id, ORGANIZATION_ID));
  await seedPersonalAccount();
});

afterAll(async () => {
  if (databaseReady) {
    await dbWrite.execute(sql`
      DELETE FROM account_deletion_restrict_probe WHERE organization_id = ${ORGANIZATION_ID}
    `);
    await dbWrite.delete(userIdentities).where(eq(userIdentities.user_id, USER_ID));
    await dbWrite.delete(users).where(eq(users.id, USER_ID));
    await dbWrite.delete(organizations).where(eq(organizations.id, ORGANIZATION_ID));
  }
  await closeDatabaseConnectionsForTests();
});

describe("UsersRepository.deletePersonalOrganizationAtomically", () => {
  test("deletes the organization and cascades its user identity graph", async () => {
    await usersRepository.deletePersonalOrganizationAtomically(USER_ID, ORGANIZATION_ID);

    expect(
      await dbWrite.select().from(organizations).where(eq(organizations.id, ORGANIZATION_ID)),
    ).toHaveLength(0);
    expect(await dbWrite.select().from(users).where(eq(users.id, USER_ID))).toHaveLength(0);
    expect(
      await dbWrite.select().from(userIdentities).where(eq(userIdentities.user_id, USER_ID)),
    ).toHaveLength(0);
  });

  test("rolls back the entire account when a retention foreign key blocks deletion", async () => {
    await dbWrite.execute(sql`
      INSERT INTO account_deletion_restrict_probe (id, organization_id)
      VALUES ('33333333-3333-4333-8333-333333333333', ${ORGANIZATION_ID})
    `);

    await expect(
      usersRepository.deletePersonalOrganizationAtomically(USER_ID, ORGANIZATION_ID),
    ).rejects.toThrow();

    expect(
      await dbWrite.select().from(organizations).where(eq(organizations.id, ORGANIZATION_ID)),
    ).toHaveLength(1);
    expect(await dbWrite.select().from(users).where(eq(users.id, USER_ID))).toHaveLength(1);
    expect(
      await dbWrite.select().from(userIdentities).where(eq(userIdentities.user_id, USER_ID)),
    ).toHaveLength(1);
  });
});
