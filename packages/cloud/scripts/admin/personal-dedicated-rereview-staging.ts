#!/usr/bin/env bun
/**
 * Runs the staging-only, privacy-safe operator boundary for the personal
 * Dedicated selection owned by the deployed smoke account. An existing receipt
 * is re-reviewed; a missing receipt is bootstrapped only when one candidate has
 * canonical restore authority. The command resolves identifiers internally,
 * binds execution to a prior redacted preview, and audits that agent and job
 * rows did not change. The snapshot is post-commit detection, not rollback
 * authority; the canonical transaction owns its exact receipt write set.
 */

import { createHash, createHmac } from "node:crypto";
import {
  classifyManagedDedicatedProvisionFailure,
  type ManagedDedicatedProvisionFailureCode,
} from "./managed-dedicated-provision-diagnostic";

const STAGING_API_BASE_URL = "https://api-staging.eliza.app";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const EXECUTE_CONFIRMATION =
  "REREVIEW_STALE_SELECTION_WITHOUT_COMPUTE_MUTATION";
const REVIEWED_REASON =
  "retain_current_receipt_target_after_duplicate_inventory_review";
const BOOTSTRAP_CONFIRMATION =
  "SELECT_UNIQUE_VERIFIED_BACKUP_WITHOUT_COMPUTE_MUTATION";
const BOOTSTRAP_REVIEWED_REASON =
  "select_unique_verified_backup_after_duplicate_inventory_review";

type Mode = "preview" | "execute";
type JsonRecord = Record<string, unknown>;

export class PersonalDedicatedRereviewOperatorError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PersonalDedicatedRereviewOperatorError";
  }
}

type SelectionOperation = "bootstrap" | "rereview";

interface ResolvedSelection {
  organizationId: string;
  userId: string;
  sourceAgentId: string;
  retainedAgentId: string;
  operation: SelectionOperation;
}

interface MutationSnapshot {
  agentCount: number;
  agentDigest: string;
  jobCount: number;
  jobDigest: string;
  selectedTarget: RereviewTargetDiagnostic;
}

interface RereviewTargetDiagnostic {
  status: string;
  databaseStatus: string;
  provisionFailure: ManagedDedicatedProvisionFailureCode;
  hasContainer: boolean;
  hasBridge: boolean;
}

/** Emits only lifecycle vocabulary and presence flags from the retained row. */
export function diagnoseRereviewTarget(target: {
  status: string;
  database_status: string;
  error_message: string | null;
  sandbox_id: string | null;
  bridge_url: string | null;
}): RereviewTargetDiagnostic {
  if (
    ![
      "pending",
      "provisioning",
      "running",
      "stopped",
      "sleeping",
      "disconnected",
      "error",
      "deletion_pending",
      "deletion_failed",
    ].includes(target.status) ||
    !["none", "provisioning", "ready", "error"].includes(target.database_status)
  ) {
    throw new PersonalDedicatedRereviewOperatorError(
      "selected_target_status_invalid",
    );
  }
  return {
    status: target.status,
    databaseStatus: target.database_status,
    provisionFailure: classifyManagedDedicatedProvisionFailure(
      target.error_message,
      "selected target error",
    ),
    hasContainer: Boolean(target.sandbox_id),
    hasBridge: Boolean(target.bridge_url),
  };
}

interface SelectionPreviewBase {
  inventoryFingerprint: string;
  stateDisposition: RereviewOperatorEvidence["stateDisposition"];
  candidateCount: number;
  replacesTarget: boolean;
}

type SelectionPreview =
  | (SelectionPreviewBase & {
      operation: "bootstrap";
      receiptFingerprint: null;
      receiptUpdatedAt: null;
      previousRetainedAgentId: null;
    })
  | (SelectionPreviewBase & {
      operation: "rereview";
      receiptFingerprint: string;
      receiptUpdatedAt: string;
      previousRetainedAgentId: string;
    });

type SelectionExecuteInput =
  | (ResolvedSelection & {
      operation: "bootstrap";
      expectedReceiptFingerprint: null;
      expectedReceiptUpdatedAt: null;
      expectedPreviousRetainedAgentId: null;
      expectedInventoryFingerprint: string;
      expectedStateDisposition: RereviewOperatorEvidence["stateDisposition"];
    })
  | (ResolvedSelection & {
      operation: "rereview";
      expectedReceiptFingerprint: string;
      expectedReceiptUpdatedAt: string;
      expectedPreviousRetainedAgentId: string;
      expectedInventoryFingerprint: string;
      expectedStateDisposition: RereviewOperatorEvidence["stateDisposition"];
    });

export interface RereviewOperatorConfig {
  mode: Mode;
  apiKey: string;
  expectedCloudCommit: string;
  approvalDigest?: string;
  confirmation?: string;
  reviewedReason?: string;
}

export interface RereviewOperatorEvidence {
  schemaVersion: 1;
  mode: Mode;
  deployedCommitVerified: true;
  identityResolved: true;
  operation: SelectionOperation;
  candidateCount: number;
  stateDisposition: "verified_backup_present" | "fresh_boot_no_verified_backup";
  replacesTarget: boolean;
  approvalDigest: string;
  requiredReviewedReason: string;
  requiredConfirmation: string;
  computeMutation: false;
  agentCount: number;
  jobCount: number;
  executed: boolean;
  selectedTarget: RereviewTargetDiagnostic;
}

export interface RereviewOperatorDecisionEvidence {
  schemaVersion: 1;
  mode: "preview";
  decisionRequired: true;
  decisionCode:
    | "selection_bootstrap_zero_candidates"
    | "selection_bootstrap_single_candidate"
    | "selection_bootstrap_inventory_over_limit"
    | "selection_bootstrap_no_restore_authority"
    | "selection_bootstrap_multiple_restore_authorities";
  computeMutation: false;
  executed: false;
}

export interface RereviewOperatorDependencies {
  verifyDeployment(expectedCommit: string): Promise<void>;
  reportAccountLifecycle(apiKey: string): Promise<void>;
  resolveSelection(apiKey: string): Promise<ResolvedSelection>;
  preview(input: ResolvedSelection): Promise<SelectionPreview>;
  execute(input: SelectionExecuteInput): Promise<void>;
  snapshot(input: ResolvedSelection): Promise<MutationSnapshot>;
}

const PREVIEW_DECISION_CODES = new Set<
  RereviewOperatorDecisionEvidence["decisionCode"]
>([
  "selection_bootstrap_zero_candidates",
  "selection_bootstrap_single_candidate",
  "selection_bootstrap_inventory_over_limit",
  "selection_bootstrap_no_restore_authority",
  "selection_bootstrap_multiple_restore_authorities",
]);

/** Converts an expected read-only preview boundary into neutral evidence. */
export function previewDecisionEvidence(
  mode: Mode | undefined,
  code: string,
): RereviewOperatorDecisionEvidence | null {
  if (
    mode !== "preview" ||
    !PREVIEW_DECISION_CODES.has(
      code as RereviewOperatorDecisionEvidence["decisionCode"],
    )
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    mode: "preview",
    decisionRequired: true,
    decisionCode: code as RereviewOperatorDecisionEvidence["decisionCode"],
    computeMutation: false,
    executed: false,
  };
}

export function resolveReceiptRow<T>(receipts: readonly T[]): T | null {
  if (receipts.length > 1) {
    throw new PersonalDedicatedRereviewOperatorError(
      "selection_receipt_invariant_violated",
    );
  }
  return receipts[0] ?? null;
}

export function resolveBootstrapCandidate<T>(
  candidates: readonly T[],
  activationKind: (candidate: T) => "fresh-boot" | string,
): T {
  if (candidates.length === 0) {
    throw new PersonalDedicatedRereviewOperatorError(
      "selection_bootstrap_zero_candidates",
    );
  }
  if (candidates.length === 1) {
    throw new PersonalDedicatedRereviewOperatorError(
      "selection_bootstrap_single_candidate",
    );
  }
  if (candidates.length > 100) {
    throw new PersonalDedicatedRereviewOperatorError(
      "selection_bootstrap_inventory_over_limit",
    );
  }
  const restorable = candidates.filter(
    (candidate) => activationKind(candidate) !== "fresh-boot",
  );
  if (restorable.length === 0) {
    throw new PersonalDedicatedRereviewOperatorError(
      "selection_bootstrap_no_restore_authority",
    );
  }
  if (restorable.length > 1) {
    throw new PersonalDedicatedRereviewOperatorError(
      "selection_bootstrap_multiple_restore_authorities",
    );
  }
  return restorable[0];
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value)
    throw new PersonalDedicatedRereviewOperatorError(
      `missing_${name.toLowerCase()}`,
    );
  return value;
}

/** Reads explicit operator authority without logging any secret or identifier. */
export function readRereviewOperatorConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RereviewOperatorConfig {
  if (environment.ELIZA_PERSONAL_DEDICATED_REREVIEW_STAGING !== "1") {
    throw new PersonalDedicatedRereviewOperatorError(
      "explicit_staging_opt_in_required",
    );
  }
  const mode = required(environment, "ELIZA_PERSONAL_DEDICATED_REREVIEW_MODE");
  if (mode !== "preview" && mode !== "execute") {
    throw new PersonalDedicatedRereviewOperatorError("invalid_mode");
  }
  const expectedCloudCommit = required(
    environment,
    "ELIZA_PERSONAL_DEDICATED_REREVIEW_EXPECTED_CLOUD_COMMIT",
  ).toLowerCase();
  if (!COMMIT_PATTERN.test(expectedCloudCommit)) {
    throw new PersonalDedicatedRereviewOperatorError(
      "invalid_expected_cloud_commit",
    );
  }
  return {
    mode,
    apiKey: required(environment, "ELIZAOS_CLOUD_API_KEY"),
    expectedCloudCommit,
    approvalDigest:
      environment.ELIZA_PERSONAL_DEDICATED_REREVIEW_APPROVAL_DIGEST?.trim(),
    confirmation:
      environment.ELIZA_PERSONAL_DEDICATED_REREVIEW_CONFIRMATION?.trim(),
    reviewedReason:
      environment.ELIZA_PERSONAL_DEDICATED_REREVIEW_REVIEWED_REASON?.trim(),
  };
}

function normalized(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalized(entry)]),
    );
  }
  return value;
}

function digestRows(rows: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(normalized(rows)))
    .digest("hex");
}

function approvalDigest(
  apiKey: string,
  resolved: ResolvedSelection,
  preview: Awaited<ReturnType<RereviewOperatorDependencies["preview"]>>,
): string {
  return createHmac("sha256", apiKey)
    .update(
      JSON.stringify({
        schemaVersion: 1,
        ...resolved,
        ...preview,
      }),
    )
    .digest("hex");
}

function assertNoComputeMutation(
  before: MutationSnapshot,
  after: MutationSnapshot,
): void {
  if (
    before.agentCount !== after.agentCount ||
    before.agentDigest !== after.agentDigest ||
    before.jobCount !== after.jobCount ||
    before.jobDigest !== after.jobDigest
  ) {
    throw new PersonalDedicatedRereviewOperatorError(
      "compute_or_job_state_changed",
    );
  }
}

export async function runRereviewOperator(
  config: RereviewOperatorConfig,
  dependencies: RereviewOperatorDependencies,
): Promise<RereviewOperatorEvidence> {
  await dependencies.verifyDeployment(config.expectedCloudCommit);
  // A used or absent selection can reject before preview. Diagnose the owner
  // first so that a stalled activation does not suppress lifecycle evidence.
  await dependencies.reportAccountLifecycle(config.apiKey);
  const resolved = await dependencies.resolveSelection(config.apiKey);
  const preview = await dependencies.preview(resolved);
  if (preview.operation !== resolved.operation) {
    throw new PersonalDedicatedRereviewOperatorError(
      "selection_operation_changed",
    );
  }
  const digest = approvalDigest(config.apiKey, resolved, preview);
  const before = await dependencies.snapshot(resolved);
  const requiredConfirmation =
    resolved.operation === "rereview"
      ? EXECUTE_CONFIRMATION
      : BOOTSTRAP_CONFIRMATION;
  const requiredReviewedReason =
    resolved.operation === "rereview"
      ? REVIEWED_REASON
      : BOOTSTRAP_REVIEWED_REASON;

  if (config.mode === "execute") {
    if (!config.approvalDigest || !DIGEST_PATTERN.test(config.approvalDigest)) {
      throw new PersonalDedicatedRereviewOperatorError(
        "invalid_approval_digest",
      );
    }
    if (config.approvalDigest !== digest) {
      throw new PersonalDedicatedRereviewOperatorError(
        "stale_or_wrong_approval_digest",
      );
    }
    if (config.confirmation !== requiredConfirmation) {
      throw new PersonalDedicatedRereviewOperatorError(
        "exact_confirmation_required",
      );
    }
    if (config.reviewedReason !== requiredReviewedReason) {
      throw new PersonalDedicatedRereviewOperatorError(
        "reviewed_reason_required",
      );
    }
    if (resolved.operation === "rereview") {
      if (preview.operation !== "rereview") {
        throw new PersonalDedicatedRereviewOperatorError(
          "selection_operation_changed",
        );
      }
      await dependencies.execute({
        ...resolved,
        expectedReceiptFingerprint: preview.receiptFingerprint,
        expectedReceiptUpdatedAt: preview.receiptUpdatedAt,
        expectedPreviousRetainedAgentId: preview.previousRetainedAgentId,
        expectedInventoryFingerprint: preview.inventoryFingerprint,
        expectedStateDisposition: preview.stateDisposition,
      });
    } else {
      if (preview.operation !== "bootstrap") {
        throw new PersonalDedicatedRereviewOperatorError(
          "selection_operation_changed",
        );
      }
      await dependencies.execute({
        ...resolved,
        expectedReceiptFingerprint: null,
        expectedReceiptUpdatedAt: null,
        expectedPreviousRetainedAgentId: null,
        expectedInventoryFingerprint: preview.inventoryFingerprint,
        expectedStateDisposition: preview.stateDisposition,
      });
    }
  }

  // Detection happens after the receipt transaction and cannot roll it back.
  // Write-set prevention belongs to the canonical selection transaction.
  const after = await dependencies.snapshot(resolved);
  assertNoComputeMutation(before, after);
  return {
    schemaVersion: 1,
    mode: config.mode,
    deployedCommitVerified: true,
    identityResolved: true,
    operation: resolved.operation,
    candidateCount: preview.candidateCount,
    stateDisposition: preview.stateDisposition,
    replacesTarget: preview.replacesTarget,
    approvalDigest: digest,
    requiredReviewedReason,
    requiredConfirmation,
    computeMutation: false,
    agentCount: after.agentCount,
    jobCount: after.jobCount,
    executed: config.mode === "execute",
    selectedTarget: after.selectedTarget,
  };
}

async function defaultVerifyDeployment(expectedCommit: string): Promise<void> {
  const response = await fetch(`${STAGING_API_BASE_URL}/api/health`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new PersonalDedicatedRereviewOperatorError("staging_health_failed");
  const body = (await response.json()) as JsonRecord;
  if (body.commit !== expectedCommit) {
    throw new PersonalDedicatedRereviewOperatorError(
      "staging_deploy_commit_mismatch",
    );
  }
}

async function defaultResolveSmokeOwner(apiKey: string): Promise<{
  id: string;
  organizationId: string;
}> {
  const [{ and, eq, isNull }, { dbWrite }, { apiKeys }, { users }] =
    await Promise.all([
      import("drizzle-orm"),
      import("@elizaos/cloud-shared/db/client"),
      import("@elizaos/cloud-shared/db/schemas/api-keys"),
      import("@elizaos/cloud-shared/db/schemas/users"),
    ]);
  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  // Identity and receipt resolution are execution authority. A replica can
  // lag key revocation or receipt replacement, so every read uses primary.
  const keyRows = await dbWrite
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.key_hash, keyHash),
        eq(apiKeys.is_active, true),
        isNull(apiKeys.deleted_at),
      ),
    )
    .limit(2);
  if (keyRows.length !== 1)
    throw new PersonalDedicatedRereviewOperatorError("smoke_key_not_active");
  const key = keyRows[0];
  if (key.expires_at && key.expires_at <= new Date()) {
    throw new PersonalDedicatedRereviewOperatorError("smoke_key_expired");
  }
  const ownerRows = await dbWrite
    .select({ id: users.id, organizationId: users.organization_id })
    .from(users)
    .where(
      and(
        eq(users.id, key.user_id),
        eq(users.is_active, true),
        isNull(users.deleted_at),
      ),
    )
    .limit(2);
  const owner = ownerRows[0];
  if (
    ownerRows.length !== 1 ||
    !owner?.organizationId ||
    owner.organizationId !== key.organization_id
  ) {
    throw new PersonalDedicatedRereviewOperatorError("smoke_owner_not_active");
  }
  return { id: owner.id, organizationId: owner.organizationId };
}

async function defaultResolveSelection(
  apiKey: string,
): Promise<ResolvedSelection> {
  const [
    { and, asc, eq, inArray, notExists },
    { dbWrite },
    selectionSchema,
    sandboxSchema,
    shared,
    targetService,
    provenance,
  ] = await Promise.all([
    import("drizzle-orm"),
    import("@elizaos/cloud-shared/db/client"),
    import(
      "@elizaos/cloud-shared/db/schemas/personal-dedicated-adoption-selections"
    ),
    import("@elizaos/cloud-shared/db/schemas/agent-sandboxes"),
    import(
      "@elizaos/cloud-shared/lib/services/shared-runtime/personal-shared-agent"
    ),
    import("@elizaos/cloud-shared/lib/services/agent-tier-upgrade-target"),
    import(
      "@elizaos/cloud-shared/lib/services/personal-dedicated-adoption-provenance"
    ),
  ]);
  const { personalDedicatedAdoptionSelections } = selectionSchema;
  const { agentSandboxBackups, agentSandboxes } = sandboxSchema;
  const { personalSharedAgentId } = shared;
  const { adoptableUnmarkedTargetWhere } = targetService;
  const {
    personalDedicatedActivationAuthority,
    personalDedicatedBackupProvenanceFromStored,
  } = provenance;
  const owner = await defaultResolveSmokeOwner(apiKey);
  const sourceAgentId = personalSharedAgentId({
    organizationId: owner.organizationId,
    userId: owner.id,
  });
  const receipts = await dbWrite
    .select({
      retainedAgentId: personalDedicatedAdoptionSelections.dedicated_agent_id,
    })
    .from(personalDedicatedAdoptionSelections)
    .where(
      and(
        eq(
          personalDedicatedAdoptionSelections.organization_id,
          owner.organizationId,
        ),
        eq(personalDedicatedAdoptionSelections.user_id, owner.id),
        eq(personalDedicatedAdoptionSelections.source_agent_id, sourceAgentId),
        eq(personalDedicatedAdoptionSelections.schema_version, 1),
      ),
    )
    .limit(2);
  const receipt = resolveReceiptRow(receipts);
  if (!receipt) {
    const candidates = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(
        and(
          adoptableUnmarkedTargetWhere(owner.organizationId, owner.id),
          notExists(
            dbWrite
              .select({ id: personalDedicatedAdoptionSelections.id })
              .from(personalDedicatedAdoptionSelections)
              .where(
                eq(
                  personalDedicatedAdoptionSelections.dedicated_agent_id,
                  agentSandboxes.id,
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(agentSandboxes.id))
      .limit(101);
    const storedBackups = await dbWrite
      .select()
      .from(agentSandboxBackups)
      .where(
        inArray(
          agentSandboxBackups.sandbox_record_id,
          candidates.map((candidate) => candidate.id),
        ),
      )
      .orderBy(
        asc(agentSandboxBackups.sandbox_record_id),
        asc(agentSandboxBackups.id),
      );
    const backups = storedBackups.map(
      personalDedicatedBackupProvenanceFromStored,
    );
    const retained = resolveBootstrapCandidate(
      candidates,
      (candidate) =>
        personalDedicatedActivationAuthority(
          owner.organizationId,
          candidate.id,
          backups,
        ).kind,
    );
    return {
      organizationId: owner.organizationId,
      userId: owner.id,
      sourceAgentId,
      retainedAgentId: retained.id,
      operation: "bootstrap",
    };
  }
  return {
    organizationId: owner.organizationId,
    userId: owner.id,
    sourceAgentId,
    retainedAgentId: receipt.retainedAgentId,
    operation: "rereview",
  };
}

async function defaultSnapshot(
  input: ResolvedSelection,
): Promise<MutationSnapshot> {
  const [{ and, eq }, { dbWrite }, sandboxSchema, jobsSchema] =
    await Promise.all([
      import("drizzle-orm"),
      import("@elizaos/cloud-shared/db/client"),
      import("@elizaos/cloud-shared/db/schemas/agent-sandboxes"),
      import("@elizaos/cloud-shared/db/schemas/jobs"),
    ]);
  const { agentSandboxes } = sandboxSchema;
  const { jobs } = jobsSchema;
  // These digests claim exact pre/post mutation proof, so replica freshness is
  // not an acceptable authority even though both queries are read-only.
  const agentRows = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.organization_id, input.organizationId),
        eq(agentSandboxes.user_id, input.userId),
      ),
    )
    .orderBy(agentSandboxes.id);
  const jobRows = await dbWrite
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.organization_id, input.organizationId),
        eq(jobs.user_id, input.userId),
      ),
    )
    .orderBy(jobs.id);
  const selectedTarget = agentRows.find(
    (row) => row.id === input.retainedAgentId,
  );
  if (!selectedTarget) {
    throw new PersonalDedicatedRereviewOperatorError("selected_target_missing");
  }
  return {
    agentCount: agentRows.length,
    agentDigest: digestRows(agentRows),
    jobCount: jobRows.length,
    jobDigest: digestRows(jobRows),
    selectedTarget: diagnoseRereviewTarget(selectedTarget),
  };
}

async function defaultReportAccountLifecycle(apiKey: string): Promise<void> {
  const owner = await defaultResolveSmokeOwner(apiKey);
  const [
    { and, eq },
    { dbWrite },
    { agentSandboxes },
    { jobs },
    { personalDedicatedUpgradeAuthorities: authorities },
    { personalDedicatedAdoptionSelections: selections },
  ] = await Promise.all([
    import("drizzle-orm"),
    import("@elizaos/cloud-shared/db/client"),
    import("@elizaos/cloud-shared/db/schemas/agent-sandboxes"),
    import("@elizaos/cloud-shared/db/schemas/jobs"),
    import(
      "@elizaos/cloud-shared/db/schemas/personal-dedicated-upgrade-authorities"
    ),
    import(
      "@elizaos/cloud-shared/db/schemas/personal-dedicated-adoption-selections"
    ),
  ]);
  const [agentRows, jobRows, authorityRows, selectionRows] = await Promise.all([
    dbWrite
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.organization_id, owner.organizationId),
          eq(agentSandboxes.user_id, owner.id),
        ),
      )
      .orderBy(agentSandboxes.id),
    dbWrite
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.organization_id, owner.organizationId),
          eq(jobs.user_id, owner.id),
        ),
      )
      .orderBy(jobs.created_at),
    dbWrite
      .select()
      .from(authorities)
      .where(
        and(
          eq(authorities.organization_id, owner.organizationId),
          eq(authorities.user_id, owner.id),
        ),
      ),
    dbWrite
      .select()
      .from(selections)
      .where(
        and(
          eq(selections.organization_id, owner.organizationId),
          eq(selections.user_id, owner.id),
        ),
      ),
  ]);
  const evidence = {
    schemaVersion: 1,
    kind: "account-lifecycle",
    agents: agentRows.map((agent) => ({
      ...diagnoseRereviewTarget(agent),
      updatedAt: agent.updated_at,
      selected: selectionRows.some(
        (row) => row.dedicated_agent_id === agent.id,
      ),
      activationBound: authorityRows.some(
        (row) => row.dedicated_agent_id === agent.id,
      ),
      cutoverActivated: authorityRows.some(
        (row) =>
          row.dedicated_agent_id === agent.id &&
          row.cutover_activated_at !== null,
      ),
      jobs: jobRows
        .filter((row) => row.agent_id === agent.id)
        .map((job) => {
          if (
            ![
              "pending",
              "in_progress",
              "completed",
              "failed",
              "cancelled",
            ].includes(job.status)
          ) {
            throw new PersonalDedicatedRereviewOperatorError(
              "diagnostic_job_status_invalid",
            );
          }
          return {
            status: job.status,
            failure: classifyManagedDedicatedProvisionFailure(
              job.error,
              "lifecycle job error",
            ),
            attempts: job.attempts,
            retryableRequeues: job.retryable_requeues,
            updatedAt: job.updated_at,
          };
        }),
    })),
  };
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

const defaultDependencies: RereviewOperatorDependencies = {
  verifyDeployment: defaultVerifyDeployment,
  reportAccountLifecycle: defaultReportAccountLifecycle,
  resolveSelection: defaultResolveSelection,
  preview: async (input) => {
    const { personalDedicatedAdoptionSelectionService } = await import(
      "@elizaos/cloud-shared/lib/services/personal-dedicated-adoption-selection"
    );
    const common = {
      ...input,
      selectedByUserId: null,
      reason: "duplicate_owned_dedicated_inventory",
    } as const;
    if (input.operation === "rereview") {
      return {
        ...(await personalDedicatedAdoptionSelectionService.previewRereview(
          common,
        )),
        operation: "rereview" as const,
      };
    }
    const preview =
      await personalDedicatedAdoptionSelectionService.preview(common);
    return {
      ...preview,
      operation: "bootstrap" as const,
      receiptFingerprint: null,
      receiptUpdatedAt: null,
      previousRetainedAgentId: null,
      replacesTarget: false,
    };
  },
  execute: async (input) => {
    const { personalDedicatedAdoptionSelectionService } = await import(
      "@elizaos/cloud-shared/lib/services/personal-dedicated-adoption-selection"
    );
    const common = {
      ...input,
      selectedByUserId: null,
      reason: "duplicate_owned_dedicated_inventory",
    } as const;
    if (input.operation === "rereview") {
      await personalDedicatedAdoptionSelectionService.executeRereview({
        ...common,
        expectedReceiptFingerprint: input.expectedReceiptFingerprint,
        expectedReceiptUpdatedAt: input.expectedReceiptUpdatedAt,
        expectedPreviousRetainedAgentId: input.expectedPreviousRetainedAgentId,
      });
      return;
    }
    await personalDedicatedAdoptionSelectionService.execute({
      ...common,
      expectedInventoryFingerprint: input.expectedInventoryFingerprint,
      expectedStateDisposition: input.expectedStateDisposition,
    });
  },
  snapshot: defaultSnapshot,
};

if (import.meta.main) {
  let config: RereviewOperatorConfig | undefined;
  try {
    config = readRereviewOperatorConfig();
    const evidence = await runRereviewOperator(config, defaultDependencies);
    // This identifier-free receipt is CLI output, required even when verbose
    // application logging is disabled so an operator can review the next step.
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch (error) {
    // error-policy:J1 the command boundary emits only a typed diagnostic code;
    // sensitive resolved identifiers and credentials never reach logs.
    const code =
      error instanceof PersonalDedicatedRereviewOperatorError
        ? error.code
        : "personal_dedicated_rereview_failed";
    const { logger } = await import("@elizaos/cloud-shared/lib/utils/logger");
    const decision = previewDecisionEvidence(config?.mode, code);
    if (decision) {
      process.stdout.write(`${JSON.stringify(decision)}\n`);
      process.exitCode = 0;
    } else {
      logger.error("[personal-dedicated-rereview-staging] Operator failed", {
        code,
      });
      process.exitCode = 1;
    }
  }
}
