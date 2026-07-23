/**
 * Defines the fail-closed image and target contract for super-admin demo canaries.
 * The seam admits one distinct first-party demo repository and exact immutable
 * digests; ordinary fleet reconciliation never consumes these types.
 */

import { imageRepo } from "../../db/utils/docker-image-ref";
import { ValidationError } from "../api/cloud-worker-errors";

export const ADMIN_CANARY_MAX_TARGETS = 5;
export const ADMIN_CANARY_MAX_RUNNING_JOBS = 3;
export const ADMIN_CANARY_DEMO_IMAGE_REPOSITORY = "ghcr.io/elizaos/eliza-demo";
export const ADMIN_CANARY_CANONICAL_IMAGE_REPOSITORY = "ghcr.io/elizaos/eliza";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export type AdminCanaryImageOperation = "upgrade" | "rollback";

export interface AdminCanaryTargetExpectation {
  agentId: string;
  organizationId: string;
  expectedSourceImage: string;
  expectedSourceDigest: string;
}

export interface AdminCanaryUpgradeInput {
  operation: "upgrade";
  dryRun: boolean;
  targetImage: string;
  targets: AdminCanaryTargetExpectation[];
}

export interface AdminCanaryRollbackSource {
  rolloutId?: string;
  jobId?: string;
}

export interface AdminCanaryRollbackInput {
  operation: "rollback";
  dryRun: boolean;
  source: AdminCanaryRollbackSource;
}

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
}

export interface AdminCanaryImageJobResult {
  success: boolean;
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

export function parseAdminCanaryDemoImage(image: string): {
  repository: string;
  digest: string;
} {
  const prefix = `${ADMIN_CANARY_DEMO_IMAGE_REPOSITORY}@`;
  if (!image.startsWith(prefix)) {
    throw ValidationError(
      `targetImage must use the allowlisted ${ADMIN_CANARY_DEMO_IMAGE_REPOSITORY} repository`,
    );
  }
  const digest = image.slice(prefix.length);
  assertSha256Digest(digest, "targetImage digest");
  if (image !== `${ADMIN_CANARY_DEMO_IMAGE_REPOSITORY}@${digest}`) {
    throw ValidationError("targetImage must be an exact repository@sha256 digest reference");
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

function assertTargetExpectations(targets: AdminCanaryTargetExpectation[]): void {
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
    assertCanonicalSourceImage(target.expectedSourceImage, `targets[${index}].expectedSourceImage`);
  }
}

export function assertAdminCanaryRolloutInput(input: AdminCanaryRolloutInput): void {
  if (input.operation === "upgrade") {
    assertTargetExpectations(input.targets);
    parseAdminCanaryDemoImage(input.targetImage);
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
    assertCanonicalSourceImage(data.sourceImage, "sourceImage");
    const target = parseAdminCanaryDemoImage(data.targetImage);
    if (target.digest !== data.targetDigest) {
      throw ValidationError("targetImage digest must equal targetDigest");
    }
  } else {
    if (data.sourceRolloutId === undefined || data.sourceJobId === undefined) {
      throw ValidationError("rollback jobs require the exact source rollout and job");
    }
    const source = parseAdminCanaryDemoImage(data.sourceImage);
    if (source.digest !== data.sourceDigest) {
      throw ValidationError("sourceImage digest must equal sourceDigest");
    }
    assertCanonicalSourceImage(data.targetImage, "targetImage");
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
}

export function isCompletedAdminCanaryJobResult(
  value: unknown,
): value is AdminCanaryImageJobResult & { success: true } {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    result.success === true &&
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
