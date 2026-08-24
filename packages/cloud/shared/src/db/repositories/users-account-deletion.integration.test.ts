/** Proves personal-account erasure on isolated PGlite or loopback PostgreSQL. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { pushSchema } from "drizzle-kit/api";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { resolveAccountDeletionTestDatabase } from "../account-deletion-test-database";
import { closeDatabaseConnectionsForTests, dbWrite } from "../client";
import { organizationBalanceRevisionSequence, organizations } from "../schemas/organizations";
import {
  personalSharedGroupBindings,
  personalSharedGroupJoinChallenges,
  personalSharedGroupParticipants,
} from "../schemas/personal-shared-groups";
import { userIdentities } from "../schemas/user-identities";
import { users } from "../schemas/users";
import { usersRepository } from "./users";

const PGLITE_TIMEOUT = 60_000;
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const GROUP_OWNER_ORGANIZATION_ID = "11111111-1111-4111-8111-111111111112";
const GROUP_OWNER_USER_ID = "22222222-2222-4222-8222-222222222223";
const GROUP_BINDING_ID = "44444444-4444-4444-8444-444444444444";
const REPLACEMENT_ATTEMPT_ID = "44444444-4444-4444-8444-444444444445";
const REPLACEMENT_AGENT_ID = "55555555-5555-4555-8555-555555555555";
const REPLACEMENT_GENERATION = "66666666-6666-4666-8666-666666666666";
const REPLACEMENT_DIGEST = "a".repeat(64);
const TEST_DATABASE = resolveAccountDeletionTestDatabase();
let databaseReady = true;

const replacementAttemptMigrationUrl = new URL(
  "../migrations/0313_agent_sandbox_replacement_attempts.sql",
  import.meta.url,
);

async function applyReplacementAttemptMigration(): Promise<void> {
  await dbWrite.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_node_incarnation_histories (
      id uuid PRIMARY KEY,
      docker_node_record_id uuid NOT NULL,
      node_incarnation uuid NOT NULL,
      CONSTRAINT agent_node_incarnation_histories_receipt_authority_unique
        UNIQUE (id, docker_node_record_id, node_incarnation)
    )
  `);
  await dbWrite.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_backup_restore_leases (
      id uuid NOT NULL,
      organization_id uuid NOT NULL,
      agent_id uuid NOT NULL,
      backup_id uuid NOT NULL,
      restore_attempt_id uuid NOT NULL,
      owner_id text NOT NULL,
      generation uuid NOT NULL,
      catalog_epoch bigint NOT NULL,
      copy_role text NOT NULL,
      operation_id uuid NOT NULL,
      activation_generation uuid NOT NULL,
      lifecycle_revision numeric(20, 0) NOT NULL,
      expected_manifest_sha256 text NOT NULL,
      CONSTRAINT agent_backup_restore_leases_operation_authority_unique UNIQUE (
        id, organization_id, agent_id, backup_id, restore_attempt_id, owner_id,
        generation, catalog_epoch, copy_role, operation_id,
        activation_generation, lifecycle_revision, expected_manifest_sha256
      )
    )
  `);
  const migration = await Bun.file(replacementAttemptMigrationUrl).text();
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
}

async function seedPersonalAccount(): Promise<void> {
  await dbWrite.insert(organizations).values([
    {
      id: ORGANIZATION_ID,
      name: "Personal account",
      slug: "personal-account",
    },
    {
      id: GROUP_OWNER_ORGANIZATION_ID,
      name: "Personal Shared owner",
      slug: "personal-shared-owner",
    },
  ]);
  await dbWrite.insert(users).values([
    {
      id: USER_ID,
      organization_id: ORGANIZATION_ID,
      steward_user_id: "steward-user",
    },
    {
      id: GROUP_OWNER_USER_ID,
      organization_id: GROUP_OWNER_ORGANIZATION_ID,
      steward_user_id: "steward-group-owner",
    },
  ]);
  await dbWrite.insert(userIdentities).values({
    user_id: USER_ID,
    steward_user_id: "steward-user",
  });
  await dbWrite.insert(personalSharedGroupBindings).values({
    id: GROUP_BINDING_ID,
    organization_id: GROUP_OWNER_ORGANIZATION_ID,
    owner_user_id: GROUP_OWNER_USER_ID,
    personal_agent_id: "personal:account-deletion-owner",
    platform: "blooio",
    project: "eliza-app",
    connector_account_id: "blooio:+15550100999",
    provider_chat_id: "account-deletion-family-group",
    conversation_id: "account-deletion-family-conversation",
    consent_mode: "all_adults",
    required_principal_count: 2,
    created_by_platform_user_id: "+15550100001",
  });
  const consentedAt = new Date();
  await dbWrite.insert(personalSharedGroupParticipants).values([
    {
      binding_id: GROUP_BINDING_ID,
      platform_user_id: "+15550100001",
      ordinal: 1,
      linked_user_id: GROUP_OWNER_USER_ID,
      consented_at: consentedAt,
      consent_provenance: "owner_binding",
    },
    {
      binding_id: GROUP_BINDING_ID,
      platform_user_id: "+15550100002",
      ordinal: 2,
      linked_user_id: USER_ID,
      consented_at: consentedAt,
      consent_provenance: "authenticated_dm",
    },
  ]);
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
          personalSharedGroupBindings,
          personalSharedGroupParticipants,
          personalSharedGroupJoinChallenges,
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
    await applyReplacementAttemptMigration();
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
  await dbWrite
    .delete(personalSharedGroupBindings)
    .where(eq(personalSharedGroupBindings.id, GROUP_BINDING_ID));
  await dbWrite
    .delete(userIdentities)
    .where(inArray(userIdentities.user_id, [USER_ID, GROUP_OWNER_USER_ID]));
  await dbWrite.delete(users).where(inArray(users.id, [USER_ID, GROUP_OWNER_USER_ID]));
  await dbWrite
    .delete(organizations)
    .where(inArray(organizations.id, [ORGANIZATION_ID, GROUP_OWNER_ORGANIZATION_ID]));
  await seedPersonalAccount();
});

afterAll(async () => {
  if (databaseReady) {
    await dbWrite.execute(sql`
      DELETE FROM account_deletion_restrict_probe WHERE organization_id = ${ORGANIZATION_ID}
    `);
    await dbWrite
      .delete(personalSharedGroupBindings)
      .where(eq(personalSharedGroupBindings.id, GROUP_BINDING_ID));
    await dbWrite
      .delete(userIdentities)
      .where(inArray(userIdentities.user_id, [USER_ID, GROUP_OWNER_USER_ID]));
    await dbWrite.delete(users).where(inArray(users.id, [USER_ID, GROUP_OWNER_USER_ID]));
    await dbWrite
      .delete(organizations)
      .where(inArray(organizations.id, [ORGANIZATION_ID, GROUP_OWNER_ORGANIZATION_ID]));
  }
  await closeDatabaseConnectionsForTests();
});

describe("UsersRepository.deletePersonalOrganizationAtomically", () => {
  test("unlinks Personal Shared consent before deleting the personal organization", async () => {
    await usersRepository.deletePersonalOrganizationAtomically(USER_ID, ORGANIZATION_ID);

    expect(
      await dbWrite.select().from(organizations).where(eq(organizations.id, ORGANIZATION_ID)),
    ).toHaveLength(0);
    expect(await dbWrite.select().from(users).where(eq(users.id, USER_ID))).toHaveLength(0);
    expect(
      await dbWrite.select().from(userIdentities).where(eq(userIdentities.user_id, USER_ID)),
    ).toHaveLength(0);
    expect(
      await dbWrite
        .select({
          ordinal: personalSharedGroupParticipants.ordinal,
          linkedUserId: personalSharedGroupParticipants.linked_user_id,
          consentedAt: personalSharedGroupParticipants.consented_at,
          consentProvenance: personalSharedGroupParticipants.consent_provenance,
          revokedAt: personalSharedGroupParticipants.revoked_at,
        })
        .from(personalSharedGroupParticipants)
        .where(eq(personalSharedGroupParticipants.binding_id, GROUP_BINDING_ID))
        .orderBy(asc(personalSharedGroupParticipants.ordinal)),
    ).toEqual([
      {
        ordinal: 1,
        linkedUserId: GROUP_OWNER_USER_ID,
        consentedAt: expect.any(Date),
        consentProvenance: "owner_binding",
        revokedAt: null,
      },
      {
        ordinal: 2,
        linkedUserId: null,
        consentedAt: null,
        consentProvenance: null,
        revokedAt: expect.any(Date),
      },
    ]);
    expect(
      await dbWrite
        .select({
          authorityVersion: personalSharedGroupBindings.authority_version,
          consentVersion: personalSharedGroupBindings.consent_version,
        })
        .from(personalSharedGroupBindings)
        .where(eq(personalSharedGroupBindings.id, GROUP_BINDING_ID)),
    ).toEqual([{ authorityVersion: 2, consentVersion: 2 }]);
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
    expect(
      await dbWrite
        .select({
          linkedUserId: personalSharedGroupParticipants.linked_user_id,
          consentedAt: personalSharedGroupParticipants.consented_at,
          consentProvenance: personalSharedGroupParticipants.consent_provenance,
          revokedAt: personalSharedGroupParticipants.revoked_at,
        })
        .from(personalSharedGroupParticipants)
        .where(eq(personalSharedGroupParticipants.linked_user_id, USER_ID)),
    ).toEqual([
      {
        linkedUserId: USER_ID,
        consentedAt: expect.any(Date),
        consentProvenance: "authenticated_dm",
        revokedAt: null,
      },
    ]);
    expect(
      await dbWrite
        .select({
          authorityVersion: personalSharedGroupBindings.authority_version,
          consentVersion: personalSharedGroupBindings.consent_version,
        })
        .from(personalSharedGroupBindings)
        .where(eq(personalSharedGroupBindings.id, GROUP_BINDING_ID)),
    ).toEqual([{ authorityVersion: 1, consentVersion: 1 }]);
  });

  test("cascades terminal non-restore replacement history during atomic account erasure", async () => {
    await dbWrite.execute(sql`
      INSERT INTO agent_sandbox_replacement_attempts (
        id, organization_id, agent_id, operation_kind, lifecycle_revision,
        activation_generation
      ) VALUES (
        ${REPLACEMENT_ATTEMPT_ID}, ${ORGANIZATION_ID}, ${REPLACEMENT_AGENT_ID},
        'upgrade', 7, ${REPLACEMENT_GENERATION}
      )
    `);
    await dbWrite.execute(sql`
      UPDATE agent_sandbox_replacement_attempts
      SET state = 'cleanup_proven', cleanup_proven_at = clock_timestamp(),
        cleanup_receipt_digest = ${REPLACEMENT_DIGEST}, updated_at = clock_timestamp()
      WHERE id = ${REPLACEMENT_ATTEMPT_ID}
    `);

    await usersRepository.deletePersonalOrganizationAtomically(USER_ID, ORGANIZATION_ID);

    expect(
      await dbWrite.select().from(organizations).where(eq(organizations.id, ORGANIZATION_ID)),
    ).toHaveLength(0);
    expect(await dbWrite.select().from(users).where(eq(users.id, USER_ID))).toHaveLength(0);
    expect(
      await dbWrite.select().from(userIdentities).where(eq(userIdentities.user_id, USER_ID)),
    ).toHaveLength(0);
    const attempts = await dbWrite.execute(sql`
      SELECT id FROM agent_sandbox_replacement_attempts
      WHERE organization_id = ${ORGANIZATION_ID}
    `);
    expect(attempts.rows).toHaveLength(0);
  });
});
