/** Proves locked account deletion reservation and immediate local fences in PostgreSQL. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import {
  acquireProviderAdmission,
  releaseProviderAdmission,
} from "../../lib/services/provider-admission";
import { closeDatabaseConnectionsForTests, dbWrite } from "../client";
import { sqlRows } from "../execute-helpers";
import { accountDeletionExports } from "../schemas/account-deletion-exports";
import { accountDeletionPhaseReceipts } from "../schemas/account-deletion-phase-receipts";
import { accountDeletionRequests } from "../schemas/account-deletion-requests";
import { apiKeys } from "../schemas/api-keys";
import { organizationBalanceRevisionSequence, organizations } from "../schemas/organizations";
import { providerAdmissions } from "../schemas/provider-admissions";
import { userSessions } from "../schemas/user-sessions";
import { users } from "../schemas/users";
import { accountDeletionRequestsRepository } from "./account-deletion-requests";

const organizationId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";
const now = new Date("2026-08-22T12:00:00Z");
const recoveryExpiresAt = new Date("2026-09-21T12:00:00Z");
const BACKUP_ADMISSION_GUARD_SQL = await Promise.all(
  [
    "0349_agent_backup_admission_cohort_authority.sql",
    "0353_agent_backup_admission_work_state_shapes.sql",
    "0354_agent_backup_admission_work_stage_policy.sql",
    "0355_agent_backup_admission_work_indexes.sql",
    "0356_agent_backup_admission_work_identity_guard.sql",
    "0357_agent_backup_admission_work_state_guard.sql",
    "0358_agent_backup_admission_work_delete_guard.sql",
    "0359_agent_backup_admission_shard_guard.sql",
    "0360_agent_backup_admission_claim_authority.sql",
    "0361_agent_backup_admission_claim_seed.sql",
    // 0362 is nontransactional index coverage owned by the migrator lane.
    "0363_agent_backup_admission_claim_guard.sql",
    "0364_agent_backup_admission_claim_eligibility.sql",
  ].map((name) => Bun.file(new URL(`../migrations/${name}`, import.meta.url)).text()),
);
const billingCancelMigrations = await Promise.all(
  [
    "0335_billing_cancel_commands.sql",
    "0336_billing_cancel_command_keys.sql",
    "0337_billing_cancel_guard_functions.sql",
    "0338_billing_cancel_guards.sql",
    "0343_billing_cancel_account_deletion_detach.sql",
    "0344_billing_cancel_account_deletion_guard.sql",
    "0345_billing_cancel_key_command_subject_consistency.sql",
  ].map((name) => Bun.file(new URL(`../migrations/${name}`, import.meta.url)).text()),
);

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
        completed: false,
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
      providerAdmissions,
      userSessions,
      users,
    } as never,
    dbWrite as never,
  );
  await apply();
  await dbWrite.execute(`
    CREATE TABLE jobs (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
    )
  `);
  for (const statement of billingCancelMigrations
    .join("\n--> statement-breakpoint\n")
    .split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(statement);
  }
  await dbWrite.execute(`
    CREATE TABLE account_deletion_restrictive_fixture (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT
    )
  `);
  await dbWrite.execute(`
    CREATE TABLE agent_sandbox_replacement_attempts (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      state text NOT NULL DEFAULT 'in_flight_unresolved'
    )
  `);
  // The real PostgreSQL race suite applies production migrations 0321-0328.
  // This bounded PGlite fixture mirrors their deletion authority exactly:
  // direct child deletion is forbidden and only a terminal owner cascade wins.
  await dbWrite.execute(`
    CREATE FUNCTION guard_test_replacement_attempt_delete() RETURNS trigger
    LANGUAGE plpgsql AS $guard$
    BEGIN
      IF pg_trigger_depth() = 2
        AND OLD.state IN ('lifecycle_committed', 'cleanup_proven')
        AND NOT EXISTS (
          SELECT 1 FROM organizations WHERE id = OLD.organization_id
        ) THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'replacement attempts cannot be deleted before terminal owner erasure';
    END;
    $guard$;
  `);
  await dbWrite.execute(`
    CREATE TRIGGER agent_sandbox_replacement_attempts_guard_delete
      BEFORE DELETE ON agent_sandbox_replacement_attempts
      FOR EACH ROW EXECUTE FUNCTION guard_test_replacement_attempt_delete()
  `);
  await dbWrite.execute(`
    CREATE TABLE agent_backup_admission_work (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      work_kind text NOT NULL,
      work_stage text NOT NULL,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      sandbox_id uuid,
      backup_id uuid,
      gc_object_id uuid,
      node_history_id uuid,
      source_activation_generation uuid,
      source_lifecycle_revision bigint,
      source_provider_handle text,
      source_container_id text,
      source_image_digest text,
      source_rpo_ms integer,
      requires_node_lane boolean NOT NULL,
      priority_class text NOT NULL,
      base_priority smallint NOT NULL,
      source_due_at timestamptz NOT NULL,
      rpo_deadline_at timestamptz,
      first_eligible_at timestamptz GENERATED ALWAYS AS (source_due_at) STORED,
      state text NOT NULL DEFAULT 'queued',
      not_before timestamptz NOT NULL,
      deferred_reason text,
      ready_cohort bigint NOT NULL,
      cohort_ordinal integer NOT NULL,
      shard_id smallint NOT NULL,
      lease_owner text,
      lease_generation uuid,
      lease_expires_at timestamptz,
      attempts integer NOT NULL DEFAULT 0,
      settled_at timestamptz,
      settled_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  for (const migration of BACKUP_ADMISSION_GUARD_SQL) {
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await dbWrite.execute(statement);
    }
  }
  const stateGuard = await sqlRows<{ definition: string }>(
    dbWrite,
    sql`
      SELECT pg_get_functiondef(procedure.oid) AS definition
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname = 'guard_agent_backup_admission_work_state'
    `,
  );
  expect(stateGuard).toHaveLength(1);
  expect(stateGuard[0]?.definition).toContain("agent_backup_admission_effective_priority");
  expect(stateGuard[0]?.definition).toContain("backup admission claim requires ready work");
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

async function seedBackupAdmissionWork(
  id: string,
  state: "queued" | "deferred" | "leased" = "queued",
): Promise<void> {
  await dbWrite.execute(sql`INSERT INTO agent_backup_admission_work (
      id, work_kind, work_stage, organization_id, sandbox_id, node_history_id,
      source_activation_generation, source_lifecycle_revision, source_provider_handle,
      source_container_id, source_image_digest, source_rpo_ms, requires_node_lane,
      priority_class, base_priority, source_due_at, rpo_deadline_at, not_before,
      ready_cohort, cohort_ordinal, shard_id
    ) VALUES (
      ${id}::uuid, 'schedule_capture', 'reserve_capture', ${organizationId}::uuid,
      '73000000-0000-4000-8000-000000000001'::uuid,
      '74000000-0000-4000-8000-000000000001'::uuid,
      ${id}::uuid, 7, 'sandbox-provider',
      ${"a".repeat(64)}, ${`sha256:${"b".repeat(64)}`}, 900000, TRUE,
      'periodic_capture', 3, ${now}, ${recoveryExpiresAt}, ${now}, 1, 0, 50
    )`);
  if (state === "deferred") {
    await dbWrite.execute(sql`UPDATE agent_backup_admission_work
      SET state = 'deferred', deferred_reason = 'TEST_BACKPRESSURE'
      WHERE id = ${id}::uuid`);
  } else if (state === "leased") {
    // This fixture tests deletion settlement, not claim acquisition. Seed an
    // already-authorized lease with the complete write-once proof shape from
    // migration 0357 so the deletion path cannot mint or rewrite that proof.
    await dbWrite.execute(
      "ALTER TABLE agent_backup_admission_work DISABLE TRIGGER agent_backup_admission_work_20_state_guard",
    );
    try {
      await dbWrite.execute(sql`UPDATE agent_backup_admission_work
        SET state = 'leased', lease_owner = 'deletion-test-worker',
          lease_generation = '90000000-0000-4000-8000-000000000001',
          lease_expires_at = clock_timestamp() + interval '1 day', attempts = 1,
          claim_cycle_start_turn = 101, claim_proof_turn = 102,
          claim_proof_xid = pg_current_xact_id(), claim_proof_priority_pass = 0,
          claim_proof_attempt = 1
        WHERE id = ${id}::uuid`);
    } finally {
      await dbWrite.execute(
        "ALTER TABLE agent_backup_admission_work ENABLE TRIGGER agent_backup_admission_work_20_state_guard",
      );
    }
  }
}

async function readBackupAdmissionClaimProof(id: string): Promise<Record<string, unknown>> {
  const proof = await dbWrite.execute(sql`SELECT
      claim_cycle_start_turn::text AS claim_cycle_start_turn,
      claim_proof_turn::text AS claim_proof_turn,
      claim_proof_xid::text AS claim_proof_xid,
      claim_proof_priority_pass,
      claim_proof_attempt
    FROM agent_backup_admission_work WHERE id = ${id}::uuid`);
  const row = proof.rows[0];
  if (!row) throw new Error(`missing backup admission proof for ${id}`);
  return row;
}

async function seedNonCaptureAdmissionWork(
  id: string,
  workKind: "catalog_operation" | "gc_object",
): Promise<void> {
  await dbWrite.execute(sql`INSERT INTO agent_backup_admission_work (
      id, work_kind, work_stage, organization_id, backup_id, gc_object_id,
      requires_node_lane, priority_class, base_priority, source_due_at, not_before,
      ready_cohort, cohort_ordinal, shard_id
    ) VALUES (
      ${id}::uuid, ${workKind},
      ${workKind === "catalog_operation" ? "primary_publication" : "delete_object"},
      ${organizationId}::uuid,
      ${workKind === "catalog_operation" ? id : null}::uuid,
      ${workKind === "gc_object" ? id : null}::uuid,
      FALSE,
      ${workKind === "catalog_operation" ? "periodic_capture" : "garbage_collection"},
      ${workKind === "catalog_operation" ? 3 : 6},
      ${now}, ${now}, 1, 0, 50
    )`);
}

async function activateReservation(tokenSuffix: string, activatedAt = now) {
  return accountDeletionRequestsRepository.activateReservedPersonalAccountDeletion({
    recoveryTokenHash: `recovery-${tokenSuffix}`,
    now: activatedAt,
  });
}

beforeEach(async () => {
  await dbWrite.execute(
    "ALTER TABLE billing_cancel_command_keys DISABLE TRIGGER billing_cancel_command_keys_authority_immutable",
  );
  await dbWrite.execute(
    "ALTER TABLE billing_cancel_commands DISABLE TRIGGER billing_cancel_commands_authority_immutable",
  );
  await dbWrite.execute("DELETE FROM billing_cancel_command_keys");
  await dbWrite.execute("DELETE FROM billing_cancel_commands");
  await dbWrite.execute(
    "ALTER TABLE billing_cancel_command_keys ENABLE TRIGGER billing_cancel_command_keys_authority_immutable",
  );
  await dbWrite.execute(
    "ALTER TABLE billing_cancel_commands ENABLE TRIGGER billing_cancel_commands_authority_immutable",
  );
  await dbWrite.execute("DELETE FROM account_deletion_restrictive_fixture");
  await dbWrite.execute("ALTER TABLE agent_sandbox_replacement_attempts DISABLE TRIGGER USER");
  await dbWrite.execute("DELETE FROM agent_sandbox_replacement_attempts");
  await dbWrite.execute("ALTER TABLE agent_sandbox_replacement_attempts ENABLE TRIGGER USER");
  await dbWrite.execute("ALTER TABLE agent_backup_admission_work DISABLE TRIGGER USER");
  await dbWrite.execute("DELETE FROM agent_backup_admission_work");
  await dbWrite.execute("ALTER TABLE agent_backup_admission_work ENABLE TRIGGER USER");
  await dbWrite.delete(providerAdmissions);
  await dbWrite.delete(accountDeletionRequests);
  await dbWrite.delete(organizations);
  await seedPersonalAccount();
});

describe("personal account deletion reservation", () => {
  test("waits for provider admission release before committing the deletion fence", async () => {
    await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000090", "provider-race"),
    );
    const providerAuthority = {
      organizationId,
      operationKind: "auto_top_up" as const,
      operationId: "60000000-0000-4000-8000-000000000090",
    };
    await expect(acquireProviderAdmission(providerAuthority, now)).resolves.toBe(true);
    await expect(activateReservation("provider-race")).resolves.toEqual({
      outcome: "provider_work_in_flight",
    });
    expect((await dbWrite.select().from(organizations))[0]?.account_lifecycle_state).toBe("active");
    await releaseProviderAdmission(providerAuthority, now);
    await expect(activateReservation("provider-race")).resolves.toMatchObject({
      outcome: "activated",
    });
    expect((await dbWrite.select().from(organizations))[0]?.account_lifecycle_state).toBe(
      "deletion_recovery",
    );
  });

  test("reopens one released operation for a retry only while lifecycle authority remains active", async () => {
    const providerAuthority = {
      organizationId,
      operationKind: "agent_lifecycle" as const,
      operationId: "60000000-0000-4000-8000-000000000091",
    };
    const firstAdmissionAt = new Date(now.getTime() - 2_000);
    const retryAdmissionAt = new Date(now.getTime() - 1_000);

    await expect(acquireProviderAdmission(providerAuthority, firstAdmissionAt)).resolves.toBe(true);
    await releaseProviderAdmission(providerAuthority, new Date(firstAdmissionAt.getTime() + 100));
    await expect(acquireProviderAdmission(providerAuthority, retryAdmissionAt)).resolves.toBe(true);

    const [reopened] = await dbWrite
      .select()
      .from(providerAdmissions)
      .where(eq(providerAdmissions.operation_id, providerAuthority.operationId));
    expect(reopened).toMatchObject({
      organization_id: organizationId,
      operation_kind: "agent_lifecycle",
      operation_id: providerAuthority.operationId,
      admitted_at: retryAdmissionAt,
      released_at: null,
    });

    await releaseProviderAdmission(providerAuthority, now);
    await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000091", "retry-fenced"),
    );
    await expect(activateReservation("retry-fenced")).resolves.toMatchObject({
      outcome: "activated",
    });
    await expect(
      acquireProviderAdmission(providerAuthority, new Date(now.getTime() + 1)),
    ).resolves.toBe(false);
  });

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

  test("reserves without mutation, then atomically fences after package acknowledgement", async () => {
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
      status: "requested",
      admission_token_hash: "admission-one",
      restore_auto_top_up_enabled: true,
      restore_pay_as_you_go_from_earnings: true,
    });
    expect(organization).toMatchObject({
      is_active: true,
      auto_top_up_enabled: true,
      pay_as_you_go_from_earnings: true,
      account_lifecycle_state: "active",
      account_lifecycle_revision: 0,
    });
    expect(user).toMatchObject({
      is_active: true,
      account_lifecycle_state: "active",
      account_lifecycle_revision: 0,
    });
    expect(key?.is_active).toBe(true);
    expect(session?.ended_at).toBeNull();
    expect(phases).toHaveLength(3);
    expect(phases.find((phase) => phase.phase === "account_authority")?.status).toBe("pending");
    expect(exports).toHaveLength(1);

    await expect(activateReservation("one")).resolves.toMatchObject({
      outcome: "activated",
      request: { status: "reserved" },
    });
    await expect(activateReservation("one", new Date(now.getTime() + 1))).resolves.toMatchObject({
      outcome: "already_activated",
      request: { status: "reserved" },
    });

    const [fencedOrganization] = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    const [fencedUser] = await dbWrite.select().from(users).where(eq(users.id, userId));
    const [revokedKey] = await dbWrite.select().from(apiKeys).where(eq(apiKeys.user_id, userId));
    const [endedSession] = await dbWrite
      .select()
      .from(userSessions)
      .where(eq(userSessions.user_id, userId));
    const activatedPhases = await dbWrite
      .select()
      .from(accountDeletionPhaseReceipts)
      .where(eq(accountDeletionPhaseReceipts.request_id, result.request.id));
    expect(fencedOrganization).toMatchObject({
      is_active: false,
      auto_top_up_enabled: false,
      pay_as_you_go_from_earnings: false,
      account_lifecycle_state: "deletion_recovery",
      account_lifecycle_revision: 1,
    });
    expect(fencedUser).toMatchObject({
      is_active: false,
      account_lifecycle_state: "deletion_recovery",
      account_lifecycle_revision: 1,
    });
    expect(revokedKey?.is_active).toBe(false);
    expect(endedSession?.ended_at).toEqual(now);
    expect(activatedPhases.find((phase) => phase.phase === "account_authority")?.status).toBe(
      "completed",
    );

    const status = await accountDeletionRequestsRepository.findByStatusTokenHash("status-one", now);
    expect(status?.request.id).toBe(result.request.id);
    expect(status?.exportReceipt?.status).toBe("pending");
    const admission = await accountDeletionRequestsRepository.findByAdmissionTokenHash(
      "admission-one",
      now,
    );
    expect(admission?.request.id).toBe(result.request.id);
  });

  test("replays matching admission and safely replaces an evicted pre-fence package", async () => {
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
    expect(wrongSecret.outcome).toBe("reserved");
    if (!("request" in first) || !("request" in retry) || !("request" in wrongSecret)) {
      throw new Error("reservation receipts were not returned");
    }
    expect(retry.request.id).toBe(first.request.id);
    expect(wrongSecret.request.id).toBe(first.request.id);
    expect(await dbWrite.select().from(accountDeletionRequests)).toHaveLength(1);
    await expect(
      accountDeletionRequestsRepository.activateReservedPersonalAccountDeletion({
        recoveryTokenHash: "recovery-lost-response",
        now,
      }),
    ).resolves.toEqual({ outcome: "invalid_credential" });
    await expect(activateReservation("wrong-secret")).resolves.toMatchObject({
      outcome: "activated",
      request: { id: first.request.id, status: "reserved" },
    });
  });

  test("serializes concurrent pre-fence packages onto one receipt", async () => {
    const [left, right] = await Promise.all([
      accountDeletionRequestsRepository.reservePersonalAccountDeletion(
        reservationInput("50000000-0000-4000-8000-000000000002", "two"),
      ),
      accountDeletionRequestsRepository.reservePersonalAccountDeletion(
        reservationInput("50000000-0000-4000-8000-000000000003", "three"),
      ),
    ]);
    expect([left.outcome, right.outcome].sort()).toEqual(["reserved", "reserved"]);
    if (!("request" in left) || !("request" in right)) {
      throw new Error("concurrent reservations did not return receipts");
    }
    expect(left.request.id).toBe(right.request.id);
    const final = (await dbWrite.select().from(accountDeletionRequests))[0];
    if (!final?.status_token_hash) throw new Error("winning status receipt was not persisted");
    expect(["status-two", "status-three"]).toContain(final.status_token_hash);
    const receipts = await dbWrite.select().from(accountDeletionRequests);
    expect(receipts).toHaveLength(1);
  });

  test("undo restores lifecycle authority but leaves sessions and API keys revoked", async () => {
    const reserved = await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000004", "undo"),
    );
    expect(reserved.outcome).toBe("reserved");
    if (reserved.outcome !== "reserved") throw new Error("reservation failed");
    const recoverableWorkId = "72000000-0000-4000-8000-000000000001";
    await seedBackupAdmissionWork(recoverableWorkId);
    await expect(activateReservation("undo")).resolves.toMatchObject({ outcome: "activated" });

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
    const recoverableWork = await dbWrite.execute(sql`SELECT state, settled_reason
      FROM agent_backup_admission_work WHERE id = ${recoverableWorkId}::uuid`);
    expect(recoverableWork.rows).toEqual([{ state: "queued", settled_reason: null }]);
  });

  test("never restores authority after the recovery deadline", async () => {
    await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000005", "expired"),
    );
    await expect(activateReservation("expired")).resolves.toMatchObject({ outcome: "activated" });
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
    await expect(activateReservation("export")).resolves.toMatchObject({ outcome: "activated" });

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

  test("rearms revocation when an exact export PUT is acknowledged after deletion", async () => {
    const reserved = await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000060", "late-export-put"),
    );
    if (reserved.outcome !== "reserved") throw new Error("reservation failed");
    await expect(activateReservation("late-export-put")).resolves.toMatchObject({
      outcome: "activated",
    });

    const exportLease = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "export",
      leaseOwnerDigest: "late-export-worker",
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

    const revokeAt = new Date(now.getTime() + 1_000);
    await accountDeletionRequestsRepository.ensureExportRevocationPhase({
      requestId: reserved.request.id,
      idempotencyKeyDigest: "late-export-revoke",
      nextAttemptAt: revokeAt,
      now: revokeAt,
    });
    const firstRevokeLease = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "export_revoke",
      leaseOwnerDigest: "first-revoke-worker",
      now: revokeAt,
      leaseMilliseconds: 60_000,
    });
    if (!firstRevokeLease) throw new Error("first export revocation lease failed");
    expect(
      await accountDeletionRequestsRepository.completeExportRevocation({
        requestId: reserved.request.id,
        phaseReceiptId: firstRevokeLease.receipt.id,
        generation: firstRevokeLease.generation,
        providerReceiptDigest: "first-delete-receipt",
        now: revokeAt,
      }),
    ).toBe(true);

    const lateAcknowledgementAt = new Date(revokeAt.getTime() + 1_000);
    expect(
      await accountDeletionRequestsRepository.completeExportPhase({
        requestId: reserved.request.id,
        phaseReceiptId: exportLease.receipt.id,
        generation: exportLease.generation,
        contentDigest: "late-content-digest",
        objectReceiptDigest: "late-object-receipt",
        byteCount: 321,
        now: lateAcknowledgementAt,
      }),
    ).toBe(false);

    const [fencedExport] = await dbWrite
      .select()
      .from(accountDeletionExports)
      .where(eq(accountDeletionExports.request_id, reserved.request.id));
    const phases = await accountDeletionRequestsRepository.listPhaseReceipts(reserved.request.id);
    const fencedExportPhase = phases.find((phase) => phase.phase === "export");
    const rearmedRevoke = phases.find((phase) => phase.phase === "export_revoke");
    expect(fencedExport).toMatchObject({
      status: "expired",
      content_digest: "late-content-digest",
      object_receipt_digest: "late-object-receipt",
      byte_count: 321,
      ready_at: null,
      deleted_at: null,
      last_error_code: "ACCOUNT_DELETION_EXPORT_LATE_PUT_REQUIRES_REVOCATION",
    });
    expect(fencedExportPhase).toMatchObject({
      status: "canceled",
      lease_generation: exportLease.generation,
      provider_receipt_digest: "late-object-receipt",
      last_error_code: "ACCOUNT_DELETION_EXPORT_LATE_PUT_REQUIRES_REVOCATION",
    });
    expect(rearmedRevoke).toMatchObject({
      id: firstRevokeLease.receipt.id,
      status: "pending",
      lease_generation: firstRevokeLease.generation,
      attempt_count: 0,
      provider_receipt_digest: "first-delete-receipt",
      next_attempt_at: lateAcknowledgementAt,
      last_error_code: "ACCOUNT_DELETION_EXPORT_LATE_PUT_REQUIRES_REVOCATION",
    });
    expect(
      await accountDeletionRequestsRepository.findExportRevocationsDue(lateAcknowledgementAt, 10),
    ).toContainEqual({
      requestId: reserved.request.id,
      requestDigest: "request-late-export-put",
    });

    const secondRevokeLease = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "export_revoke",
      leaseOwnerDigest: "second-revoke-worker",
      now: new Date(lateAcknowledgementAt.getTime() + 1),
      leaseMilliseconds: 60_000,
    });
    if (!secondRevokeLease) throw new Error("rearmed export revocation lease failed");
    expect(secondRevokeLease.generation).toBe(firstRevokeLease.generation + 1);
    expect(
      await accountDeletionRequestsRepository.completeExportRevocation({
        requestId: reserved.request.id,
        phaseReceiptId: secondRevokeLease.receipt.id,
        generation: secondRevokeLease.generation,
        providerReceiptDigest: "second-delete-receipt",
        now: new Date(lateAcknowledgementAt.getTime() + 1),
      }),
    ).toBe(true);
    const [deletedAgain] = await dbWrite
      .select()
      .from(accountDeletionExports)
      .where(eq(accountDeletionExports.request_id, reserved.request.id));
    expect(deletedAgain).toMatchObject({
      status: "deleted",
      content_digest: null,
      object_receipt_digest: "second-delete-receipt",
      byte_count: null,
    });
  });

  test("rejects a leased export after revocation scheduling fences its generation", async () => {
    const reserved = await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000061", "fenced-export-lease"),
    );
    if (reserved.outcome !== "reserved") throw new Error("reservation failed");
    await expect(activateReservation("fenced-export-lease")).resolves.toMatchObject({
      outcome: "activated",
    });
    const exportLease = await accountDeletionRequestsRepository.leasePhase({
      requestId: reserved.request.id,
      phase: "export",
      leaseOwnerDigest: "fenced-export-worker",
      now,
      leaseMilliseconds: 60_000,
    });
    if (!exportLease) throw new Error("export lease failed");

    const revokeAt = new Date(now.getTime() + 1);
    await accountDeletionRequestsRepository.ensureExportRevocationPhase({
      requestId: reserved.request.id,
      idempotencyKeyDigest: "fenced-export-revoke",
      nextAttemptAt: revokeAt,
      now: revokeAt,
    });
    expect(
      await accountDeletionRequestsRepository.markExportBuilding({
        requestId: reserved.request.id,
        phaseReceiptId: exportLease.receipt.id,
        generation: exportLease.generation,
        now: new Date(revokeAt.getTime() + 1),
      }),
    ).toBe(false);

    const [fencedExport] = await dbWrite
      .select()
      .from(accountDeletionExports)
      .where(eq(accountDeletionExports.request_id, reserved.request.id));
    const phases = await accountDeletionRequestsRepository.listPhaseReceipts(reserved.request.id);
    expect(fencedExport?.status).toBe("expired");
    expect(phases.find((phase) => phase.phase === "export")).toMatchObject({
      status: "canceled",
      lease_generation: exportLease.generation,
      lease_owner_digest: null,
      lease_expires_at: null,
      last_error_code: "ACCOUNT_DELETION_EXPORT_REVOCATION_FENCED",
    });
    expect(phases.find((phase) => phase.phase === "export_revoke")).toMatchObject({
      status: "pending",
      next_attempt_at: revokeAt,
    });
  });

  test("preserves reconciliation mode across an explicit lost-response retry", async () => {
    const reserved = await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000006", "reconcile"),
    );
    if (reserved.outcome !== "reserved") throw new Error("reservation failed");
    await expect(activateReservation("reconcile")).resolves.toMatchObject({
      outcome: "activated",
    });
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
    await seedBackupAdmissionWork("72000000-0000-4000-8000-000000000010", "queued");
    await seedBackupAdmissionWork("72000000-0000-4000-8000-000000000011", "deferred");
    await seedBackupAdmissionWork("72000000-0000-4000-8000-000000000012", "leased");
    const leasedProofBeforeSettlement = await readBackupAdmissionClaimProof(
      "72000000-0000-4000-8000-000000000012",
    );
    await seedNonCaptureAdmissionWork("72000000-0000-4000-8000-000000000013", "catalog_operation");
    await seedNonCaptureAdmissionWork("72000000-0000-4000-8000-000000000014", "gc_object");
    await expect(activateReservation("expiry")).resolves.toMatchObject({ outcome: "activated" });

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
    const settledAdmission = await dbWrite.execute(`SELECT id, work_kind, state,
      deferred_reason, lease_owner, lease_generation, lease_expires_at, attempts,
      not_before, ready_cohort, cohort_ordinal, sandbox_id, settled_at, settled_reason,
      updated_at
      FROM agent_backup_admission_work
      WHERE work_kind = 'schedule_capture' ORDER BY id`);
    expect(
      settledAdmission.rows.map(
        ({
          id,
          work_kind,
          state,
          deferred_reason,
          lease_owner,
          lease_generation,
          lease_expires_at,
          attempts,
          ready_cohort,
          cohort_ordinal,
          sandbox_id,
          settled_reason,
        }) => ({
          id,
          work_kind,
          state,
          deferred_reason,
          lease_owner,
          lease_generation,
          lease_expires_at,
          attempts,
          ready_cohort: String(ready_cohort),
          cohort_ordinal,
          sandbox_id,
          settled_reason,
        }),
      ),
    ).toEqual([
      {
        id: "72000000-0000-4000-8000-000000000010",
        work_kind: "schedule_capture",
        state: "settled",
        deferred_reason: null,
        lease_owner: null,
        lease_generation: null,
        lease_expires_at: null,
        attempts: 0,
        ready_cohort: "1",
        cohort_ordinal: 0,
        sandbox_id: "73000000-0000-4000-8000-000000000001",
        settled_reason: "ACCOUNT_DELETION_IRREVERSIBLE",
      },
      {
        id: "72000000-0000-4000-8000-000000000011",
        work_kind: "schedule_capture",
        state: "settled",
        deferred_reason: null,
        lease_owner: null,
        lease_generation: null,
        lease_expires_at: null,
        attempts: 0,
        ready_cohort: "1",
        cohort_ordinal: 0,
        sandbox_id: "73000000-0000-4000-8000-000000000001",
        settled_reason: "ACCOUNT_DELETION_IRREVERSIBLE",
      },
      {
        id: "72000000-0000-4000-8000-000000000012",
        work_kind: "schedule_capture",
        state: "settled",
        deferred_reason: null,
        lease_owner: null,
        lease_generation: null,
        lease_expires_at: null,
        attempts: 1,
        ready_cohort: "1",
        cohort_ordinal: 0,
        sandbox_id: "73000000-0000-4000-8000-000000000001",
        settled_reason: "ACCOUNT_DELETION_IRREVERSIBLE",
      },
    ]);
    expect(await readBackupAdmissionClaimProof("72000000-0000-4000-8000-000000000012")).toEqual(
      leasedProofBeforeSettlement,
    );
    expect(
      settledAdmission.rows.every(
        ({ not_before, settled_at, updated_at }) =>
          new Date(String(not_before)).getTime() === now.getTime() &&
          new Date(String(settled_at)).getTime() === new Date(String(updated_at)).getTime(),
      ),
    ).toBe(true);
    expect(new Set(settledAdmission.rows.map(({ settled_at }) => String(settled_at))).size).toBe(1);
    const unrelatedAdmission = await dbWrite.execute(`SELECT work_kind, state, settled_reason
      FROM agent_backup_admission_work WHERE work_kind <> 'schedule_capture' ORDER BY work_kind`);
    expect(unrelatedAdmission.rows).toEqual(
      ["catalog_operation", "gc_object"].map((work_kind) => ({
        work_kind,
        state: "queued",
        settled_reason: null,
      })),
    );
    expect(phases.filter((phase) => phase.phase === "export_revoke")).toHaveLength(1);
  });

  test("fails closed at expiry until export and Steward receipts are complete", async () => {
    const reserved = await accountDeletionRequestsRepository.reservePersonalAccountDeletion(
      reservationInput("50000000-0000-4000-8000-000000000008", "incomplete"),
    );
    if (reserved.outcome !== "reserved") throw new Error("reservation failed");
    await expect(activateReservation("incomplete")).resolves.toMatchObject({
      outcome: "activated",
    });

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
    const durableAdmissionWorkId = "72000000-0000-4000-8000-000000000020";
    await seedBackupAdmissionWork(durableAdmissionWorkId, "leased");
    const durableProofBeforeSettlement =
      await readBackupAdmissionClaimProof(durableAdmissionWorkId);
    await seedNonCaptureAdmissionWork("72000000-0000-4000-8000-000000000022", "catalog_operation");
    await seedNonCaptureAdmissionWork("72000000-0000-4000-8000-000000000023", "gc_object");
    const commandId = "72000000-0000-4000-8000-000000000001";
    const jobId = "73000000-0000-4000-8000-000000000001";
    const historicalActorCommandId = "72000000-0000-4000-8000-000000000002";
    const historicalActorJobId = "73000000-0000-4000-8000-000000000002";
    const crossOrganizationCommandId = "72000000-0000-4000-8000-000000000003";
    const crossOrganizationJobId = "73000000-0000-4000-8000-000000000003";
    const otherOrganizationId = "10000000-0000-4000-8000-000000000002";
    const otherUserId = "20000000-0000-4000-8000-000000000002";
    await dbWrite.insert(organizations).values({
      id: otherOrganizationId,
      name: "Other",
      slug: "other-billing-receipts",
    });
    await dbWrite.insert(users).values({
      id: otherUserId,
      organization_id: organizationId,
      steward_user_id: "steward-other",
      role: "member",
    });
    await dbWrite.execute(
      `INSERT INTO jobs (id, organization_id) VALUES
        ('${jobId}', '${organizationId}'),
        ('${historicalActorJobId}', '${organizationId}'),
        ('${crossOrganizationJobId}', '${otherOrganizationId}')`,
    );
    await dbWrite.execute(`INSERT INTO billing_cancel_commands (
        id, organization_id, requested_by_user_id, resource_type, resource_id,
        expected_lifecycle_revision, job_id
      ) VALUES (
        '${commandId}', '${organizationId}', '${userId}', 'container',
        '74000000-0000-4000-8000-000000000001', 7, '${jobId}'
      )`);
    await dbWrite.execute(`INSERT INTO billing_cancel_commands (
      id, organization_id, requested_by_user_id, resource_type, resource_id,
      expected_lifecycle_revision, job_id
    ) VALUES (
      '${historicalActorCommandId}', '${organizationId}', '${otherUserId}', 'container',
      '74000000-0000-4000-8000-000000000002', 8, '${historicalActorJobId}'
    )`);
    await dbWrite
      .update(users)
      .set({ organization_id: otherOrganizationId })
      .where(eq(users.id, otherUserId));
    await dbWrite
      .update(users)
      .set({ organization_id: otherOrganizationId })
      .where(eq(users.id, userId));
    await dbWrite.execute(`INSERT INTO billing_cancel_commands (
      id, organization_id, requested_by_user_id, resource_type, resource_id,
      expected_lifecycle_revision, job_id
    ) VALUES (
      '${crossOrganizationCommandId}', '${otherOrganizationId}', '${userId}', 'container',
      '74000000-0000-4000-8000-000000000003', 9, '${crossOrganizationJobId}'
    )`);
    await dbWrite
      .update(users)
      .set({ organization_id: organizationId })
      .where(eq(users.id, userId));
    await dbWrite.execute(`INSERT INTO billing_cancel_command_keys (
        organization_id, idempotency_key_hash, request_digest, command_id,
        requested_by_user_id
      ) VALUES
        ('${organizationId}', '${"a".repeat(64)}', '${"c".repeat(64)}', '${commandId}', '${userId}'),
        ('${organizationId}', '${"b".repeat(64)}', '${"c".repeat(64)}', '${commandId}', '${userId}');
    `);
    await dbWrite
      .update(users)
      .set({ organization_id: organizationId })
      .where(eq(users.id, otherUserId));
    await dbWrite.execute(`INSERT INTO billing_cancel_command_keys (
      organization_id, idempotency_key_hash, request_digest, command_id, requested_by_user_id
    ) VALUES
      ('${organizationId}', '${"c".repeat(64)}', '${"c".repeat(64)}',
        '${commandId}', '${otherUserId}'),
      ('${organizationId}', '${"d".repeat(64)}', '${"e".repeat(64)}',
        '${historicalActorCommandId}', '${otherUserId}')`);
    await dbWrite
      .update(users)
      .set({ organization_id: otherOrganizationId })
      .where(eq(users.id, otherUserId));
    await dbWrite
      .update(users)
      .set({ organization_id: otherOrganizationId })
      .where(eq(users.id, userId));
    await dbWrite.execute(`INSERT INTO billing_cancel_command_keys (
      organization_id, idempotency_key_hash, request_digest, command_id, requested_by_user_id
    ) VALUES ('${otherOrganizationId}', '${"f".repeat(64)}', '${"0".repeat(64)}',
      '${crossOrganizationCommandId}', '${userId}')`);
    await dbWrite
      .update(users)
      .set({ organization_id: organizationId })
      .where(eq(users.id, userId));
    await expect(activateReservation("erase")).resolves.toMatchObject({ outcome: "activated" });
    await dbWrite.execute(`
      INSERT INTO agent_sandbox_replacement_attempts (id, organization_id, state)
      VALUES (
        '71000000-0000-4000-8000-000000000001',
        '${organizationId}',
        'cleanup_proven'
      )
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
    let lateInsertFailure: unknown;
    try {
      await seedBackupAdmissionWork("72000000-0000-4000-8000-000000000021");
    } catch (cause) {
      lateInsertFailure = cause;
    }
    expect(lateInsertFailure).toBeDefined();
    expect(String((lateInsertFailure as { cause?: unknown }).cause)).toMatch(
      /requires active account authority/i,
    );
    const settledBeforeFinalization = await dbWrite.execute(sql`SELECT state, attempts
      FROM agent_backup_admission_work WHERE id = ${durableAdmissionWorkId}::uuid`);
    expect(settledBeforeFinalization.rows).toEqual([
      {
        state: "settled",
        attempts: 1,
      },
    ]);
    expect(await readBackupAdmissionClaimProof(durableAdmissionWorkId)).toEqual(
      durableProofBeforeSettlement,
    );
    const purgeOwnedBeforeFinalization = await dbWrite.execute(`SELECT work_kind, state
      FROM agent_backup_admission_work WHERE work_kind <> 'schedule_capture' ORDER BY work_kind`);
    expect(purgeOwnedBeforeFinalization.rows).toEqual([
      { work_kind: "catalog_operation", state: "queued" },
      { work_kind: "gc_object", state: "queued" },
    ]);
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
    expect((await dbWrite.select().from(organizations)).map(({ id }) => id)).toEqual([
      otherOrganizationId,
    ]);
    expect((await dbWrite.select().from(users)).map(({ id }) => id)).toEqual([otherUserId]);
    expect((await dbWrite.execute("SELECT id FROM jobs")).rows).toEqual([
      { id: crossOrganizationJobId },
    ]);
    expect(await dbWrite.select().from(accountDeletionPhaseReceipts)).toHaveLength(0);
    expect(await dbWrite.select().from(accountDeletionExports)).toHaveLength(0);
    const admissionWork = await dbWrite.execute("SELECT id FROM agent_backup_admission_work");
    expect(admissionWork.rows).toHaveLength(0);
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
    const commands = await dbWrite.execute(`SELECT id, organization_id,
      requested_by_user_id, job_id, organization_deletion_request_id,
      requesting_user_deletion_request_id,
      resource_type, resource_id, expected_lifecycle_revision::text, action
      FROM billing_cancel_commands ORDER BY id`);
    expect(commands.rows).toEqual([
      {
        id: commandId,
        organization_id: null,
        requested_by_user_id: null,
        job_id: null,
        organization_deletion_request_id: reserved.request.id,
        requesting_user_deletion_request_id: reserved.request.id,
        resource_type: "container",
        resource_id: "74000000-0000-4000-8000-000000000001",
        expected_lifecycle_revision: "7",
        action: "stop",
      },
      {
        id: historicalActorCommandId,
        organization_id: null,
        requested_by_user_id: otherUserId,
        job_id: null,
        organization_deletion_request_id: reserved.request.id,
        requesting_user_deletion_request_id: null,
        resource_type: "container",
        resource_id: "74000000-0000-4000-8000-000000000002",
        expected_lifecycle_revision: "8",
        action: "stop",
      },
      {
        id: crossOrganizationCommandId,
        organization_id: otherOrganizationId,
        requested_by_user_id: null,
        job_id: crossOrganizationJobId,
        organization_deletion_request_id: null,
        requesting_user_deletion_request_id: reserved.request.id,
        resource_type: "container",
        resource_id: "74000000-0000-4000-8000-000000000003",
        expected_lifecycle_revision: "9",
        action: "stop",
      },
    ]);
    const aliases = await dbWrite.execute(`SELECT organization_id, requested_by_user_id,
      organization_deletion_request_id, requesting_user_deletion_request_id,
      idempotency_key_hash, request_digest, command_id
      FROM billing_cancel_command_keys ORDER BY idempotency_key_hash`);
    expect(aliases.rows).toEqual([
      {
        organization_id: null,
        requested_by_user_id: null,
        organization_deletion_request_id: reserved.request.id,
        requesting_user_deletion_request_id: reserved.request.id,
        idempotency_key_hash: "a".repeat(64),
        request_digest: "c".repeat(64),
        command_id: commandId,
      },
      {
        organization_id: null,
        requested_by_user_id: null,
        organization_deletion_request_id: reserved.request.id,
        requesting_user_deletion_request_id: reserved.request.id,
        idempotency_key_hash: "b".repeat(64),
        request_digest: "c".repeat(64),
        command_id: commandId,
      },
      {
        organization_id: null,
        requested_by_user_id: otherUserId,
        organization_deletion_request_id: reserved.request.id,
        requesting_user_deletion_request_id: null,
        idempotency_key_hash: "c".repeat(64),
        request_digest: "c".repeat(64),
        command_id: commandId,
      },
      {
        organization_id: null,
        requested_by_user_id: otherUserId,
        organization_deletion_request_id: reserved.request.id,
        requesting_user_deletion_request_id: null,
        idempotency_key_hash: "d".repeat(64),
        request_digest: "e".repeat(64),
        command_id: historicalActorCommandId,
      },
      {
        organization_id: otherOrganizationId,
        requested_by_user_id: null,
        organization_deletion_request_id: null,
        requesting_user_deletion_request_id: reserved.request.id,
        idempotency_key_hash: "f".repeat(64),
        request_digest: "0".repeat(64),
        command_id: crossOrganizationCommandId,
      },
    ]);
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
    await expect(activateReservation("blocked")).resolves.toMatchObject({ outcome: "activated" });
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
