/**
 * Locks the staging canary workflow's trigger, privacy, cleanup, and deployment
 * provenance contracts using parsed YAML and disposable Git histories.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sanitizeManagedDedicatedCanaryDiagnostic } from "../cloud/admin/managed-dedicated-canary-diagnostic";

const workflowPath = new URL(
  "../../../.github/workflows/managed-dedicated-canary.yml",
  import.meta.url,
);
const workflowSource = readFileSync(workflowPath, "utf8");
const warmFenceMigration = readFileSync(
  new URL(
    "../../cloud/shared/src/db/migrations/0182_warm_claim_credential_fence.sql",
    import.meta.url,
  ),
  "utf8",
);
const rollbackStandbyMigration = readFileSync(
  new URL(
    "../../cloud/shared/src/db/migrations/0189_rollback_standby_state.sql",
    import.meta.url,
  ),
  "utf8",
);
const restoreValidationMigration = readFileSync(
  new URL(
    "../../cloud/shared/src/db/migrations/0190_agent_snapshot_restore_validations.sql",
    import.meta.url,
  ),
  "utf8",
);

const frozenConstraintFingerprints = [
  "3f7d442d7cd6a8fea1b68ab42c707a8b",
  "3f30c7b71231f35d83b9944c7d86fb4a",
  "78828e000fbf77c896528abf07f0cac0",
  "53d7fed6ce39d4e7fd81bdd40507405c",
] as const;

interface WorkflowStep {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  if?: string;
  environment?: string;
  "timeout-minutes"?: number;
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Record<string, unknown>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, WorkflowJob>;
}

const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const job = workflow.jobs?.canary;
const diagnoseJob = workflow.jobs?.diagnose;

function step(name: string): WorkflowStep {
  const found = job?.steps?.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing workflow step: ${name}`);
  return found;
}

function diagnoseStep(name: string): WorkflowStep {
  const found = diagnoseJob?.steps?.find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`Missing diagnostic workflow step: ${name}`);
  return found;
}

function runGit(cwd: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function commitFixture(cwd: string, label: string): string {
  writeFileSync(join(cwd, "fixture.txt"), `${label}\n`, { flag: "a" });
  expect(runGit(cwd, ["add", "fixture.txt"]).status).toBe(0);
  const commit = runGit(cwd, ["commit", "-m", label]);
  expect(commit.status, commit.stderr).toBe(0);
  const rev = runGit(cwd, ["rev-parse", "HEAD"]);
  expect(rev.status, rev.stderr).toBe(0);
  return rev.stdout.trim();
}

const diagnosticFixtureSchema = `
  CREATE TABLE agent_sandboxes (
    id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    agent_name text NOT NULL,
    status text NOT NULL,
    error_message text,
    error_count integer NOT NULL DEFAULT 0,
    sandbox_id text,
    node_id text,
    container_name text,
    docker_image text,
    image_digest text,
    environment_revision integer NOT NULL DEFAULT 1,
    claimed_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL DEFAULT now()
  );
  CREATE TABLE jobs (
    id uuid PRIMARY KEY,
    type text NOT NULL,
    status text NOT NULL,
    data jsonb NOT NULL,
    data_storage text NOT NULL DEFAULT 'inline',
    result jsonb,
    result_storage text NOT NULL DEFAULT 'inline',
    error text,
    error_storage text NOT NULL DEFAULT 'inline',
    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 3,
    organization_id uuid NOT NULL,
    user_id uuid,
    agent_id text,
    scheduled_for timestamp without time zone NOT NULL DEFAULT now(),
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    created_at timestamp without time zone NOT NULL DEFAULT now(),
    updated_at timestamp without time zone NOT NULL DEFAULT now()
  );
  CREATE TABLE agent_sandbox_backups (
    id uuid PRIMARY KEY,
    sandbox_record_id uuid NOT NULL,
    snapshot_type text NOT NULL,
    snapshot_schema_version integer NOT NULL DEFAULT 1,
    verification_status text,
    verified_at timestamp with time zone,
    verification_error text,
    storage_commit_state text NOT NULL DEFAULT 'complete',
    content_hash text
  );
`;

function diagnosticSql(): string {
  const run = diagnoseStep("Query exact stale canary read-only").run ?? "";
  const sql = run.match(/<<'SQL'\n([\s\S]*?)\nSQL/)?.[1];
  if (!sql) throw new Error("diagnostic SQL heredoc is missing");
  return sql.replaceAll(":'suffix'", "'r12345678a1'");
}

async function createDiagnosticDatabase(): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(diagnosticFixtureSchema);
  await database.exec(warmFenceMigration);
  await database.exec(rollbackStandbyMigration);
  await database.exec(restoreValidationMigration);
  await database.exec(`
    INSERT INTO agent_sandboxes (
      id,
      organization_id,
      user_id,
      agent_name,
      status,
      error_message,
      error_count,
      sandbox_id,
      node_id,
      container_name,
      docker_image,
      image_digest
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      'managed-dedicated-canary-r12345678a1',
      'running',
      NULL,
      0,
      'sandbox',
      'node',
      'container',
      'ghcr.io/elizaos/eliza-agent',
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
  `);
  return database;
}

async function seedPausedRestoreValidation(
  database: PGlite,
  identityMatches = true,
): Promise<void> {
  const sourceJobId = "44444444-4444-4444-8444-444444444444";
  const rolloutId = "55555555-5555-4555-8555-555555555555";
  await database.exec(`
    UPDATE agent_sandboxes
    SET
      docker_image =
        'ghcr.io/elizaos/eliza-demo@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      image_digest =
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      rollback_standby_state = 'paused',
      rollback_standby_generation = '${sourceJobId}',
      rollback_standby_rollout_id = '${rolloutId}',
      rollback_standby_source_job_id = '${sourceJobId}',
      rollback_standby_sandbox_id = 'standby-sandbox',
      rollback_standby_node_id = 'standby-node',
      rollback_standby_container_name = 'standby-container',
      rollback_standby_container_id = 'standby-container-id',
      rollback_standby_bridge_url = 'http://standby:3000',
      rollback_standby_health_url = 'http://standby:3000/health',
      rollback_standby_bridge_port = 3000,
      rollback_standby_web_ui_port = 3001,
      rollback_standby_vpn_node_id = 'standby-vpn',
      rollback_standby_docker_image = 'ghcr.io/elizaos/eliza-agent',
      rollback_standby_image_digest =
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      rollback_standby_environment_revision = 1,
      rollback_standby_allocation_counted = TRUE,
      rollback_standby_primary_sandbox_id = 'sandbox',
      rollback_standby_primary_node_id = 'node',
      rollback_standby_primary_container_name = 'container',
      rollback_standby_primary_container_id = 'primary-container-id',
      rollback_standby_primary_vpn_node_id = 'primary-vpn',
      rollback_standby_primary_replacement_attempt_id =
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      rollback_standby_created_at = '2026-07-26T23:10:00.000Z';

    INSERT INTO jobs (
      id,
      type,
      status,
      data,
      result,
      organization_id,
      user_id,
      agent_id,
      started_at,
      completed_at,
      created_at,
      updated_at
    ) VALUES (
      '${sourceJobId}',
      'agent_admin_canary_image',
      'completed',
      jsonb_build_object(
        'agentId', '11111111-1111-4111-8111-111111111111',
        'organizationId', '22222222-2222-4222-8222-222222222222',
        'targetOwnerUserId', '33333333-3333-4333-8333-333333333333',
        'actorUserId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'userId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'decisionAt', '2026-07-26T23:08:58.000Z',
        'rolloutId', '${rolloutId}',
        'operation', 'upgrade',
        'sourceImage', 'ghcr.io/elizaos/eliza-agent',
        'sourceDigest',
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'targetImage',
          'ghcr.io/elizaos/eliza-demo@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'targetDigest',
          'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      ),
      jsonb_build_object(
        'success', true,
        'cleanupPending', false,
        'standbyPending', true,
        'standbyGeneration', '${sourceJobId}',
        'cutoverAt', '2026-07-26T23:10:00.000Z',
        'jobId', '${sourceJobId}',
        'operation', 'upgrade',
        'rolloutId', '${rolloutId}',
        'actorUserId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'decisionAt', '2026-07-26T23:08:58.000Z',
        'agentId', '11111111-1111-4111-8111-111111111111',
        'organizationId', '22222222-2222-4222-8222-222222222222',
        'targetOwnerUserId', '33333333-3333-4333-8333-333333333333',
        'sourceImage', 'ghcr.io/elizaos/eliza-agent',
        'sourceDigest',
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'targetImage',
          'ghcr.io/elizaos/eliza-demo@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'targetDigest',
          'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'startedAt', '2026-07-26T23:09:01.000Z',
        'finishedAt', '2026-07-26T23:10:00.000Z'
      ),
      '22222222-2222-4222-8222-222222222222',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '11111111-1111-4111-8111-111111111111',
      '2026-07-26T23:09:01.000Z',
      '2026-07-26T23:10:00.000Z',
      '2026-07-26T23:09:00.000Z',
      '2026-07-26T23:10:00.000Z'
    );

    INSERT INTO agent_snapshot_restore_validations (
      restore_validation_id,
      validation_job_id,
      source_job_id,
      rollout_id,
      standby_generation,
      organization_id,
      sandbox_record_id,
      agent_id,
      target_owner_user_id,
      backup_id,
      capture_nonce,
      source_environment_revision,
      source_image_digest,
      source_sandbox_id,
      target_image,
      target_digest,
      candidate_route_mode,
      validation_state,
      created_at,
      updated_at
    ) VALUES (
      '77777777-7777-4777-8777-777777777777',
      '88888888-8888-4888-8888-888888888888',
      '${sourceJobId}',
      '${identityMatches ? rolloutId : "99999999-9999-4999-8999-999999999999"}',
      '${sourceJobId}',
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      '${
        identityMatches
          ? "11111111-1111-4111-8111-111111111111"
          : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      }',
      '33333333-3333-4333-8333-333333333333',
      '66666666-6666-4666-8666-666666666666',
      'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      1,
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'ghcr.io/elizaos/eliza-demo@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'restore_validation_private_control',
      'planned',
      '2026-07-26T23:10:01.000Z',
      '2026-07-26T23:10:01.000Z'
    );
  `);
}

async function commitRestoreValidation(
  database: PGlite,
  receiptTotalBytes = 128,
): Promise<void> {
  await database.exec(`
    INSERT INTO agent_sandbox_backups (
      id,
      sandbox_record_id,
      snapshot_type,
      snapshot_schema_version,
      verification_status,
      verified_at,
      verification_error,
      storage_commit_state,
      content_hash
    ) VALUES (
      '66666666-6666-4666-8666-666666666666',
      '11111111-1111-4111-8111-111111111111',
      'pre-upgrade',
      2,
      'verified',
      '2026-07-26T23:13:59.000Z',
      NULL,
      'complete',
      'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    );

    UPDATE agent_snapshot_restore_validations
    SET
      validation_state = 'restore_committed',
      aggregate_sha256 =
        'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      target_provider_sandbox_id = 'candidate-provider',
      target_replacement_attempt_id =
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      target_provider_node_id = 'candidate-node',
      target_provider_container_name = 'candidate-container',
      target_provider_container_id = 'candidate-container-id',
      target_provider_volume_path = '/candidate-volume',
      target_provider_bridge_url = 'http://candidate:3000',
      target_provider_health_url = 'http://candidate:3000/api',
      target_provider_bridge_port = 3002,
      target_provider_web_ui_port = 3003,
      target_provider_vpn_node_id = 'candidate-vpn',
      target_provider_vpn_node_name = 'candidate-vpn-name',
      target_provider_vpn_registration_started_at =
        '2026-07-26T23:11:00.000Z',
      target_provider_allocation_counted = TRUE,
      receipt_state = 'committed',
      receipt_schema_version = 2,
      receipt_transfer = 'chunked-v1',
      receipt_file_count = 1,
      receipt_total_bytes = ${receiptTotalBytes},
      receipt_requires_restart = TRUE,
      receipt_success = TRUE,
      receipt_committed_at = '2026-07-26T23:14:00.000Z',
      updated_at = '2026-07-26T23:14:00.000Z';
  `);
}

async function moveRestoreValidationBeforeCutover(
  database: PGlite,
): Promise<void> {
  await database.exec(`
    UPDATE agent_sandboxes
    SET
      sandbox_id = rollback_standby_sandbox_id,
      node_id = rollback_standby_node_id,
      container_name = rollback_standby_container_name,
      docker_image = rollback_standby_docker_image,
      image_digest = rollback_standby_image_digest,
      rollback_standby_state = 'paused_pre_cutover',
      replacement_cleanup_sandbox_id = 'candidate-provider',
      replacement_cleanup_node_id = 'candidate-node',
      replacement_cleanup_container_name = 'candidate-container',
      replacement_cleanup_attempt_id =
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      replacement_cleanup_container_id = 'candidate-container-id',
      replacement_cleanup_vpn_node_id = NULL,
      replacement_cleanup_vpn_node_name = NULL,
      replacement_cleanup_preserved_vpn_node_id = NULL,
      replacement_cleanup_vpn_registration_started_at = NULL,
      replacement_cleanup_allocation_counted = TRUE,
      replacement_cleanup_created_at = '2026-07-26T23:09:30.000Z';

    UPDATE jobs
    SET
      status = 'in_progress',
      result = NULL,
      error = NULL,
      attempts = 0,
      max_attempts = 3,
      completed_at = NULL,
      updated_at = '2026-07-26T23:09:30.000Z'
    WHERE id = '44444444-4444-4444-8444-444444444444';
  `);
}

async function seedRetainedCompletedDecision(
  database: PGlite,
  stringifiedSuccess = false,
): Promise<void> {
  await seedPausedRestoreValidation(database);
  await commitRestoreValidation(database);
  const successValue = stringifiedSuccess ? "'true'" : "TRUE";
  await database.exec(`
    UPDATE agent_snapshot_restore_validations
    SET
      validation_state = 'never_routed_retired',
      target_provider_allocation_counted = FALSE,
      candidate_container_absent_at = '2026-07-26T23:15:00.000Z',
      candidate_vpn_absent_at = '2026-07-26T23:15:01.000Z',
      candidate_volume_absent_at = '2026-07-26T23:15:02.000Z',
      candidate_retired_at = '2026-07-26T23:15:03.000Z',
      updated_at = '2026-07-26T23:15:03.000Z';

    UPDATE agent_sandboxes
    SET
      rollback_standby_state = 'retiring',
      rollback_standby_decision_job_id =
        '99999999-9999-4999-8999-999999999999',
      rollback_standby_verified_backup_id =
        '66666666-6666-4666-8666-666666666666',
      rollback_standby_restore_validation_id =
        '77777777-7777-4777-8777-777777777777',
      rollback_standby_restore_validation_aggregate_sha256 =
        'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      rollback_standby_restore_candidate_provider_sandbox_id =
        'candidate-provider',
      rollback_standby_restore_candidate_replacement_attempt_id =
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    INSERT INTO jobs (
      id,
      type,
      status,
      data,
      result,
      organization_id,
      user_id,
      agent_id,
      started_at,
      completed_at,
      created_at,
      updated_at
    ) VALUES (
      '99999999-9999-4999-8999-999999999999',
      'agent_admin_canary_standby_decision',
      'completed',
      jsonb_build_object(
        'requestId', 'decision-request',
        'sourceJobId', '44444444-4444-4444-8444-444444444444',
        'decision', 'accept',
        'standbyGeneration', '44444444-4444-4444-8444-444444444444',
        'rolloutId', '55555555-5555-4555-8555-555555555555',
        'actorUserId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'userId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'decisionAt', '2026-07-26T23:15:03.000Z',
        'agentId', '11111111-1111-4111-8111-111111111111',
        'organizationId', '22222222-2222-4222-8222-222222222222',
        'targetOwnerUserId', '33333333-3333-4333-8333-333333333333',
        'sourceImage', 'ghcr.io/elizaos/eliza-agent',
        'sourceDigest',
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'targetImage',
          'ghcr.io/elizaos/eliza-demo@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'targetDigest',
          'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      ),
      jsonb_build_object(
        'success', ${successValue},
        'decision', 'accept',
        'outcome', 'accepted',
        'requestId', 'decision-request',
        'sourceJobId', '44444444-4444-4444-8444-444444444444',
        'decisionJobId', '99999999-9999-4999-8999-999999999999',
        'standbyGeneration', '44444444-4444-4444-8444-444444444444',
        'rolloutId', '55555555-5555-4555-8555-555555555555',
        'actorUserId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'agentId', '11111111-1111-4111-8111-111111111111',
        'organizationId', '22222222-2222-4222-8222-222222222222',
        'targetImage',
          'ghcr.io/elizaos/eliza-demo@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'targetDigest',
          'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'startedAt', '2026-07-26T23:15:05.000Z',
        'finishedAt', '2026-07-26T23:15:06.000Z'
      ),
      '22222222-2222-4222-8222-222222222222',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '11111111-1111-4111-8111-111111111111',
      '2026-07-26T23:15:05.000Z',
      '2026-07-26T23:15:06.000Z',
      '2026-07-26T23:15:04.000Z',
      '2026-07-26T23:15:06.000Z'
    );
  `);
}

async function seedRetiringInProgressDecision(database: PGlite): Promise<void> {
  await seedRetainedCompletedDecision(database);
  await database.exec(`
    UPDATE jobs
    SET
      status = 'in_progress',
      result = NULL,
      completed_at = NULL,
      updated_at = '2026-07-26T23:15:05.000Z'
    WHERE id = '99999999-9999-4999-8999-999999999999';
  `);
}

async function queryDiagnosticSnapshot(
  database: PGlite,
): Promise<Record<string, unknown>> {
  const results = await database.exec(diagnosticSql());
  const selected = results.find((result) => result.rows.length === 1);
  if (!selected) throw new Error("diagnostic SQL did not return one snapshot");
  const raw = selected.rows[0] as {
    json_build_object?: Record<string, unknown>;
  };
  if (!raw.json_build_object) {
    throw new Error("diagnostic SQL returned no JSON evidence");
  }
  return raw.json_build_object;
}

describe("managed dedicated staging canary workflow (#16194)", () => {
  test("is maintainer-triggered or scheduled, staging-only, serialized, and never uses Hetzner credentials", () => {
    expect(workflow.on?.schedule).toBeDefined();
    expect(workflow.on?.workflow_dispatch).toBeDefined();
    expect(workflow.on?.workflow_dispatch).toMatchObject({
      inputs: {
        stale_canary_suffix: {
          required: false,
          type: "string",
          default: "",
        },
        diagnose_stale_canary_suffix: {
          required: false,
          type: "string",
          default: "",
        },
      },
    });
    expect(workflow.on?.pull_request).toEqual({ types: ["labeled"] });
    expect(workflow.on?.push).toBeUndefined();
    expect(job?.if).toContain("run-managed-dedicated-canary");
    expect(job?.environment).toBe("staging");
    expect(job?.["timeout-minutes"]).toBe(45);
    expect(job?.env?.CLOUD_DEDICATED_CANARY_BASE_URL).toBe(
      "https://api-staging.elizacloud.ai",
    );
    expect(job?.env?.CLOUD_DEDICATED_CANARY_STALE_CANARY_SUFFIX).toBe(
      "$" + "{{ inputs.stale_canary_suffix || '' }}",
    );
    expect(workflow.concurrency).toEqual({
      group: "managed-dedicated-staging-canary",
      "cancel-in-progress": false,
    });
    expect(workflowSource).not.toContain("HCLOUD_TOKEN");
    expect(workflowSource).not.toContain("HCLOUD_APPS_TOKEN");
    expect(workflowSource).not.toContain("HETZNER_API_TOKEN");
  });

  test("keeps diagnosis exact-targeted, staging-protected, and mutually exclusive with mutation", () => {
    expect(job?.if).toContain("inputs.diagnose_stale_canary_suffix == ''");
    expect(diagnoseJob?.if).toContain(
      "inputs.diagnose_stale_canary_suffix != ''",
    );
    expect(diagnoseJob?.if).toContain(
      "github.event_name == 'workflow_dispatch'",
    );
    expect(diagnoseJob?.environment).toBe("staging");
    expect(diagnoseJob?.["timeout-minutes"]).toBe(10);
    expect(diagnoseJob?.env?.CANARY_DIAGNOSTIC_SUFFIX).toBe(
      "$" + "{{ inputs.diagnose_stale_canary_suffix }}",
    );
    expect(diagnoseJob?.env?.CANARY_RECOVERY_SUFFIX).toBe(
      "$" + "{{ inputs.stale_canary_suffix }}",
    );

    const query = diagnoseStep("Query exact stale canary read-only");
    expect(query.env?.DATABASE_URL).toBe("$" + "{{ secrets.DATABASE_URL }}");
    expect(query.env?.PGOPTIONS).toContain("default_transaction_read_only=on");
    expect(query.run).toContain(
      "Diagnostic and mutation recovery inputs are mutually exclusive",
    );
    expect(query.run).toContain("^r[1-9][0-9]{7,19}a[1-9][0-9]{0,3}$");
  });

  test("preflights schema-v4 and emits only from one bounded repeatable-read snapshot", () => {
    const run = diagnoseStep("Query exact stale canary read-only").run ?? "";
    expect(run).toContain("BEGIN READ ONLY, ISOLATION LEVEL REPEATABLE READ;");
    expect(run).toContain("SET LOCAL statement_timeout = '20s';");
    expect(run).toContain("DO $schema_preflight$");
    expect(run).toContain("agent_sandboxes_rollback_standby_contract_check");
    expect(run).toContain("agent_snapshot_restore_validations_contract_check");
    expect(run).toContain("agent_snapshot_restore_validations_source_unique");
    expect(run).toContain(
      "WHERE agent_name = 'managed-dedicated-canary-' || :'suffix'",
    );
    expect(run).toContain("ORDER BY jobs.created_at DESC, jobs.id DESC");
    expect(run).toContain("LIMIT 3");
    expect(run).toContain("'capturedAt', clock_timestamp()");
    expect(run).toContain("'contractComplete'");
    expect(run).toContain("'authorityPointed'");
    expect(run).toContain("'sourceIdentityMatches'");
    expect(run).toContain("'backupVerifiedV2'");
    expect(run).toContain("E'\\\\s+'");
    for (const fingerprint of frozenConstraintFingerprints) {
      expect(run).toContain(`= '${fingerprint}'`);
      expect(diagnosticSql()).toContain(`= '${fingerprint}'`);
    }

    const sql = run.match(/<<'SQL'\n([\s\S]*?)\nSQL/)?.[1];
    expect(sql).toBeTruthy();
    expect(sql).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/i,
    );
  });

  test("executes the exact diagnostic SQL against the real frozen schema", async () => {
    const database = await createDiagnosticDatabase();
    try {
      const results = await database.exec(diagnosticSql());
      const selected = results.find((result) => result.rows.length === 1);
      expect(selected).toBeDefined();
      const raw = selected?.rows[0] as {
        json_build_object?: Record<string, unknown>;
      };
      expect(raw.json_build_object).toMatchObject({
        targetCount: 1,
        jobs: [],
        agent: {
          status: "running",
          deletionOwned: false,
          replacementCleanupLocator: {
            sandboxIdPresent: false,
            nodeIdPresent: false,
            containerNamePresent: false,
            createdAtPresent: false,
            contractComplete: true,
          },
          rollbackStandby: null,
        },
      });
      const capturedAt = raw.json_build_object?.capturedAt;
      expect(typeof capturedAt).toBe("string");
      expect(Number.isFinite(Date.parse(capturedAt as string))).toBe(true);
      const rows = await database.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM agent_sandboxes",
      );
      expect(rows.rows).toEqual([{ count: 1 }]);
    } finally {
      await database.close();
    }
  }, 30_000);

  test("counts the reader tuple before rejecting mismatched restore identity", async () => {
    const database = await createDiagnosticDatabase();
    try {
      await seedPausedRestoreValidation(database, false);
      const results = await database.exec(diagnosticSql());
      const selected = results.find((result) => result.rows.length === 1);
      const raw = selected?.rows[0] as {
        json_build_object?: Record<string, unknown>;
      };
      const agent = raw.json_build_object?.agent as Record<string, unknown>;
      const standby = agent.rollbackStandby as Record<string, unknown>;
      const validation = standby.restoreValidation as Record<string, unknown>;
      expect(standby.restoreValidationCount).toBe(1);
      expect(validation.sourceIdentityMatches).toBe(false);
      expect(() =>
        sanitizeManagedDedicatedCanaryDiagnostic(
          raw.json_build_object,
          "r12345678a1",
        ),
      ).toThrow("source authority");
    } finally {
      await database.close();
    }
  }, 30_000);

  test("executes and sanitizes the real paused restore-validation authority path", async () => {
    const database = await createDiagnosticDatabase();
    try {
      await seedPausedRestoreValidation(database);
      const raw = await queryDiagnosticSnapshot(database);
      const evidence = sanitizeManagedDedicatedCanaryDiagnostic(
        raw,
        "r12345678a1",
      );
      expect(evidence.lifecycle).toMatchObject({
        authority: "rollback_standby",
        standbyState: "paused",
        routedRuntime: "primary",
        sourceJob: {
          status: "completed",
          outcome: "standby_pending",
          failureKind: null,
          errorCode: "none",
        },
        restoreValidation: {
          state: "planned",
          sourceIdentityMatches: true,
          backupVerifiedV2: false,
        },
      });
    } finally {
      await database.close();
    }
  }, 30_000);

  test("binds source audit clocks independently of the database session timezone", async () => {
    const database = await createDiagnosticDatabase();
    try {
      await seedPausedRestoreValidation(database);
      await database.exec("SET TIME ZONE 'America/New_York'");
      const raw = await queryDiagnosticSnapshot(database);
      const evidence = sanitizeManagedDedicatedCanaryDiagnostic(
        raw,
        "r12345678a1",
      );
      expect(evidence.lifecycle.sourceJob).toMatchObject({
        status: "completed",
        outcome: "standby_pending",
      });
    } finally {
      await database.close();
    }
  }, 30_000);

  test("rejects restore-validation authority before cutover", async () => {
    const database = await createDiagnosticDatabase();
    try {
      await seedPausedRestoreValidation(database);
      await moveRestoreValidationBeforeCutover(database);
      const raw = await queryDiagnosticSnapshot(database);
      const agent = raw.agent as Record<string, unknown>;
      const standby = agent.rollbackStandby as Record<string, unknown>;
      expect(standby.restoreValidationCount).toBe(1);
      expect(() =>
        sanitizeManagedDedicatedCanaryDiagnostic(raw, "r12345678a1"),
      ).toThrow("pre-cutover");
    } finally {
      await database.close();
    }
  }, 30_000);

  test.each([
    {
      label: "bounded retry",
      status: "pending",
      error: "opaque provider retry",
      attempts: 1,
      maxAttempts: 3,
      completedAt: null,
      resultSql: "NULL",
      expectedOutcome: "pre_cutover_retrying",
      expectedFailureKind: "retry",
      expectedErrorCode: "unclassified",
      expectedRecoveryCode: "none",
    },
    {
      label: "stale recovery retry",
      status: "pending",
      error: "Job timed out - recovered for retry (attempt 1/3)",
      attempts: 1,
      maxAttempts: 3,
      completedAt: null,
      resultSql: "NULL",
      expectedOutcome: "pre_cutover_retrying",
      expectedFailureKind: "retry",
      expectedErrorCode: "none",
      expectedRecoveryCode: "timeout_recovered",
    },
    {
      label: "stale recovery exhaustion",
      status: "failed",
      error: "Job timed out 3 times - max attempts reached",
      attempts: 3,
      maxAttempts: 3,
      completedAt: null,
      resultSql: "NULL",
      expectedOutcome: "pre_cutover_failed",
      expectedFailureKind: "stale_recovery",
      expectedErrorCode: "timeout",
      expectedRecoveryCode: "none",
    },
    {
      label: "execution exhaustion",
      status: "failed",
      error: "opaque provider failure",
      attempts: 3,
      maxAttempts: 3,
      completedAt: "2026-07-26T23:09:40.000Z",
      resultSql: `jsonb_build_object(
        'success', false,
        'jobId', id::text,
        'operation', data ->> 'operation',
        'rolloutId', data ->> 'rolloutId',
        'actorUserId', data ->> 'actorUserId',
        'decisionAt', data ->> 'decisionAt',
        'agentId', data ->> 'agentId',
        'organizationId', data ->> 'organizationId',
        'targetOwnerUserId', data ->> 'targetOwnerUserId',
        'sourceImage', data ->> 'sourceImage',
        'sourceDigest', data ->> 'sourceDigest',
        'targetImage', data ->> 'targetImage',
        'targetDigest', data ->> 'targetDigest',
        'startedAt', '2026-07-26T23:09:01.000Z',
        'finishedAt', '2026-07-26T23:09:40.000Z',
        'error', 'opaque provider failure'
      )`,
      expectedOutcome: "pre_cutover_failed",
      expectedFailureKind: "execution_audit",
      expectedErrorCode: "unclassified",
      expectedRecoveryCode: "none",
    },
  ])(
    "emits the real pre-cutover source-job $label state without raw text",
    async (fixture) => {
      const database = await createDiagnosticDatabase();
      try {
        await seedPausedRestoreValidation(database);
        await moveRestoreValidationBeforeCutover(database);
        await database.exec(`
          UPDATE jobs
          SET
            status = '${fixture.status}',
            error = '${fixture.error}',
            attempts = ${fixture.attempts},
            max_attempts = ${fixture.maxAttempts},
            completed_at = ${
              fixture.completedAt ? `'${fixture.completedAt}'` : "NULL"
            },
            result = ${fixture.resultSql},
            updated_at = '2026-07-26T23:09:40.000Z'
          WHERE id = '44444444-4444-4444-8444-444444444444';

          DELETE FROM agent_snapshot_restore_validations;
        `);
        const evidence = sanitizeManagedDedicatedCanaryDiagnostic(
          await queryDiagnosticSnapshot(database),
          "r12345678a1",
        );
        expect(evidence.lifecycle.sourceJob).toMatchObject({
          status: fixture.status,
          outcome: fixture.expectedOutcome,
          failureKind: fixture.expectedFailureKind,
          attempts: fixture.attempts,
          maxAttempts: fixture.maxAttempts,
          errorCode: fixture.expectedErrorCode,
          recoveryCode: fixture.expectedRecoveryCode,
        });
        expect(JSON.stringify(evidence)).not.toContain(fixture.error);
      } finally {
        await database.close();
      }
    },
    30_000,
  );

  test("rejects empty provider identities accepted by the migration CHECK", async () => {
    const database = await createDiagnosticDatabase();
    try {
      await seedPausedRestoreValidation(database);
      await database.exec(`
        UPDATE agent_snapshot_restore_validations
        SET
          validation_state = 'candidate_provisioning',
          target_provider_sandbox_id = '',
          target_replacement_attempt_id =
            'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          target_provider_node_id = '',
          target_provider_container_name = '',
          target_provider_volume_path = '',
          target_provider_bridge_url = '',
          target_provider_health_url = '',
          target_provider_bridge_port = 3002,
          target_provider_web_ui_port = 3003,
          target_provider_vpn_node_name = '',
          target_provider_vpn_registration_started_at =
            '2026-07-26T23:11:00.000Z',
          target_provider_allocation_counted = TRUE;
      `);
      const results = await database.exec(diagnosticSql());
      const selected = results.find((result) => result.rows.length === 1);
      const raw = selected?.rows[0] as {
        json_build_object?: Record<string, unknown>;
      };
      const agent = raw.json_build_object?.agent as Record<string, unknown>;
      const standby = agent.rollbackStandby as Record<string, unknown>;
      const validation = standby.restoreValidation as Record<string, unknown>;
      expect(validation.contractComplete).toBe(false);
      expect(() =>
        sanitizeManagedDedicatedCanaryDiagnostic(
          raw.json_build_object,
          "r12345678a1",
        ),
      ).toThrow("frozen contract");
    } finally {
      await database.close();
    }
  }, 30_000);

  test.each([
    [
      "source sandbox UUID",
      `UPDATE agent_snapshot_restore_validations
       SET source_sandbox_id = '00000000-0000-0000-0000-000000000000'`,
    ],
    [
      "candidate replacement UUID",
      `UPDATE agent_snapshot_restore_validations
       SET target_replacement_attempt_id =
         '00000000-0000-0000-0000-000000000000'`,
    ],
  ])(
    "rejects a reader-incompatible %s accepted by the migration CHECK",
    async (_label, mutation) => {
      const database = await createDiagnosticDatabase();
      try {
        await seedPausedRestoreValidation(database);
        await database.exec(`
          UPDATE agent_snapshot_restore_validations
          SET
            validation_state = 'candidate_provisioning',
            target_provider_sandbox_id = 'candidate-provider',
            target_replacement_attempt_id =
              'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            target_provider_node_id = 'candidate-node',
            target_provider_container_name = 'candidate-container',
            target_provider_volume_path = '/candidate-volume',
            target_provider_bridge_url = 'http://candidate:3000',
            target_provider_health_url = 'http://candidate:3000/api',
            target_provider_bridge_port = 3002,
            target_provider_web_ui_port = 3003,
            target_provider_vpn_node_name = 'candidate-vpn-name',
            target_provider_vpn_registration_started_at =
              '2026-07-26T23:11:00.000Z',
            target_provider_allocation_counted = TRUE;
          ${mutation};
        `);
        const raw = await queryDiagnosticSnapshot(database);
        const agent = raw.agent as Record<string, unknown>;
        const standby = agent.rollbackStandby as Record<string, unknown>;
        const validation = standby.restoreValidation as Record<string, unknown>;
        expect(validation.contractComplete).toBe(false);
        expect(() =>
          sanitizeManagedDedicatedCanaryDiagnostic(raw, "r12345678a1"),
        ).toThrow("frozen contract");
      } finally {
        await database.close();
      }
    },
    30_000,
  );

  test("rejects a restore receipt larger than JavaScript's safe integer range", async () => {
    const database = await createDiagnosticDatabase();
    try {
      await seedPausedRestoreValidation(database);
      await commitRestoreValidation(database, 9_007_199_254_740_992);
      const raw = await queryDiagnosticSnapshot(database);
      const agent = raw.agent as Record<string, unknown>;
      const standby = agent.rollbackStandby as Record<string, unknown>;
      const validation = standby.restoreValidation as Record<string, unknown>;
      expect(validation.contractComplete).toBe(false);
      expect(() =>
        sanitizeManagedDedicatedCanaryDiagnostic(raw, "r12345678a1"),
      ).toThrow("frozen contract");
    } finally {
      await database.close();
    }
  }, 30_000);

  test("rejects source-job identity that disagrees with the routed target", async () => {
    const database = await createDiagnosticDatabase();
    try {
      await seedPausedRestoreValidation(database);
      await database.exec(`
        UPDATE jobs
        SET data = jsonb_set(
          data,
          '{targetDigest}',
          '"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"'
        )
        WHERE id = '44444444-4444-4444-8444-444444444444';
      `);
      const raw = await queryDiagnosticSnapshot(database);
      expect(() =>
        sanitizeManagedDedicatedCanaryDiagnostic(raw, "r12345678a1"),
      ).toThrow("sourceJob must be an object");
    } finally {
      await database.close();
    }
  }, 30_000);

  test("rejects pointed-job completion clocks after their updated clock", async () => {
    const database = await createDiagnosticDatabase();
    try {
      await seedPausedRestoreValidation(database);
      await database.exec(`
        UPDATE jobs
        SET
          completed_at = '2026-07-26T23:19:00.000Z',
          updated_at = '2026-07-26T23:10:00.000Z',
          result = jsonb_set(
            jsonb_set(
              result,
              '{finishedAt}',
              '"2026-07-26T23:19:00.000Z"'
            ),
            '{cutoverAt}',
            '"2026-07-26T23:19:00.000Z"'
          )
        WHERE id = '44444444-4444-4444-8444-444444444444';
      `);
      const raw = await queryDiagnosticSnapshot(database);
      expect(() =>
        sanitizeManagedDedicatedCanaryDiagnostic(raw, "r12345678a1"),
      ).toThrow("out of order");
    } finally {
      await database.close();
    }
  }, 30_000);

  test("rejects a malformed source audit clock without echoing its raw value", async () => {
    const database = await createDiagnosticDatabase();
    try {
      await seedPausedRestoreValidation(database);
      await database.exec(`
        UPDATE jobs
        SET result = jsonb_set(
          result,
          '{startedAt}',
          '"PRIVATE_AUDIT_CLOCK_MUST_NOT_ESCAPE"'
        )
        WHERE id = '44444444-4444-4444-8444-444444444444';
      `);
      const raw = await queryDiagnosticSnapshot(database);
      const serialized = JSON.stringify(raw);
      expect(serialized).not.toContain("PRIVATE_AUDIT_CLOCK_MUST_NOT_ESCAPE");
      const agent = raw.agent as Record<string, unknown>;
      const standby = agent.rollbackStandby as Record<string, unknown>;
      const sourceJob = standby.sourceJob as Record<string, unknown>;
      expect(sourceJob.outcome).toBe("invalid");
      expect(() =>
        sanitizeManagedDedicatedCanaryDiagnostic(raw, "r12345678a1"),
      ).toThrow("sourceJob.outcome is invalid");
    } finally {
      await database.close();
    }
  }, 30_000);

  test("rejects stringified source-result booleans", async () => {
    const database = await createDiagnosticDatabase();
    try {
      await seedPausedRestoreValidation(database);
      await database.exec(`
        UPDATE jobs
        SET result = jsonb_set(result, '{success}', '"true"')
        WHERE id = '44444444-4444-4444-8444-444444444444';
      `);
      const raw = await queryDiagnosticSnapshot(database);
      const agent = raw.agent as Record<string, unknown>;
      const standby = agent.rollbackStandby as Record<string, unknown>;
      const sourceJob = standby.sourceJob as Record<string, unknown>;
      expect(sourceJob.outcome).toBe("invalid");
      expect(() =>
        sanitizeManagedDedicatedCanaryDiagnostic(raw, "r12345678a1"),
      ).toThrow("sourceJob.outcome is invalid");
    } finally {
      await database.close();
    }
  }, 30_000);

  test.each([
    [false, "accepted"],
    [true, "invalid"],
  ])(
    "requires a JSON boolean in the retained decision audit: stringified=%s",
    async (stringifiedSuccess, expectedOutcome) => {
      const database = await createDiagnosticDatabase();
      try {
        await seedRetainedCompletedDecision(database, stringifiedSuccess);
        const raw = await queryDiagnosticSnapshot(database);
        const agent = raw.agent as Record<string, unknown>;
        const standby = agent.rollbackStandby as Record<string, unknown>;
        const decisionJob = standby.decisionJob as Record<string, unknown>;
        expect(decisionJob.outcome).toBe(expectedOutcome);
      } finally {
        await database.close();
      }
    },
    30_000,
  );

  test("sanitizes the real retiring acceptance-authority path", async () => {
    const database = await createDiagnosticDatabase();
    try {
      await seedRetiringInProgressDecision(database);
      const raw = await queryDiagnosticSnapshot(database);
      const evidence = sanitizeManagedDedicatedCanaryDiagnostic(
        raw,
        "r12345678a1",
      );
      expect(evidence.lifecycle).toMatchObject({
        authority: "rollback_standby",
        standbyState: "retiring",
        routedRuntime: "primary",
        sourceJob: {
          status: "completed",
          outcome: "standby_pending",
        },
        decisionJob: {
          status: "in_progress",
          decision: "accept",
          outcome: null,
        },
        restoreValidation: {
          state: "never_routed_retired",
          authorityPointed: true,
          sourceIdentityMatches: true,
          backupVerifiedV2: true,
        },
      });
    } finally {
      await database.close();
    }
  }, 30_000);

  test.each([
    [
      "a missing 0189 column",
      "ALTER TABLE agent_snapshot_restore_validations DROP COLUMN receipt_schema_version CASCADE",
      "schema is incomplete",
    ],
    [
      "a changed 0188 column contract",
      "ALTER TABLE agent_sandboxes ALTER COLUMN rollback_standby_state SET DEFAULT 'paused'",
      "columns differ from migration 0188",
    ],
    [
      "a timezone-bearing pointed-job clock",
      `ALTER TABLE jobs
         ALTER COLUMN started_at TYPE timestamp with time zone
         USING started_at AT TIME ZONE 'UTC'`,
      "pointed job authority columns",
    ],
    [
      "a missing replacement locator constraint",
      "ALTER TABLE agent_sandboxes DROP CONSTRAINT agent_sandboxes_replacement_cleanup_locator_check",
      "replacement cleanup locator constraint",
    ],
    [
      "a weakened rollback standby constraint retaining expected fragments",
      `ALTER TABLE agent_sandboxes
         DROP CONSTRAINT agent_sandboxes_rollback_standby_contract_check;
       ALTER TABLE agent_sandboxes
         ADD CONSTRAINT agent_sandboxes_rollback_standby_contract_check
         CHECK (
           rollback_standby_state = 'paused_pre_cutover'
           OR rollback_standby_state = 'rollback_cleanup_pending'
           OR deletion_attempt_id IS NULL
         )`,
      "rollback standby contract constraint",
    ],
    [
      "a missing exact source-identity index",
      "DROP INDEX agent_snapshot_restore_validations_source_unique",
      "restore validation source uniqueness",
    ],
  ])(
    "rejects %s before evidence emission",
    async (_label, mutation, message) => {
      const database = await createDiagnosticDatabase();
      try {
        await database.exec(mutation);
        await expect(database.exec(diagnosticSql())).rejects.toThrow(message);
      } finally {
        await database.close();
      }
    },
    30_000,
  );

  test("validates, scrubs, and uploads only canonical privacy-safe diagnostic evidence", () => {
    const steps = diagnoseJob?.steps ?? [];
    const queryIndex = steps.findIndex(
      ({ name }) => name === "Query exact stale canary read-only",
    );
    const classifyIndex = steps.findIndex(
      ({ name }) => name === "Classify privacy-safe diagnostic",
    );
    const uploadIndex = steps.findIndex(
      ({ name }) => name === "Upload privacy-safe diagnostic",
    );
    expect(queryIndex).toBeGreaterThanOrEqual(0);
    expect(classifyIndex).toBeGreaterThan(queryIndex);
    expect(uploadIndex).toBeGreaterThan(classifyIndex);

    const queryRun =
      diagnoseStep("Query exact stale canary read-only").run ?? "";
    expect(queryRun).toContain("umask 077");
    expect(queryRun).toContain("trap cleanup_incomplete_raw EXIT");
    expect(queryRun).toContain('echo "::add-mask::$PSQL_DATABASE_URL"');
    expect(queryRun).toContain('psql "$PSQL_DATABASE_URL"');
    expect(queryRun).not.toContain('psql "$DATABASE_URL"');

    const classifyRun =
      diagnoseStep("Classify privacy-safe diagnostic").run ?? "";
    expect(classifyRun).toContain(
      "trap 'rm -f -- \"$CANARY_DIAGNOSTIC_RAW_PATH\"' EXIT",
    );
    expect(classifyRun).toContain("managed-dedicated-canary-diagnostic.ts");

    const upload = diagnoseStep("Upload privacy-safe diagnostic");
    expect(upload.with?.path).toBe(
      "reports/managed-dedicated-canary-diagnostic.json",
    );
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    expect(upload.with?.["retention-days"]).toBe(14);
  });

  test("uses the exact App Live Cloud-secret fallback and fails on blank input", () => {
    expect(job?.env?.ELIZAOS_CLOUD_API_KEY).toBe(
      "$" + "{{ secrets.ELIZAOS_CLOUD_API_KEY || secrets.ELIZACLOUD_API_KEY }}",
    );
    const run = step("Require real Cloud credential").run ?? "";
    const missing = spawnSync("bash", ["-c", run], {
      encoding: "utf8",
      env: { ...process.env, ELIZAOS_CLOUD_API_KEY: "" },
    });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("refusing green-by-skip");

    const whitespace = spawnSync("bash", ["-c", run], {
      encoding: "utf8",
      env: { ...process.env, ELIZAOS_CLOUD_API_KEY: " \t\n" },
    });
    expect(whitespace.status).toBe(1);

    const configured = spawnSync("bash", ["-c", run], {
      encoding: "utf8",
      env: { ...process.env, ELIZAOS_CLOUD_API_KEY: "fixture-key" },
    });
    expect(configured.status).toBe(0);
  });

  test("preflights the exact staging URL and rejects userinfo", () => {
    const run = step("Require exact staging target").run ?? "";
    const exact = spawnSync("bash", ["-c", run], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUD_DEDICATED_CANARY_BASE_URL: "https://api-staging.elizacloud.ai",
      },
    });
    expect(exact.status, exact.stderr).toBe(0);

    const userinfo = spawnSync("bash", ["-c", run], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUD_DEDICATED_CANARY_BASE_URL:
          "https://user:password@api-staging.elizacloud.ai",
      },
    });
    expect(userinfo.status).toBe(1);
    expect(userinfo.stderr).toContain("without userinfo");
  });

  test("runs deterministic contracts before live provisioning", () => {
    const steps = job?.steps ?? [];
    const contractIndex = steps.findIndex(
      (candidate) => candidate.name === "Validate canary and failure contracts",
    );
    const liveIndex = steps.findIndex(
      (candidate) => candidate.name === "Run bounded managed dedicated canary",
    );
    expect(contractIndex).toBeGreaterThanOrEqual(0);
    expect(liveIndex).toBeGreaterThan(contractIndex);
    expect(step("Validate canary and failure contracts").run).toContain(
      "managed-dedicated-canary.test.ts",
    );
    expect(step("Run bounded managed dedicated canary").run).toContain(
      "managed-dedicated-canary.ts",
    );
  });

  test("binds workflow recovery intent to the independently validated artifact", () => {
    const intent = step("Bind stale-recovery intent");
    expect(intent.id).toBe("recovery_intent");
    expect(intent.run).toContain("requested=${requested");
    expect(intent.run).not.toContain("console.log(raw)");
    const enforce = step("Enforce live proof, deployed SHA, and cleanup");
    expect(enforce.env?.EXPECTED_RECOVERY_REQUESTED).toBe(
      "$" + "{{ steps.recovery_intent.outputs.requested }}",
    );
    expect(enforce.run).toContain("workflow_recovery_intent_mismatch");
    expect(enforce.run).toContain("evidence.recovery.performed");
    expect(enforce.run).toContain("evidence.recovery.confirmed");
  });

  test("makes missing evidence, zero paths, cleanup failure, and stale deploy ancestry red", () => {
    const enforce =
      step("Enforce live proof, deployed SHA, and cleanup").run ?? "";
    expect(enforce).toContain('[[ ! -s "$evidence_path" ]]');
    expect(enforce).toContain("validateManagedDedicatedCanaryEvidence");
    expect(enforce).toContain("zero-executed/skip outcomes are failures");
    expect(
      step("Enforce live proof, deployed SHA, and cleanup").env
        ?.EXPECTED_SOURCE_SHA,
    ).toBe(
      "$" +
        "{{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.sha }}",
    );
    expect(enforce).toContain(
      'git merge-base --is-ancestor "$expected_source_sha" "$deployed_commit"',
    );
    expect(enforce).not.toContain(
      'git merge-base --is-ancestor "$deployed_commit" "$GITHUB_SHA"',
    );
    expect(enforce).toContain("LIVE_PROCESS_STATUS:-missing");
    expect(enforce).toContain("PRIVACY_VALIDATED:-missing");
    expect(enforce).toContain("evidence.cleanup.status");
  });

  test("rejects an older deployed ancestor and accepts a deploy containing the expected source", () => {
    const cwd = mkdtempSync(join(tmpdir(), "managed-canary-ancestry-"));
    try {
      expect(runGit(cwd, ["init", "--quiet"]).status).toBe(0);
      expect(
        runGit(cwd, ["config", "user.email", "canary@example.test"]).status,
      ).toBe(0);
      expect(runGit(cwd, ["config", "user.name", "Canary Test"]).status).toBe(
        0,
      );
      const staleDeploy = commitFixture(cwd, "stale deployment");
      const expectedSource = commitFixture(cwd, "expected source");
      const containingDeploy = commitFixture(
        cwd,
        "deployment containing source",
      );

      const stale = runGit(cwd, [
        "merge-base",
        "--is-ancestor",
        expectedSource,
        staleDeploy,
      ]);
      expect(stale.status).toBe(1);

      const containing = runGit(cwd, [
        "merge-base",
        "--is-ancestor",
        expectedSource,
        containingDeploy,
      ]);
      expect(containing.status, containing.stderr).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("strictly validates both red and green evidence before any artifact upload", () => {
    const steps = job?.steps ?? [];
    const privacyIndex = steps.findIndex(
      (candidate) =>
        candidate.name === "Validate privacy-safe evidence artifact",
    );
    const uploadIndex = steps.findIndex(
      (candidate) =>
        candidate.name === "Upload privacy-safe timing and path evidence",
    );
    const privacy = step("Validate privacy-safe evidence artifact");
    const upload = step("Upload privacy-safe timing and path evidence");
    const privacyRun = privacy.run;
    if (!privacyRun) throw new Error("privacy validation step has no script");
    expect(privacyIndex).toBeGreaterThanOrEqual(0);
    expect(uploadIndex).toBeGreaterThan(privacyIndex);
    expect(privacy.id).toBe("privacy");
    expect(privacy.if).toContain("always()");
    expect(privacyRun).toContain("canonicalizeManagedDedicatedCanaryArtifact");
    expect(privacyRun).toContain("writeFileSync(canonicalPath, canonical");
    expect(privacyRun).toContain("renameSync(canonicalPath, evidencePath)");
    expect(privacyRun.indexOf("renameSync")).toBeLessThan(
      privacyRun.indexOf('echo "validated=true"'),
    );
    expect(privacyRun).toContain('echo "validated=true"');
    expect(upload.if).toContain("steps.privacy.outputs.validated == 'true'");
    expect(upload.with?.path).toBe("reports/managed-dedicated-canary.json");
    expect(upload.with?.["retention-days"]).toBe(14);
  });

  test("keeps every workflow shell contract valid", () => {
    for (const name of [
      "Require real Cloud credential",
      "Require exact staging target",
      "Bind stale-recovery intent",
      "Validate canary and failure contracts",
      "Run bounded managed dedicated canary",
      "Validate privacy-safe evidence artifact",
      "Enforce live proof, deployed SHA, and cleanup",
    ]) {
      const result = spawnSync("bash", ["-n"], {
        input: step(name).run ?? "",
        encoding: "utf8",
      });
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
    for (const name of [
      "Query exact stale canary read-only",
      "Classify privacy-safe diagnostic",
      "Summarize classified result",
    ]) {
      const result = spawnSync("bash", ["-n"], {
        input: diagnoseStep(name).run ?? "",
        encoding: "utf8",
      });
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  });
});
