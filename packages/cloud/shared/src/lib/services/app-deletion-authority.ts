/** Original immutable identity of an app deletion owned by the existing jobs queue. */

import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";

export const APP_DELETION_JOB_TYPE = "app_delete";

export interface AppDeletionJobData {
  version: 1 | 2;
  appId: string;
  organizationId: string;
  deleteGitHubRepo: boolean;
  revokedKeys: Array<{ id: string; organizationId: string }>;
}

export interface AppDeletionChildIdentity {
  jobId: string;
  kind: "database" | "container";
  resourceId: string;
  digest: string;
}

export interface AppDeletionChildData {
  version: 1;
  appId: string;
  organizationId: string;
  appDeletionJobId: string;
  kind: "database" | "container";
  resourceId: string;
  resourceDigest: string;
  containerId?: string;
  originalHostContainerId?: string;
  originalNodeId?: string;
  originalNodeHost?: string;
  originalClusterId?: string;
}

export function readAppDeletionPlan(result: unknown): AppDeletionChildIdentity[] | null {
  if (!result || typeof result !== "object") return null;
  const plan = (result as Record<string, unknown>).deletionPlan;
  if (plan === undefined) return null;
  if (!Array.isArray(plan))
    throw new ElizaError("App deletion plan is invalid", { code: "APP_DELETION_PLAN_INVALID" });
  const seen = new Set<string>();
  return plan.map((value) => {
    if (!value || typeof value !== "object")
      throw new ElizaError("App deletion plan is invalid", { code: "APP_DELETION_PLAN_INVALID" });
    const item = value as Record<string, unknown>;
    if (
      typeof item.jobId !== "string" ||
      typeof item.resourceId !== "string" ||
      (item.kind !== "database" && item.kind !== "container") ||
      typeof item.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.digest) ||
      seen.has(item.jobId)
    )
      throw new ElizaError("App deletion plan is invalid", { code: "APP_DELETION_PLAN_INVALID" });
    seen.add(item.jobId);
    return { jobId: item.jobId, resourceId: item.resourceId, kind: item.kind, digest: item.digest };
  });
}

export function appDeletionDigest(parts: readonly (string | null)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function appDeletionChildId(jobId: string, kind: string, resourceId: string): string {
  const hex = appDeletionDigest([jobId, kind, resourceId]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function readAppDeletionChildData(value: unknown): AppDeletionChildData {
  if (!value || typeof value !== "object")
    throw new ElizaError("App deletion child has no identity", {
      code: "APP_DELETION_CHILD_INVALID",
    });
  const data = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const field of ["appId", "organizationId", "appDeletionJobId", "resourceId"]) {
    if (typeof data[field] !== "string" || !uuid.test(data[field] as string))
      throw new ElizaError("App deletion child identity is invalid", {
        code: "APP_DELETION_CHILD_INVALID",
      });
  }
  if (
    data.version !== 1 ||
    (data.kind !== "database" && data.kind !== "container") ||
    typeof data.resourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.resourceDigest)
  )
    throw new ElizaError("App deletion child identity is invalid", {
      code: "APP_DELETION_CHILD_INVALID",
    });
  if (
    data.kind === "database" &&
    (typeof data.originalClusterId !== "string" || !uuid.test(data.originalClusterId))
  )
    throw new ElizaError("App deletion database has no original placement", {
      code: "APP_DELETION_CHILD_INVALID",
    });
  if (
    data.kind === "container" &&
    (data.containerId !== data.resourceId ||
      typeof data.originalHostContainerId !== "string" ||
      !data.originalHostContainerId ||
      typeof data.originalNodeId !== "string" ||
      !data.originalNodeId ||
      typeof data.originalNodeHost !== "string" ||
      !data.originalNodeHost)
  )
    throw new ElizaError("App deletion container has no original provider identity", {
      code: "APP_DELETION_CHILD_INVALID",
    });
  return data as unknown as AppDeletionChildData;
}

export class AppDeletionRecoveryPendingError extends ElizaError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, { code: "APP_DELETION_RECOVERY_PENDING", context, severity: "ephemeral" });
  }
}

export class AppDeletionOperatorRecoveryRequiredError extends ElizaError {
  constructor() {
    super("Original repository deletion requires operator reconciliation; do not dispatch again", {
      code: "APP_DELETION_OPERATOR_RECONCILIATION_REQUIRED",
      severity: "ephemeral",
    });
  }
}

export interface AppDeletionProgress {
  state: "pending" | "completed";
  jobId: string;
  appId: string;
  status: string;
  phase: "teardown" | "operator_reconciliation_required";
}

export function appDeletionProgress(job: {
  id: string;
  type: string;
  status: string;
  data: unknown;
  result: unknown;
}): AppDeletionProgress {
  const data = readAppDeletionJobData(job.data);
  if (job.type !== APP_DELETION_JOB_TYPE)
    throw new ElizaError("App deletion job type changed", {
      code: "APP_DELETION_IDENTITY_INVALID",
    });
  const result =
    job.result && typeof job.result === "object" ? (job.result as Record<string, unknown>) : null;
  if (
    job.status === "completed" &&
    (result?.appDeleted !== true ||
      result.appId !== data.appId ||
      result.deletionJobId !== job.id ||
      (data.version === 2 && result.cleanupConfirmed !== true))
  ) {
    throw new ElizaError("App deletion completion receipt is missing", {
      code: "APP_DELETION_COMPLETION_UNCONFIRMED",
    });
  }
  return {
    state: job.status === "completed" ? "completed" : "pending",
    jobId: job.id,
    appId: data.appId,
    status: job.status,
    phase:
      result?.operatorReconciliationRequired === true
        ? "operator_reconciliation_required"
        : "teardown",
  };
}

export class AppDeletionInProgressError extends ElizaError {
  constructor(appId: string, jobId: string) {
    super("App deletion is in progress and cannot be reversed", {
      code: "APP_DELETION_IN_PROGRESS",
      context: { appId, jobId },
    });
  }
}

export function readAppDeletionJobData(value: unknown): AppDeletionJobData {
  if (!value || typeof value !== "object") {
    throw new ElizaError("App deletion job has no original identity", {
      code: "APP_DELETION_IDENTITY_INVALID",
    });
  }
  const data = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    (data.version !== 1 && data.version !== 2) ||
    typeof data.appId !== "string" ||
    !uuid.test(data.appId) ||
    typeof data.organizationId !== "string" ||
    !uuid.test(data.organizationId) ||
    typeof data.deleteGitHubRepo !== "boolean"
  ) {
    throw new ElizaError("App deletion job has an invalid original identity", {
      code: "APP_DELETION_IDENTITY_INVALID",
    });
  }
  if (
    !Array.isArray(data.revokedKeys) ||
    data.revokedKeys.some(
      (key) =>
        !key ||
        typeof key !== "object" ||
        typeof key.id !== "string" ||
        !uuid.test(key.id) ||
        typeof key.organizationId !== "string" ||
        !uuid.test(key.organizationId),
    )
  ) {
    throw new ElizaError("App deletion has no original credential revocation targets", {
      code: "APP_DELETION_IDENTITY_INVALID",
    });
  }
  return {
    version: data.version,
    appId: data.appId,
    organizationId: data.organizationId,
    deleteGitHubRepo: data.deleteGitHubRepo,
    revokedKeys: data.revokedKeys as AppDeletionJobData["revokedKeys"],
  };
}
