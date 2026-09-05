/**
 * Defines the fail-closed image and target contract for super-admin demo canaries.
 * The seam admits one distinct first-party demo repository and exact immutable
 * digests; ordinary fleet reconciliation never consumes these types.
 */

import { imageRepo } from "../../db/utils/docker-image-ref";
import { ValidationError } from "../api/cloud-worker-errors";
import { sha256Hex } from "../crypto/worker";

export const ADMIN_CANARY_MAX_TARGETS = 5;
export const ADMIN_CANARY_MAX_RUNNING_JOBS = 3;
export const ADMIN_CANARY_DEMO_IMAGE_REPOSITORY = "ghcr.io/elizaos/eliza-demo";
export const ADMIN_CANARY_CANONICAL_IMAGE_REPOSITORY = "ghcr.io/elizaos/eliza";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_REQUEST_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export type AdminCanaryImageOperation = "upgrade" | "rollback";

export interface AdminCanaryTargetExpectation {
  agentId: string;
  organizationId: string;
  expectedSourceImage: string;
  expectedSourceDigest: string;
}

interface AdminCanaryRequestIdentity {
  requestId: string;
}

interface AdminCanaryPreviewRequest {
  dryRun: true;
  expectedPlanFingerprint?: never;
}

interface AdminCanaryExecuteRequest {
  dryRun: false;
  expectedPlanFingerprint: string;
}

interface AdminCanaryUpgradeRequest {
  operation: "upgrade";
  targetImage: string;
  targets: AdminCanaryTargetExpectation[];
}

export interface AdminCanaryRollbackSource {
  rolloutId?: string;
  jobId?: string;
}

interface AdminCanaryRollbackRequest {
  operation: "rollback";
  source: AdminCanaryRollbackSource;
}

export type AdminCanaryUpgradeInput = AdminCanaryRequestIdentity &
  AdminCanaryUpgradeRequest &
  (AdminCanaryPreviewRequest | AdminCanaryExecuteRequest);

export type AdminCanaryRollbackInput = AdminCanaryRequestIdentity &
  AdminCanaryRollbackRequest &
  (AdminCanaryPreviewRequest | AdminCanaryExecuteRequest);

export type AdminCanaryRolloutInput = AdminCanaryUpgradeInput | AdminCanaryRollbackInput;

export interface AdminCanaryPlannedTarget {
  operation: AdminCanaryImageOperation;
  agentId: string;
  organizationId: string;
  targetOwnerUserId: string;
  sourceImage: string;
  sourceDigest: string;
  targetImage: string;
  targetDigest: string;
  sourceRolloutId?: string;
  sourceJobId?: string;
}

export interface AdminCanaryImageJobData extends AdminCanaryPlannedTarget {
  rolloutId: string;
  actorUserId: string;
  userId: string;
  decisionAt: string;
  /**
   * Rows created before request recovery existed omit this all-or-nothing
   * metadata group. They remain executable and valid rollback evidence, but
   * can never satisfy a request-id replay lookup.
   */
  requestId?: string;
  planFingerprint?: string;
  canonicalRequestHash?: string;
}

export type RecoverableAdminCanaryImageJobData = AdminCanaryImageJobData &
  Required<Pick<AdminCanaryImageJobData, "requestId" | "planFingerprint" | "canonicalRequestHash">>;

export interface AdminCanaryImageJobResult {
  success: boolean;
  /**
   * A cutover audit can be durable before the replaced container is retired.
   * The job remains non-terminal while this flag is true.
   */
  cleanupPending?: boolean;
  cutoverAt?: string;
  jobId: string;
  operation: AdminCanaryImageOperation;
  rolloutId: string;
  actorUserId: string;
  decisionAt: string;
  agentId: string;
  organizationId: string;
  targetOwnerUserId: string;
  sourceImage: string;
  sourceDigest: string;
  targetImage: string;
  targetDigest: string;
  startedAt: string;
  finishedAt: string;
  oldNodeId?: string;
  oldContainerName?: string;
  newNodeId?: string;
  newContainerName?: string;
  error?: string;
}

export function assertSha256Digest(value: string, field: string): void {
  if (!SHA256_DIGEST_RE.test(value)) {
    throw ValidationError(`${field} must be sha256 followed by 64 lowercase hexadecimal digits`);
  }
}

export function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw ValidationError(`${field} must be a UUID`);
  }
}

export function assertAdminCanaryRequestId(value: string): void {
  if (!CANONICAL_REQUEST_ID_RE.test(value)) {
    throw ValidationError("requestId must be a canonical lowercase UUID");
  }
}

export function parseAdminCanaryDemoImage(
  image: string,
  field = "targetImage",
): {
  repository: string;
  digest: string;
} {
  const prefix = `${ADMIN_CANARY_DEMO_IMAGE_REPOSITORY}@`;
  if (!image.startsWith(prefix)) {
    throw ValidationError(
      `${field} must use the allowlisted ${ADMIN_CANARY_DEMO_IMAGE_REPOSITORY} repository`,
    );
  }
  const digest = image.slice(prefix.length);
  assertSha256Digest(digest, `${field} digest`);
  if (image !== `${ADMIN_CANARY_DEMO_IMAGE_REPOSITORY}@${digest}`) {
    throw ValidationError(`${field} must be an exact repository@sha256 digest reference`);
  }
  return { repository: ADMIN_CANARY_DEMO_IMAGE_REPOSITORY, digest };
}

export function assertCanonicalSourceImage(image: string, field: string): void {
  if (imageRepo(image) !== ADMIN_CANARY_CANONICAL_IMAGE_REPOSITORY) {
    throw ValidationError(
      `${field} must use the canonical ${ADMIN_CANARY_CANONICAL_IMAGE_REPOSITORY} repository`,
    );
  }
}

export function assertDemoSourceImage(image: string, field: string): void {
  if (imageRepo(image) !== ADMIN_CANARY_DEMO_IMAGE_REPOSITORY) {
    throw ValidationError(
      `${field} must use the canary ${ADMIN_CANARY_DEMO_IMAGE_REPOSITORY} repository`,
    );
  }
}

/**
 * An upgrade starts on the canonical release image, but a later canary starts
 * on the immutable demo image produced by the earlier canary. Demo sources
 * therefore require an exact image/digest pair; canonical sources retain their
 * existing tag-plus-digest contract.
 */
export function assertAdminCanaryCanonicalOrDemoPair(
  image: string,
  digest: string,
  field: string,
): void {
  if (imageRepo(image) === ADMIN_CANARY_CANONICAL_IMAGE_REPOSITORY) return;

  const source = parseAdminCanaryDemoImage(image, field);
  if (source.digest !== digest) {
    throw ValidationError(`${field} digest must equal its image digest`);
  }
}

function assertTargetExpectations(
  targets: AdminCanaryTargetExpectation[],
  targetImage: string,
  targetDigest: string,
): void {
  if (targets.length < 1 || targets.length > ADMIN_CANARY_MAX_TARGETS) {
    throw ValidationError(`targets must contain between 1 and ${ADMIN_CANARY_MAX_TARGETS} agents`);
  }

  const seen = new Set<string>();
  for (const [index, target] of targets.entries()) {
    assertUuid(target.agentId, `targets[${index}].agentId`);
    assertUuid(target.organizationId, `targets[${index}].organizationId`);
    assertSha256Digest(target.expectedSourceDigest, `targets[${index}].expectedSourceDigest`);
    const key = `${target.organizationId}:${target.agentId}`;
    if (seen.has(key)) {
      throw ValidationError(`targets contains duplicate agent ${target.agentId}`);
    }
    seen.add(key);
    assertAdminCanaryCanonicalOrDemoPair(
      target.expectedSourceImage,
      target.expectedSourceDigest,
      `targets[${index}].expectedSourceImage`,
    );
    if (
      target.expectedSourceImage === targetImage &&
      target.expectedSourceDigest === targetDigest
    ) {
      throw ValidationError(`targets[${index}] must change the current image pair`);
    }
  }
}

function compareTargetIdentity(
  left: Pick<AdminCanaryTargetExpectation, "organizationId" | "agentId">,
  right: Pick<AdminCanaryTargetExpectation, "organizationId" | "agentId">,
): number {
  const leftKey = `${left.organizationId}:${left.agentId}`;
  const rightKey = `${right.organizationId}:${right.agentId}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function assertAdminCanaryRolloutInput(input: AdminCanaryRolloutInput): void {
  assertAdminCanaryRequestId(input.requestId);
  if (input.dryRun) {
    if (input.expectedPlanFingerprint !== undefined) {
      throw ValidationError("dry-run requests cannot include expectedPlanFingerprint");
    }
  } else {
    assertSha256Digest(input.expectedPlanFingerprint, "expectedPlanFingerprint");
  }

  if (input.operation === "upgrade") {
    const target = parseAdminCanaryDemoImage(input.targetImage);
    assertTargetExpectations(input.targets, input.targetImage, target.digest);
    return;
  }

  const hasRolloutId = typeof input.source.rolloutId === "string";
  const hasJobId = typeof input.source.jobId === "string";
  if (hasRolloutId === hasJobId) {
    throw ValidationError("rollback source must contain exactly one of rolloutId or jobId");
  }
  const sourceId = input.source.rolloutId ?? input.source.jobId;
  if (!sourceId) {
    throw ValidationError("rollback source identifier is required");
  }
  assertUuid(sourceId, "rollback source");
}

function canonicalRequestPayload(
  input: AdminCanaryRolloutInput,
  actorUserId: string,
): Record<string, unknown> {
  if (input.operation === "upgrade") {
    return {
      actorUserId,
      requestId: input.requestId,
      operation: input.operation,
      dryRun: input.dryRun,
      expectedPlanFingerprint: input.dryRun ? null : input.expectedPlanFingerprint,
      targetImage: input.targetImage,
      targets: [...input.targets].sort(compareTargetIdentity).map((target) => ({
        agentId: target.agentId,
        organizationId: target.organizationId,
        expectedSourceImage: target.expectedSourceImage,
        expectedSourceDigest: target.expectedSourceDigest,
      })),
    };
  }

  return {
    actorUserId,
    requestId: input.requestId,
    operation: input.operation,
    dryRun: input.dryRun,
    expectedPlanFingerprint: input.dryRun ? null : input.expectedPlanFingerprint,
    source: input.source.rolloutId
      ? { rolloutId: input.source.rolloutId }
      : { jobId: input.source.jobId },
  };
}

function canonicalPlannedTarget(target: AdminCanaryPlannedTarget): Record<string, unknown> {
  return {
    operation: target.operation,
    agentId: target.agentId,
    organizationId: target.organizationId,
    targetOwnerUserId: target.targetOwnerUserId,
    sourceImage: target.sourceImage,
    sourceDigest: target.sourceDigest,
    targetImage: target.targetImage,
    targetDigest: target.targetDigest,
    sourceRolloutId: target.sourceRolloutId ?? null,
    sourceJobId: target.sourceJobId ?? null,
  };
}

async function sha256Fingerprint(domain: string, payload: unknown): Promise<string> {
  return `sha256:${await sha256Hex(`${domain}\0${JSON.stringify(payload)}`)}`;
}

export async function hashAdminCanaryRequest(
  input: AdminCanaryRolloutInput,
  actorUserId: string,
): Promise<string> {
  assertUuid(actorUserId, "actorUserId");
  assertAdminCanaryRolloutInput(input);
  return await sha256Fingerprint(
    "eliza-admin-canary-canonical-request:v1",
    canonicalRequestPayload(input, actorUserId),
  );
}

export async function fingerprintAdminCanaryPlan(params: {
  actorUserId: string;
  requestId: string;
  operation: AdminCanaryImageOperation;
  targets: AdminCanaryPlannedTarget[];
}): Promise<string> {
  assertUuid(params.actorUserId, "actorUserId");
  assertAdminCanaryRequestId(params.requestId);
  const targets = [...params.targets].sort(compareTargetIdentity).map(canonicalPlannedTarget);
  return await sha256Fingerprint("eliza-admin-canary-plan:v1", {
    actorUserId: params.actorUserId,
    requestId: params.requestId,
    operation: params.operation,
    targets,
  });
}

export function isAdminCanaryImageJobData(value: unknown): value is AdminCanaryImageJobData {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  if (data.operation !== "upgrade" && data.operation !== "rollback") return false;
  const stringFields = [
    "rolloutId",
    "actorUserId",
    "agentId",
    "organizationId",
    "targetOwnerUserId",
    "userId",
    "sourceImage",
    "sourceDigest",
    "targetImage",
    "targetDigest",
    "decisionAt",
  ] as const;
  if (!stringFields.every((field) => typeof data[field] === "string")) return false;
  const recoveryFields = [data.requestId, data.planFingerprint, data.canonicalRequestHash];
  const hasRecoveryMetadata = recoveryFields.some((field) => field !== undefined);
  if (hasRecoveryMetadata && !recoveryFields.every((field) => typeof field === "string")) {
    return false;
  }
  return (
    (data.sourceRolloutId === undefined || typeof data.sourceRolloutId === "string") &&
    (data.sourceJobId === undefined || typeof data.sourceJobId === "string")
  );
}

export function assertAdminCanaryImageJobData(data: AdminCanaryImageJobData): void {
  assertUuid(data.rolloutId, "rolloutId");
  assertUuid(data.actorUserId, "actorUserId");
  assertUuid(data.agentId, "agentId");
  assertUuid(data.organizationId, "organizationId");
  assertUuid(data.targetOwnerUserId, "targetOwnerUserId");
  assertUuid(data.userId, "userId");
  assertSha256Digest(data.sourceDigest, "sourceDigest");
  assertSha256Digest(data.targetDigest, "targetDigest");
  if (!Number.isFinite(Date.parse(data.decisionAt))) {
    throw ValidationError("decisionAt must be an ISO timestamp");
  }
  if (data.operation === "upgrade") {
    if (data.sourceRolloutId !== undefined || data.sourceJobId !== undefined) {
      throw ValidationError("upgrade jobs cannot reference a rollback source");
    }
    assertAdminCanaryCanonicalOrDemoPair(data.sourceImage, data.sourceDigest, "sourceImage");
    const target = parseAdminCanaryDemoImage(data.targetImage);
    if (target.digest !== data.targetDigest) {
      throw ValidationError("targetImage digest must equal targetDigest");
    }
  } else {
    if (data.sourceRolloutId === undefined || data.sourceJobId === undefined) {
      throw ValidationError("rollback jobs require the exact source rollout and job");
    }
    const source = parseAdminCanaryDemoImage(data.sourceImage, "sourceImage");
    if (source.digest !== data.sourceDigest) {
      throw ValidationError("sourceImage digest must equal sourceDigest");
    }
    assertAdminCanaryCanonicalOrDemoPair(data.targetImage, data.targetDigest, "targetImage");
  }
  if (data.userId !== data.actorUserId) {
    throw ValidationError("userId must equal actorUserId");
  }
  if (data.sourceRolloutId !== undefined) {
    assertUuid(data.sourceRolloutId, "sourceRolloutId");
  }
  if (data.sourceJobId !== undefined) {
    assertUuid(data.sourceJobId, "sourceJobId");
  }
  if (data.requestId !== undefined) {
    assertAdminCanaryRequestId(data.requestId);
    if (!data.planFingerprint || !data.canonicalRequestHash) {
      throw ValidationError("request recovery metadata must be all present or all absent");
    }
    assertSha256Digest(data.planFingerprint, "planFingerprint");
    assertSha256Digest(data.canonicalRequestHash, "canonicalRequestHash");
  } else if (data.planFingerprint !== undefined || data.canonicalRequestHash !== undefined) {
    throw ValidationError("request recovery metadata must be all present or all absent");
  }
}

export function assertRecoverableAdminCanaryImageJobData(
  data: AdminCanaryImageJobData,
): asserts data is RecoverableAdminCanaryImageJobData {
  assertAdminCanaryImageJobData(data);
  if (!data.requestId || !data.planFingerprint || !data.canonicalRequestHash) {
    throw new Error("Admin canary job predates request recovery metadata");
  }
}

export function isCompletedAdminCanaryJobResult(
  value: unknown,
): value is AdminCanaryImageJobResult & { success: true } {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    result.success === true &&
    result.cleanupPending !== true &&
    typeof result.jobId === "string" &&
    (result.operation === "upgrade" || result.operation === "rollback") &&
    typeof result.rolloutId === "string" &&
    typeof result.actorUserId === "string" &&
    typeof result.decisionAt === "string" &&
    typeof result.agentId === "string" &&
    typeof result.organizationId === "string" &&
    typeof result.targetOwnerUserId === "string" &&
    typeof result.sourceImage === "string" &&
    typeof result.sourceDigest === "string" &&
    typeof result.targetImage === "string" &&
    typeof result.targetDigest === "string" &&
    typeof result.startedAt === "string" &&
    typeof result.finishedAt === "string"
  );
}

export function isPendingAdminCanaryCutoverAudit(
  value: unknown,
): value is AdminCanaryImageJobResult & {
  success: false;
  cleanupPending: true;
  cutoverAt: string;
} {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    result.success === false &&
    result.cleanupPending === true &&
    typeof result.cutoverAt === "string" &&
    typeof result.jobId === "string" &&
    (result.operation === "upgrade" || result.operation === "rollback") &&
    typeof result.rolloutId === "string" &&
    typeof result.actorUserId === "string" &&
    typeof result.decisionAt === "string" &&
    typeof result.agentId === "string" &&
    typeof result.organizationId === "string" &&
    typeof result.targetOwnerUserId === "string" &&
    typeof result.sourceImage === "string" &&
    typeof result.sourceDigest === "string" &&
    typeof result.targetImage === "string" &&
    typeof result.targetDigest === "string" &&
    typeof result.startedAt === "string" &&
    typeof result.finishedAt === "string" &&
    typeof result.oldNodeId === "string" &&
    typeof result.oldContainerName === "string" &&
    typeof result.newNodeId === "string" &&
    typeof result.newContainerName === "string"
  );
}
