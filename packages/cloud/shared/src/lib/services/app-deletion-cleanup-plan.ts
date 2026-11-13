/** Complete immutable frontend manifest retained by the original deletion job. */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import type { AppFrontendDeployment } from "../../db/schemas/app-frontend-deployments";
import { AppDeletionRecoveryPendingError } from "./app-deletion-authority";
import { canonicalSettlementJson } from "./settlement-digest";

type Deployment = Pick<AppFrontendDeployment, "id" | "r2_prefix" | "manifest" | "status"> &
  Partial<Pick<AppFrontendDeployment, "upload_generation" | "upload_plan" | "upload_quiesced_at">>;
export interface AppDeletionCleanupPlan {
  version: 1;
  deployments: Deployment[];
  digest: string;
  objectCount: number;
}

function invalid(): never {
  throw new ElizaError("Original app artifact cleanup plan is invalid", {
    code: "APP_DELETION_CLEANUP_PLAN_INVALID",
  });
}

export function cleanupObjectKeys(deployments: readonly Deployment[]): string[] {
  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const deployment of deployments) {
    if (
      !deployment ||
      typeof deployment.id !== "string" ||
      ids.has(deployment.id) ||
      typeof deployment.r2_prefix !== "string" ||
      deployment.r2_prefix.includes("\0")
    )
      invalid();
    ids.add(deployment.id);
    if (
      deployment.status !== "pending" &&
      ((deployment.upload_generation && !deployment.upload_quiesced_at) ||
        (!deployment.upload_generation && ["uploading", "failed"].includes(deployment.status)))
    )
      throw new AppDeletionRecoveryPendingError("Frontend upload completion is unconfirmed");
    const manifest = deployment.manifest ?? deployment.upload_plan;
    if (!manifest) {
      // A locked pending row cannot acknowledge beginUpload or start a PUT after this cascade.
      if (deployment.status === "pending") continue;
      throw new AppDeletionRecoveryPendingError("Frontend upload completion is unconfirmed");
    }
    if (!deployment.r2_prefix) invalid();
    if (!Array.isArray(manifest.files)) invalid();
    for (const file of manifest.files) {
      if (!file || typeof file.hash !== "string" || !/^[a-f0-9]{64}$/.test(file.hash)) invalid();
      keys.add(`${deployment.r2_prefix}${file.hash}`);
    }
  }
  return [...keys].sort();
}

export function buildAppDeletionCleanupPlan(rows: readonly Deployment[]): AppDeletionCleanupPlan {
  const deployments = rows.map(
    ({ id, r2_prefix, manifest, status, upload_generation, upload_plan, upload_quiesced_at }) => ({
      id,
      r2_prefix,
      manifest,
      status,
      upload_generation,
      upload_plan,
      upload_quiesced_at,
    }),
  );
  const keys = cleanupObjectKeys(deployments);
  return {
    version: 1,
    deployments,
    digest: createHash("sha256").update(canonicalSettlementJson(deployments)).digest("hex"),
    objectCount: keys.length,
  };
}

export function readAppDeletionCleanupPlan(data: Record<string, unknown>): AppDeletionCleanupPlan {
  const value = data.frontendCleanupPlan;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const plan = value as AppDeletionCleanupPlan;
  if (plan.version !== 1 || !Array.isArray(plan.deployments)) invalid();
  const count = cleanupObjectKeys(plan.deployments).length;
  if (
    count !== plan.objectCount ||
    createHash("sha256").update(canonicalSettlementJson(plan.deployments)).digest("hex") !==
      plan.digest
  )
    invalid();
  return plan;
}
