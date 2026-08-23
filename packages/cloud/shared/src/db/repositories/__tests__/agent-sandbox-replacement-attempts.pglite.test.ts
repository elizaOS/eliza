/**
 * Real-PGlite proofs for durable, one-shot sandbox replacement authority.
 * pushSchema supplies the table and a test-local trigger exercises immutable
 * guards that Drizzle's schema DSL cannot represent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { agentBackupRestoreLeases } from "../../schemas/agent-backup-catalog";
import { agentSandboxReplacementAttempts } from "../../schemas/agent-sandbox-replacement-attempts";
import {
  agentBackupCatalogAuthorities,
  agentSandboxBackups,
  agentSandboxes,
} from "../../schemas/agent-sandboxes";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import {
  type AgentSandboxReplacementAttemptReference,
  type AgentSandboxReplacementLocatorInput,
  type AgentSandboxReplacementRestoreAuthority,
  type CommitAgentSandboxReplacementLifecycleAdoptionInput,
  commitAgentSandboxReplacementLifecycleAdoptionInTransaction,
  getAgentSandboxReplacementAttempt,
  recordAgentSandboxReplacementCleanupProven,
  recordAgentSandboxReplacementCreated,
  recordAgentSandboxReplacementIntent,
  recordAgentSandboxReplacementLifecycleCommitted,
  recordAgentSandboxReplacementProviderSucceeded,
  recordAgentSandboxReplacementVpnRegistered,
  type StartAgentSandboxReplacementAttemptInput,
  startAgentSandboxReplacementAttempt,
} from "../agent-sandbox-replacement-attempts";

const TIMEOUT = 120_000;
const ORGANIZATION_ID = "00000000-0000-4000-8000-00000000a001";
const AGENT_ID = "00000000-0000-4000-8000-00000000a002";
const ATTEMPT_ID = "00000000-0000-4000-8000-00000000a003";
const OTHER_ATTEMPT_ID = "00000000-0000-4000-8000-00000000a004";
const ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000a005";
const NODE_RECORD_ID = "00000000-0000-4000-8000-00000000a006";
const LIFECYCLE_JOB_ID = "00000000-0000-4000-8000-00000000a007";
const LIFECYCLE_EXECUTION_GENERATION = "00000000-0000-4000-8000-00000000a008";
const BACKUP_ID = "00000000-0000-4000-8000-00000000a009";
const BACKUP_OPERATION_ID = "00000000-0000-4000-8000-00000000a00a";
const BACKUP_ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000a00b";
const RESTORE_ATTEMPT_ID = "00000000-0000-4000-8000-00000000a00c";
const RESTORE_LEASE_ID = "00000000-0000-4000-8000-00000000a00d";
const RESTORE_FENCE = "00000000-0000-4000-8000-00000000a00e";
const AGED_ATTEMPT_ID = "00000000-0000-4000-8000-00000000a012";
const AGED_ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000a013";
const CONTAINER_ID = "a".repeat(64);
const BACKUP_DIGEST = "9".repeat(64);
const PROVIDER_DIGEST = "b".repeat(64);
const LIFECYCLE_DIGEST = "c".repeat(64);
const CLEANUP_DIGEST = "d".repeat(64);
const CONTAINER_NAME = `agent-${AGENT_ID}`;

const reference = (attemptId = ATTEMPT_ID): AgentSandboxReplacementAttemptReference => ({
  attemptId,
  organizationId: ORGANIZATION_ID,
  agentId: AGENT_ID,
});

function startInput(
  overrides: Partial<StartAgentSandboxReplacementAttemptInput> = {},
): StartAgentSandboxReplacementAttemptInput {
  return {
    ...reference(),
    operationKind: "upgrade",
    lifecycleRevision: "7",
    activationGeneration: ACTIVATION_GENERATION,
    lifecycleJobId: LIFECYCLE_JOB_ID,
    lifecycleExecutionGeneration: LIFECYCLE_EXECUTION_GENERATION,
    restoreAuthority: null,
    ...overrides,
  };
}

function locator(
  stage: "intent" | "created" | "vpn" | "final",
  overrides: Partial<AgentSandboxReplacementLocatorInput> = {},
): AgentSandboxReplacementLocatorInput {
  const hasContainer = stage !== "intent";
  const hasVpn = stage === "vpn" || stage === "final";
  return {
    replacementAttemptId: ATTEMPT_ID,
    sandboxId: CONTAINER_NAME,
    nodeId: "robot-node-a",
    containerName: CONTAINER_NAME,
    nodeRecordId: NODE_RECORD_ID,
    nodeHostname: "robot-node-a.internal",
    nodeSshPort: 22,
    nodeSshUser: "root",
    nodeHostKeyFingerprint: "SHA256:test-only-pinned-host-key",
    replacementSecretCleanupVersion: 1,
    allocationCounted: true,
    vpnNodeName: CONTAINER_NAME,
    vpnRegistrationStartedAt: "2026-08-23T12:00:00.000Z",
    previousVpnNodeId: "41",
    containerId: hasContainer ? CONTAINER_ID : null,
    vpnNodeId: hasVpn ? "42" : null,
    ...overrides,
  };
}

function adoptionInput(
  attemptId = ATTEMPT_ID,
  overrides: Partial<CommitAgentSandboxReplacementLifecycleAdoptionInput> = {},
): CommitAgentSandboxReplacementLifecycleAdoptionInput {
  return {
    ...startInput({ attemptId }),
    locator: locator("final", { replacementAttemptId: attemptId }),
    providerReceiptDigest: PROVIDER_DIGEST,
    lifecycleReceiptDigest: LIFECYCLE_DIGEST,
    ...overrides,
  };
}

function rawSettledAttempt(input: {
  attemptId: string;
  activationGeneration: string;
  state: "provider_succeeded" | "cleanup_proven";
  locatorRecordedAt: Date;
  containerRecordedAt: Date;
  vpnRecordedAt: Date;
  settledAt: Date;
}): typeof agentSandboxReplacementAttempts.$inferInsert {
  return {
    id: input.attemptId,
    organization_id: ORGANIZATION_ID,
    agent_id: AGENT_ID,
    operation_kind: "upgrade",
    lifecycle_revision: 7n,
    activation_generation: input.activationGeneration,
    lifecycle_job_id: LIFECYCLE_JOB_ID,
    lifecycle_execution_generation: LIFECYCLE_EXECUTION_GENERATION,
    state: input.state,
    locator_sandbox_id: CONTAINER_NAME,
    locator_node_id: "robot-node-a",
    locator_container_name: CONTAINER_NAME,
    locator_node_record_id: NODE_RECORD_ID,
    locator_node_hostname: "robot-node-a.internal",
    locator_node_ssh_port: 22,
    locator_node_ssh_user: "root",
    locator_node_host_key_fingerprint: "SHA256:test-only-pinned-host-key",
    locator_secret_cleanup_version: 1,
    locator_allocation_counted: true,
    locator_vpn_node_name: CONTAINER_NAME,
    locator_vpn_registration_started_at: new Date("2026-08-23T11:59:00.000Z"),
    locator_previous_vpn_node_id: "41",
    locator_recorded_at: input.locatorRecordedAt,
    locator_container_id: CONTAINER_ID,
    locator_container_recorded_at: input.containerRecordedAt,
    locator_vpn_node_id: "42",
    locator_vpn_recorded_at: input.vpnRecordedAt,
    provider_succeeded_at: input.state === "provider_succeeded" ? input.settledAt : null,
    provider_receipt_digest: input.state === "provider_succeeded" ? PROVIDER_DIGEST : null,
    cleanup_proven_at: input.state === "cleanup_proven" ? input.settledAt : null,
    cleanup_receipt_digest: input.state === "cleanup_proven" ? CLEANUP_DIGEST : null,
    created_at: new Date("2026-08-23T11:58:00.000Z"),
    updated_at: input.settledAt,
  };
}

async function seedRestoreLease(): Promise<AgentSandboxReplacementRestoreAuthority> {
  const leaseCreatedAt = new Date(Date.now() - 60_000);
  const leaseExpiresAt = new Date(Date.now() + 600_000);
  await dbWrite
    .insert(agentBackupCatalogAuthorities)
    .values({ organization_id: ORGANIZATION_ID, agent_id: AGENT_ID, catalog_revision: 3n });
  await dbWrite.insert(agentSandboxBackups).values({
    id: BACKUP_ID,
    sandbox_record_id: null,
    snapshot_type: "auto",
    state_data: { memories: [], config: {}, workspaceFiles: {} },
    state_data_storage: "inline",
    size_bytes: 92,
    backup_kind: "full",
    backup_operation_id: BACKUP_OPERATION_ID,
    catalog_version: 2,
    catalog_state: "protected",
    catalog_payload_digest: BACKUP_DIGEST,
    catalog_revision: 3n,
    catalog_organization_id: ORGANIZATION_ID,
    catalog_agent_id: AGENT_ID,
    lifecycle_generation: BACKUP_ACTIVATION_GENERATION,
    lifecycle_revision: 6n,
    source_provider: "operator-onboarded",
    source_node_record_id: NODE_RECORD_ID,
    source_node_id: "backup-source-node",
    source_node_incarnation: "00000000-0000-4000-8000-00000000a00f",
    source_provider_server_id: null,
    source_provider_handle: "backup-source-handle",
    source_container_id: "8".repeat(64),
    retention_reason: "pre-upgrade",
    retention_until: new Date("2027-08-23T00:00:00.000Z"),
    manifest_format: "elizaos.agent-backup",
    manifest_version: 3,
    manifest_digest: BACKUP_DIGEST,
    manifest_canonical_draft: "{}",
    manifest_object_count: 1,
    object_inventory_digest: BACKUP_DIGEST,
    image_digest: `sha256:${BACKUP_DIGEST}`,
    database_schema_version: "1",
    plugin_set_digest: BACKUP_DIGEST,
    watermark_digest: BACKUP_DIGEST,
    raw_size_bytes: 1,
    compressed_size_bytes: 1,
    encrypted_size_bytes: 92,
    kms_key_id: `org:${ORGANIZATION_ID}/backup/v1`,
    kms_key_version: 1,
    operation_key_bundle_generation_id: "00000000-0000-4000-8000-00000000a010",
    operation_key_bundle_format: "kms-aead-operation-key-bundle-v1",
    operation_key_bundle_ref: `backup-key-bundle:${BACKUP_OPERATION_ID}`,
    operation_key_bundle_ciphertext_base64: Buffer.alloc(92, 0x44).toString("base64"),
    operation_key_bundle_sha256: BACKUP_DIGEST,
    operation_key_bundle_size_bytes: 92,
    operation_key_bundle_context: "{}",
    operation_key_bundle_context_derivation: "elizaos.agent-backup.operation-key-bundle-context.v1",
    operation_key_bundle_local_receipt_derivation:
      "elizaos.kms-aead-operation-key-bundle.local-receipt.v1",
    operation_key_bundle_local_receipt_digest: BACKUP_DIGEST,
    vault_key_generation_id: "00000000-0000-4000-8000-00000000a011",
    vault_key_authority_receipt_digest: BACKUP_DIGEST,
  });
  await dbWrite.insert(agentBackupRestoreLeases).values({
    id: RESTORE_LEASE_ID,
    organization_id: ORGANIZATION_ID,
    agent_id: AGENT_ID,
    backup_id: BACKUP_ID,
    operation_id: BACKUP_OPERATION_ID,
    activation_generation: BACKUP_ACTIVATION_GENERATION,
    lifecycle_revision: 6n,
    expected_manifest_sha256: BACKUP_DIGEST,
    copy_role: "primary",
    restore_attempt_id: RESTORE_ATTEMPT_ID,
    owner_id: "restore-worker",
    generation: RESTORE_FENCE,
    catalog_epoch: 3n,
    expires_at: leaseExpiresAt,
    created_at: leaseCreatedAt,
  });
  return {
    leaseId: RESTORE_LEASE_ID,
    backupId: BACKUP_ID,
    restoreAttemptId: RESTORE_ATTEMPT_ID,
    ownerId: "restore-worker",
    fencingToken: RESTORE_FENCE,
    catalogEpoch: "3",
    copyRole: "primary",
    operationId: BACKUP_OPERATION_ID,
    sourceActivationGeneration: BACKUP_ACTIVATION_GENERATION,
    sourceLifecycleRevision: "6",
    expectedManifestSha256: BACKUP_DIGEST,
    expiresAt: leaseExpiresAt,
  };
}

/** Install the database-level guards that Drizzle's table DSL cannot express. */
async function installReplacementAttemptGuards(): Promise<void> {
  await dbWrite.execute(
    sql.raw(`
    CREATE FUNCTION guard_agent_sandbox_replacement_attempt() RETURNS trigger
    LANGUAGE plpgsql AS $guard$
    BEGIN
      IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'replacement attempts cannot be truncated';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'replacement attempts cannot be deleted';
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'in_flight_unresolved'
          OR num_nonnulls(
            NEW.locator_sandbox_id, NEW.locator_node_id, NEW.locator_container_name,
            NEW.locator_node_record_id, NEW.locator_node_hostname, NEW.locator_node_ssh_port,
            NEW.locator_node_ssh_user, NEW.locator_node_host_key_fingerprint,
            NEW.locator_secret_cleanup_version, NEW.locator_allocation_counted,
            NEW.locator_vpn_node_name, NEW.locator_vpn_registration_started_at,
            NEW.locator_previous_vpn_node_id, NEW.locator_recorded_at,
            NEW.locator_container_id, NEW.locator_container_recorded_at,
            NEW.locator_vpn_node_id, NEW.locator_vpn_recorded_at,
            NEW.provider_succeeded_at, NEW.provider_receipt_digest,
            NEW.lifecycle_committed_at, NEW.lifecycle_receipt_digest,
            NEW.cleanup_proven_at, NEW.cleanup_receipt_digest
          ) <> 0 THEN
          RAISE EXCEPTION 'replacement attempt must start before any provider evidence';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.state IN ('lifecycle_committed', 'cleanup_proven') THEN
        RAISE EXCEPTION 'terminal replacement attempt is immutable';
      END IF;
      IF NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'replacement attempt timestamp cannot rewind';
      END IF;
      IF ROW(
          OLD.id, OLD.organization_id, OLD.agent_id, OLD.operation_kind,
          OLD.lifecycle_revision, OLD.activation_generation, OLD.lifecycle_job_id,
          OLD.lifecycle_execution_generation, OLD.restore_lease_id, OLD.restore_backup_id,
          OLD.restore_attempt_id, OLD.restore_lease_owner_id, OLD.restore_lease_generation,
          OLD.restore_catalog_epoch, OLD.restore_copy_role, OLD.restore_operation_id,
          OLD.restore_source_activation_generation, OLD.restore_source_lifecycle_revision,
          OLD.restore_manifest_sha256, OLD.restore_lease_expires_at, OLD.created_at
        ) IS DISTINCT FROM ROW(
          NEW.id, NEW.organization_id, NEW.agent_id, NEW.operation_kind,
          NEW.lifecycle_revision, NEW.activation_generation, NEW.lifecycle_job_id,
          NEW.lifecycle_execution_generation, NEW.restore_lease_id, NEW.restore_backup_id,
          NEW.restore_attempt_id, NEW.restore_lease_owner_id, NEW.restore_lease_generation,
          NEW.restore_catalog_epoch, NEW.restore_copy_role, NEW.restore_operation_id,
          NEW.restore_source_activation_generation, NEW.restore_source_lifecycle_revision,
          NEW.restore_manifest_sha256, NEW.restore_lease_expires_at, NEW.created_at
        ) THEN
        RAISE EXCEPTION 'replacement attempt identity is immutable';
      END IF;

      IF OLD.locator_recorded_at IS NULL THEN
        IF NEW.locator_recorded_at IS NOT NULL
          AND (NEW.locator_container_id IS NOT NULL OR NEW.locator_vpn_node_id IS NOT NULL) THEN
          RAISE EXCEPTION 'replacement locator enrichments cannot skip intent';
        END IF;
      ELSIF ROW(
          OLD.locator_sandbox_id, OLD.locator_node_id, OLD.locator_container_name,
          OLD.locator_node_record_id, OLD.locator_node_hostname, OLD.locator_node_ssh_port,
          OLD.locator_node_ssh_user, OLD.locator_node_host_key_fingerprint,
          OLD.locator_secret_cleanup_version, OLD.locator_allocation_counted,
          OLD.locator_vpn_node_name, OLD.locator_vpn_registration_started_at,
          OLD.locator_previous_vpn_node_id, OLD.locator_recorded_at
        ) IS DISTINCT FROM ROW(
          NEW.locator_sandbox_id, NEW.locator_node_id, NEW.locator_container_name,
          NEW.locator_node_record_id, NEW.locator_node_hostname, NEW.locator_node_ssh_port,
          NEW.locator_node_ssh_user, NEW.locator_node_host_key_fingerprint,
          NEW.locator_secret_cleanup_version, NEW.locator_allocation_counted,
          NEW.locator_vpn_node_name, NEW.locator_vpn_registration_started_at,
          NEW.locator_previous_vpn_node_id, NEW.locator_recorded_at
        ) THEN
        RAISE EXCEPTION 'replacement locator identity is immutable';
      END IF;

      IF OLD.locator_container_id IS NULL THEN
        IF NEW.locator_container_id IS NOT NULL AND OLD.locator_recorded_at IS NULL THEN
          RAISE EXCEPTION 'replacement Docker enrichment requires durable intent';
        END IF;
      ELSIF ROW(OLD.locator_container_id, OLD.locator_container_recorded_at)
        IS DISTINCT FROM ROW(NEW.locator_container_id, NEW.locator_container_recorded_at) THEN
        RAISE EXCEPTION 'replacement Docker enrichment is immutable';
      END IF;
      IF OLD.locator_vpn_node_id IS NULL THEN
        IF NEW.locator_vpn_node_id IS NOT NULL AND OLD.locator_container_id IS NULL THEN
          RAISE EXCEPTION 'replacement VPN enrichment requires durable Docker identity';
        END IF;
      ELSIF ROW(OLD.locator_vpn_node_id, OLD.locator_vpn_recorded_at)
        IS DISTINCT FROM ROW(NEW.locator_vpn_node_id, NEW.locator_vpn_recorded_at) THEN
        RAISE EXCEPTION 'replacement VPN enrichment is immutable';
      END IF;

      IF OLD.provider_succeeded_at IS NOT NULL
        AND ROW(OLD.provider_succeeded_at, OLD.provider_receipt_digest)
          IS DISTINCT FROM ROW(NEW.provider_succeeded_at, NEW.provider_receipt_digest) THEN
        RAISE EXCEPTION 'replacement provider receipt is immutable';
      END IF;
      IF OLD.lifecycle_committed_at IS NOT NULL
        AND ROW(OLD.lifecycle_committed_at, OLD.lifecycle_receipt_digest)
          IS DISTINCT FROM ROW(NEW.lifecycle_committed_at, NEW.lifecycle_receipt_digest) THEN
        RAISE EXCEPTION 'replacement lifecycle receipt is immutable';
      END IF;
      IF OLD.cleanup_proven_at IS NOT NULL
        AND ROW(OLD.cleanup_proven_at, OLD.cleanup_receipt_digest)
          IS DISTINCT FROM ROW(NEW.cleanup_proven_at, NEW.cleanup_receipt_digest) THEN
        RAISE EXCEPTION 'replacement cleanup receipt is immutable';
      END IF;

      IF NOT (
        NEW.state = OLD.state
        OR (OLD.state = 'in_flight_unresolved'
          AND NEW.state IN ('provider_succeeded', 'cleanup_proven'))
        OR (OLD.state = 'provider_succeeded'
          AND NEW.state IN ('lifecycle_committed', 'cleanup_proven'))
      ) THEN
        RAISE EXCEPTION 'replacement attempt state transition is not monotonic';
      END IF;
      IF OLD.state = 'in_flight_unresolved' AND NEW.state = 'provider_succeeded'
        AND (OLD.locator_recorded_at IS NULL OR OLD.locator_container_id IS NULL) THEN
        RAISE EXCEPTION 'provider success requires previously durable exact placement';
      END IF;
      IF OLD.state <> 'in_flight_unresolved'
        AND ROW(
          OLD.locator_sandbox_id, OLD.locator_node_id, OLD.locator_container_name,
          OLD.locator_node_record_id, OLD.locator_node_hostname, OLD.locator_node_ssh_port,
          OLD.locator_node_ssh_user, OLD.locator_node_host_key_fingerprint,
          OLD.locator_secret_cleanup_version, OLD.locator_allocation_counted,
          OLD.locator_vpn_node_name, OLD.locator_vpn_registration_started_at,
          OLD.locator_previous_vpn_node_id, OLD.locator_recorded_at,
          OLD.locator_container_id, OLD.locator_container_recorded_at,
          OLD.locator_vpn_node_id, OLD.locator_vpn_recorded_at
        ) IS DISTINCT FROM ROW(
          NEW.locator_sandbox_id, NEW.locator_node_id, NEW.locator_container_name,
          NEW.locator_node_record_id, NEW.locator_node_hostname, NEW.locator_node_ssh_port,
          NEW.locator_node_ssh_user, NEW.locator_node_host_key_fingerprint,
          NEW.locator_secret_cleanup_version, NEW.locator_allocation_counted,
          NEW.locator_vpn_node_name, NEW.locator_vpn_registration_started_at,
          NEW.locator_previous_vpn_node_id, NEW.locator_recorded_at,
          NEW.locator_container_id, NEW.locator_container_recorded_at,
          NEW.locator_vpn_node_id, NEW.locator_vpn_recorded_at
        ) THEN
        RAISE EXCEPTION 'settled replacement locator is immutable';
      END IF;
      RETURN NEW;
    END;
    $guard$;
  `),
  );
  await dbWrite.execute(
    sql.raw(`
      CREATE TRIGGER agent_sandbox_replacement_attempts_guard_row
        BEFORE INSERT OR UPDATE OR DELETE ON agent_sandbox_replacement_attempts
        FOR EACH ROW EXECUTE FUNCTION guard_agent_sandbox_replacement_attempt()
    `),
  );
  await dbWrite.execute(
    sql.raw(`
      CREATE TRIGGER agent_sandbox_replacement_attempts_guard_truncate
        BEFORE TRUNCATE ON agent_sandbox_replacement_attempts
        FOR EACH STATEMENT EXECUTE FUNCTION guard_agent_sandbox_replacement_attempt()
    `),
  );
}

let schemaFailure = "";

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    schemaFailure = "isolated PGlite is required; refusing to mutate an ambient Postgres database";
    return;
  }
  try {
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        agentSandboxes,
        agentSandboxBackups,
        agentBackupCatalogAuthorities,
        agentBackupRestoreLeases,
        agentSandboxReplacementAttempts,
      } as never,
      dbWrite as never,
    );
    await apply();
    await installReplacementAttemptGuards();
  } catch (error) {
    // error-policy:J1 Test setup fails every case loudly instead of skipping DB proofs.
    const cause = (error as { cause?: unknown }).cause;
    schemaFailure = `${error instanceof Error ? error.message : String(error)}; cause: ${
      cause instanceof Error ? cause.message : String(cause ?? "unknown")
    }`;
  }
}, TIMEOUT);

beforeEach(async () => {
  expect(schemaFailure).toBe("");
  await dbWrite.execute(
    sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
      DISABLE TRIGGER agent_sandbox_replacement_attempts_guard_row`),
  );
  await dbWrite.execute(
    sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
      DISABLE TRIGGER agent_sandbox_replacement_attempts_guard_truncate`),
  );
  await dbWrite.delete(agentSandboxReplacementAttempts);
  await dbWrite.delete(agentBackupRestoreLeases);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentBackupCatalogAuthorities);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
  await dbWrite.execute(
    sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
      ENABLE TRIGGER agent_sandbox_replacement_attempts_guard_row`),
  );
  await dbWrite.execute(
    sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
      ENABLE TRIGGER agent_sandbox_replacement_attempts_guard_truncate`),
  );
  await dbWrite.insert(organizations).values({
    id: ORGANIZATION_ID,
    name: "Replacement attempt tests",
    slug: "replacement-attempt-tests",
  });
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("agent sandbox replacement attempts", () => {
  test("rejects malformed or partial authority and never reuses a caller attempt ID", async () => {
    await expect(
      startAgentSandboxReplacementAttempt(startInput({ operationKind: "replace" as "upgrade" })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      startAgentSandboxReplacementAttempt(startInput({ lifecycleExecutionGeneration: null })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          restoreAuthority: {
            leaseId: RESTORE_LEASE_ID,
          } as AgentSandboxReplacementRestoreAuthority,
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });

    await startAgentSandboxReplacementAttempt(startInput());
    await expect(startAgentSandboxReplacementAttempt(startInput())).rejects.toMatchObject({
      code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    });
    expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(1);
  });

  test("serializes concurrent active ownership and keeps provider success fenced", async () => {
    const contenders = await Promise.allSettled([
      startAgentSandboxReplacementAttempt(startInput()),
      startAgentSandboxReplacementAttempt(startInput({ attemptId: OTHER_ATTEMPT_ID })),
    ]);
    expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(contenders.filter((result) => result.status === "rejected")).toHaveLength(1);

    const [owned] = await dbWrite.select().from(agentSandboxReplacementAttempts);
    if (!owned) throw new Error("Expected one active replacement attempt");
    await persistSuccessfulProviderAttemptAfterExistingStart(owned.id);
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          attemptId: owned.id === ATTEMPT_ID ? OTHER_ATTEMPT_ID : ATTEMPT_ID,
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("rejects partial locators and immutable Docker or VPN enrichment drift", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await expect(
      recordAgentSandboxReplacementCreated(reference(), locator("created")),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", { allocationCounted: false as true }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", { replacementSecretCleanupVersion: 2 as 1 }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", { nodeHostKeyFingerprint: "" }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", { vpnRegistrationStartedAt: null }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });

    await recordAgentSandboxReplacementIntent(reference(), locator("intent"));
    await recordAgentSandboxReplacementCreated(reference(), locator("created"));
    await expect(
      recordAgentSandboxReplacementCreated(
        reference(),
        locator("created", { containerId: "f".repeat(64) }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      recordAgentSandboxReplacementProviderSucceeded(
        reference(),
        locator("final", { vpnNodeId: null }),
        PROVIDER_DIGEST,
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_INVALID_INPUT" });
    await recordAgentSandboxReplacementVpnRegistered(reference(), locator("vpn"));
    await expect(
      recordAgentSandboxReplacementVpnRegistered(reference(), locator("vpn", { vpnNodeId: "43" })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("makes exact stage and receipt replays idempotent and rejects conflicting bytes", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    expect(
      (await recordAgentSandboxReplacementIntent(reference(), locator("intent"))).replayed,
    ).toBe(false);
    expect(
      (await recordAgentSandboxReplacementIntent(reference(), locator("intent"))).replayed,
    ).toBe(true);
    await expect(
      recordAgentSandboxReplacementIntent(
        reference(),
        locator("intent", { nodeHostname: "drifted.internal" }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    await recordAgentSandboxReplacementCreated(reference(), locator("created"));
    expect(
      (await recordAgentSandboxReplacementCreated(reference(), locator("created"))).replayed,
    ).toBe(true);
    await recordAgentSandboxReplacementVpnRegistered(reference(), locator("vpn"));
    expect(
      (await recordAgentSandboxReplacementVpnRegistered(reference(), locator("vpn"))).replayed,
    ).toBe(true);

    expect(
      (
        await recordAgentSandboxReplacementProviderSucceeded(
          reference(),
          locator("final"),
          PROVIDER_DIGEST,
        )
      ).replayed,
    ).toBe(false);
    expect(
      (
        await recordAgentSandboxReplacementProviderSucceeded(
          reference(),
          locator("final"),
          PROVIDER_DIGEST,
        )
      ).replayed,
    ).toBe(true);
    await expect(
      recordAgentSandboxReplacementProviderSucceeded(reference(), locator("final"), "e".repeat(64)),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    expect((await recordAgentSandboxReplacementLifecycleCommitted(adoptionInput())).replayed).toBe(
      false,
    );
    expect((await recordAgentSandboxReplacementLifecycleCommitted(adoptionInput())).replayed).toBe(
      true,
    );
    await expect(
      recordAgentSandboxReplacementCleanupProven(reference(), CLEANUP_DIGEST),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      recordAgentSandboxReplacementIntent(reference(), locator("intent")),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    const retained = await getAgentSandboxReplacementAttempt(reference());
    expect(retained).toMatchObject({
      state: "lifecycle_committed",
      provider_receipt_digest: PROVIDER_DIGEST,
      lifecycle_receipt_digest: LIFECYCLE_DIGEST,
    });
    await expect(startAgentSandboxReplacementAttempt(startInput())).rejects.toMatchObject({
      code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    });
  });

  test("rolls lifecycle adoption back with its caller transaction and strictly replays it", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await persistSuccessfulProviderAttemptAfterExistingStart(ATTEMPT_ID);

    await expect(
      dbWrite.transaction(async (tx) => {
        const consumed = await commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput(),
        );
        expect(consumed.attempt.state).toBe("lifecycle_committed");
        throw new Error("force outer lifecycle rollback");
      }),
    ).rejects.toThrow("force outer lifecycle rollback");
    expect((await getAgentSandboxReplacementAttempt(reference()))?.state).toBe(
      "provider_succeeded",
    );

    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput(ATTEMPT_ID, { operationKind: "downgrade" }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    const committed = await dbWrite.transaction((tx) =>
      commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, adoptionInput()),
    );
    expect(committed.replayed).toBe(false);
    const replayed = await dbWrite.transaction((tx) =>
      commitAgentSandboxReplacementLifecycleAdoptionInTransaction(tx, adoptionInput()),
    );
    expect(replayed.replayed).toBe(true);
    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput(ATTEMPT_ID, { lifecycleReceiptDigest: "e".repeat(64) }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput(ATTEMPT_ID, { providerReceiptDigest: "f".repeat(64) }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("freezes exact live restore authority and never expires the replacement fence with its lease", async () => {
    const restoreAuthority = await seedRestoreLease();
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          restoreAuthority: {
            ...restoreAuthority,
            expiresAt: new Date(restoreAuthority.expiresAt.getTime() + 1),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    const started = await startAgentSandboxReplacementAttempt(startInput({ restoreAuthority }));
    expect(started.attempt).toMatchObject({
      restore_lease_id: RESTORE_LEASE_ID,
      restore_backup_id: BACKUP_ID,
      restore_attempt_id: RESTORE_ATTEMPT_ID,
      restore_lease_generation: RESTORE_FENCE,
      restore_catalog_epoch: 3n,
      restore_copy_role: "primary",
      restore_operation_id: BACKUP_OPERATION_ID,
      restore_source_activation_generation: BACKUP_ACTIVATION_GENERATION,
      restore_source_lifecycle_revision: 6n,
      restore_manifest_sha256: BACKUP_DIGEST,
    });
    expect(started.attempt.restore_lease_expires_at?.getTime()).toBe(
      restoreAuthority.expiresAt.getTime(),
    );

    await dbWrite
      .update(agentBackupRestoreLeases)
      .set({ expires_at: new Date(Date.now() - 1_000), released_at: new Date() })
      .where(eq(agentBackupRestoreLeases.id, RESTORE_LEASE_ID));
    expect((await getAgentSandboxReplacementAttempt(reference()))?.state).toBe(
      "in_flight_unresolved",
    );
    await expect(
      startAgentSandboxReplacementAttempt(startInput({ attemptId: OTHER_ATTEMPT_ID })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    await persistSuccessfulProviderAttemptAfterExistingStart(ATTEMPT_ID);
    await expect(
      dbWrite.transaction((tx) =>
        commitAgentSandboxReplacementLifecycleAdoptionInTransaction(
          tx,
          adoptionInput(ATTEMPT_ID, {
            restoreAuthority: {
              ...restoreAuthority,
              expiresAt: new Date(restoreAuthority.expiresAt.getTime() + 1),
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect(
      (
        await recordAgentSandboxReplacementLifecycleCommitted(
          adoptionInput(ATTEMPT_ID, { restoreAuthority }),
        )
      ).attempt.state,
    ).toBe("lifecycle_committed");
  });

  test("allows only the two cleanup paths and never reopens either terminal state", async () => {
    await startAgentSandboxReplacementAttempt(startInput());
    await expect(
      recordAgentSandboxReplacementLifecycleCommitted(adoptionInput()),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    expect(
      (await recordAgentSandboxReplacementCleanupProven(reference(), CLEANUP_DIGEST)).replayed,
    ).toBe(false);
    expect(
      (await recordAgentSandboxReplacementCleanupProven(reference(), CLEANUP_DIGEST)).replayed,
    ).toBe(true);
    await expect(
      recordAgentSandboxReplacementCleanupProven(reference(), "e".repeat(64)),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      recordAgentSandboxReplacementProviderSucceeded(
        reference(),
        locator("final"),
        PROVIDER_DIGEST,
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });

    await startAgentSandboxReplacementAttempt(startInput({ attemptId: OTHER_ATTEMPT_ID }));
    await persistSuccessfulProviderAttemptAfterExistingStart(OTHER_ATTEMPT_ID);
    const otherReference = reference(OTHER_ATTEMPT_ID);
    expect(
      (await recordAgentSandboxReplacementCleanupProven(otherReference, CLEANUP_DIGEST)).attempt
        .state,
    ).toBe("cleanup_proven");
    await expect(
      recordAgentSandboxReplacementLifecycleCommitted(adoptionInput(OTHER_ATTEMPT_ID)),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
    await expect(
      startAgentSandboxReplacementAttempt(startInput({ attemptId: OTHER_ATTEMPT_ID })),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("does not clear an unresolved attempt because its durable row is old", async () => {
    const oldTimestamp = new Date("2025-08-23T00:00:00.000Z");
    await dbWrite.insert(agentSandboxReplacementAttempts).values({
      id: AGED_ATTEMPT_ID,
      organization_id: ORGANIZATION_ID,
      agent_id: AGENT_ID,
      operation_kind: "provision",
      lifecycle_revision: 0n,
      activation_generation: AGED_ACTIVATION_GENERATION,
      lifecycle_job_id: null,
      lifecycle_execution_generation: null,
      created_at: oldTimestamp,
      updated_at: oldTimestamp,
    });

    expect(
      (await getAgentSandboxReplacementAttempt(reference(AGED_ATTEMPT_ID)))?.created_at,
    ).toEqual(oldTimestamp);
    await expect(
      startAgentSandboxReplacementAttempt(
        startInput({
          attemptId: OTHER_ATTEMPT_ID,
          activationGeneration: AGED_ACTIVATION_GENERATION,
        }),
      ),
    ).rejects.toMatchObject({ code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT" });
  });

  test("rejects raw settlement timestamps that precede the last durable locator stage", async () => {
    const locatorRecordedAt = new Date("2026-08-23T12:00:00.000Z");
    const containerRecordedAt = new Date("2026-08-23T12:01:00.000Z");
    const vpnRecordedAt = new Date("2026-08-23T12:02:00.000Z");
    await dbWrite.execute(
      sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
        DISABLE TRIGGER agent_sandbox_replacement_attempts_guard_row`),
    );
    try {
      const invalidRows: (typeof agentSandboxReplacementAttempts.$inferInsert)[] = [
        rawSettledAttempt({
          attemptId: "00000000-0000-4000-8000-00000000a014",
          activationGeneration: "00000000-0000-4000-8000-00000000a017",
          state: "provider_succeeded",
          locatorRecordedAt,
          containerRecordedAt,
          vpnRecordedAt: new Date("2026-08-23T12:00:30.000Z"),
          settledAt: new Date("2026-08-23T12:03:00.000Z"),
        }),
        rawSettledAttempt({
          attemptId: "00000000-0000-4000-8000-00000000a015",
          activationGeneration: "00000000-0000-4000-8000-00000000a018",
          state: "provider_succeeded",
          locatorRecordedAt,
          containerRecordedAt,
          vpnRecordedAt,
          settledAt: new Date("2026-08-23T12:01:30.000Z"),
        }),
        rawSettledAttempt({
          attemptId: "00000000-0000-4000-8000-00000000a016",
          activationGeneration: "00000000-0000-4000-8000-00000000a019",
          state: "cleanup_proven",
          locatorRecordedAt,
          containerRecordedAt,
          vpnRecordedAt,
          settledAt: new Date("2026-08-23T12:01:30.000Z"),
        }),
        {
          ...rawSettledAttempt({
            attemptId: "00000000-0000-4000-8000-00000000a020",
            activationGeneration: "00000000-0000-4000-8000-00000000a021",
            state: "provider_succeeded",
            locatorRecordedAt,
            containerRecordedAt,
            vpnRecordedAt,
            settledAt: new Date("2026-08-23T12:03:00.000Z"),
          }),
          locator_vpn_node_id: null,
          locator_vpn_recorded_at: null,
        },
      ];
      for (const row of invalidRows) {
        await expect(
          (async () => {
            await dbWrite.insert(agentSandboxReplacementAttempts).values(row);
          })(),
        ).rejects.toThrow();
      }
      expect(await dbWrite.select().from(agentSandboxReplacementAttempts)).toHaveLength(0);
    } finally {
      await dbWrite.execute(
        sql.raw(`ALTER TABLE agent_sandbox_replacement_attempts
          ENABLE TRIGGER agent_sandbox_replacement_attempts_guard_row`),
      );
    }
  });

  test("rejects raw identity tamper, state rewind, terminal mutation, delete, and reuse", async () => {
    await expect(
      (async () => {
        await dbWrite.insert(agentSandboxReplacementAttempts).values({
          id: ATTEMPT_ID,
          organization_id: ORGANIZATION_ID,
          agent_id: AGENT_ID,
          operation_kind: "upgrade",
          lifecycle_revision: 7n,
          activation_generation: ACTIVATION_GENERATION,
          lifecycle_job_id: LIFECYCLE_JOB_ID,
          lifecycle_execution_generation: LIFECYCLE_EXECUTION_GENERATION,
          state: "cleanup_proven",
          cleanup_proven_at: new Date(),
          cleanup_receipt_digest: CLEANUP_DIGEST,
        });
      })(),
    ).rejects.toThrow();

    await startAgentSandboxReplacementAttempt(startInput());
    await recordAgentSandboxReplacementIntent(reference(), locator("intent"));
    await expect(
      (async () => {
        await dbWrite
          .update(agentSandboxReplacementAttempts)
          .set({ lifecycle_revision: 8n })
          .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID));
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite
          .update(agentSandboxReplacementAttempts)
          .set({ locator_node_hostname: "drifted.internal" })
          .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID));
      })(),
    ).rejects.toThrow();

    await recordAgentSandboxReplacementCreated(reference(), locator("created"));
    await recordAgentSandboxReplacementVpnRegistered(reference(), locator("vpn"));
    await recordAgentSandboxReplacementProviderSucceeded(
      reference(),
      locator("final"),
      PROVIDER_DIGEST,
    );
    await expect(
      (async () => {
        await dbWrite
          .update(agentSandboxReplacementAttempts)
          .set({
            state: "in_flight_unresolved",
            provider_succeeded_at: null,
            provider_receipt_digest: null,
          })
          .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID));
      })(),
    ).rejects.toThrow();

    await recordAgentSandboxReplacementLifecycleCommitted(adoptionInput());
    await expect(
      (async () => {
        await dbWrite
          .update(agentSandboxReplacementAttempts)
          .set({ updated_at: new Date() })
          .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID));
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite
          .delete(agentSandboxReplacementAttempts)
          .where(eq(agentSandboxReplacementAttempts.id, ATTEMPT_ID));
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite.execute(sql.raw("TRUNCATE TABLE agent_sandbox_replacement_attempts"));
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await dbWrite.delete(organizations).where(eq(organizations.id, ORGANIZATION_ID));
      })(),
    ).rejects.toThrow();
    await expect(startAgentSandboxReplacementAttempt(startInput())).rejects.toMatchObject({
      code: "AGENT_SANDBOX_REPLACEMENT_ATTEMPT_CONFLICT",
    });
  });
});

async function persistSuccessfulProviderAttemptAfterExistingStart(
  attemptId: string,
): Promise<void> {
  const attemptReference = reference(attemptId);
  await recordAgentSandboxReplacementIntent(
    attemptReference,
    locator("intent", { replacementAttemptId: attemptId }),
  );
  await recordAgentSandboxReplacementCreated(
    attemptReference,
    locator("created", { replacementAttemptId: attemptId }),
  );
  await recordAgentSandboxReplacementVpnRegistered(
    attemptReference,
    locator("vpn", { replacementAttemptId: attemptId }),
  );
  await recordAgentSandboxReplacementProviderSucceeded(
    attemptReference,
    locator("final", { replacementAttemptId: attemptId }),
    PROVIDER_DIGEST,
  );
}
