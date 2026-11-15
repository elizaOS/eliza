/** Same-transaction authority for app deletion; never hold these locks across provider I/O. */
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import {
  APP_DELETION_JOB_TYPE,
  type AppDeletionChildData,
  type AppDeletionJobData,
  AppDeletionRecoveryPendingError,
  readAppDeletionChildData,
  readAppDeletionJobData,
  readAppDeletionPlan,
} from "../../lib/services/app-deletion-authority";
import type { JobExecutionAuthority } from "../../lib/services/job-execution-authority";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import { type App, apps } from "../schemas/apps";
import { type Job, jobs } from "../schemas/jobs";
import { assertJobExecutionAuthority, lockJobExecutionAuthority } from "./job-execution-authority";

export interface AppDeletionExecutionContext {
  job: Job;
  data: AppDeletionJobData;
  app: App | undefined;
  appDeleted: boolean;
}

export async function withAppDeletionExecution<T>(
  authority: JobExecutionAuthority,
  operation: (tx: DbTransaction, context: AppDeletionExecutionContext) => Promise<T>,
): Promise<T> {
  return dbWrite.transaction(async (tx) => {
    await lockJobExecutionAuthority(tx, authority);
    const [job] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, authority.jobId), eq(jobs.organization_id, authority.organizationId)));
    if (!job || job.type !== APP_DELETION_JOB_TYPE || job.data_storage !== "inline") {
      throw new ElizaError("Original app deletion job is unavailable", {
        code: "APP_DELETION_IDENTITY_MISSING",
      });
    }
    const data = readAppDeletionJobData(job.data);
    if (data.organizationId !== authority.organizationId)
      throw new ElizaError("App deletion organization changed", {
        code: "APP_DELETION_IDENTITY_CONFLICT",
      });
    const [app] = await tx
      .select()
      .from(apps)
      .where(and(eq(apps.id, data.appId), eq(apps.organization_id, data.organizationId)))
      .for("update");
    await assertJobExecutionAuthority(tx, authority);
    const result = job.result as Record<string, unknown> | null;
    const appDeleted =
      result?.appDeleted === true &&
      result?.appId === data.appId &&
      result?.deletionJobId === job.id;
    if (app) {
      if (app.deletion_job_id !== job.id || app.is_active || appDeleted)
        throw new ElizaError("App deletion lost its original fence", {
          code: "APP_DELETION_IDENTITY_CONFLICT",
        });
    } else if (!appDeleted) {
      throw new ElizaError("App disappeared without its deletion receipt", {
        code: "APP_DELETION_COMPLETION_UNCONFIRMED",
      });
    }
    return operation(tx, { job, data, app, appDeleted });
  });
}

export interface AppDeletionChildContext {
  job: Job;
  data: AppDeletionChildData;
  root: Job;
  app: App | undefined;
  alreadyConfirmed: boolean;
}

/** The child job owns its lease; the immutable root owns its original target. */
export async function withAppDeletionChildExecution<T>(
  authority: JobExecutionAuthority,
  operation: (tx: DbTransaction, context: AppDeletionChildContext) => Promise<T>,
): Promise<T> {
  return dbWrite.transaction(async (tx) => {
    await lockJobExecutionAuthority(tx, authority);
    const [job] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, authority.jobId), eq(jobs.organization_id, authority.organizationId)));
    if (!job || job.data_storage !== "inline")
      throw new AppDeletionRecoveryPendingError("Original deletion child is unavailable");
    const data = readAppDeletionChildData(job.data);
    const expectedType = data.kind === "database" ? "app_db_deprovision" : "container_delete";
    if (job.type !== expectedType || data.organizationId !== job.organization_id)
      throw new AppDeletionRecoveryPendingError("Deletion child owner or kind changed");
    const [root] = await tx
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.id, data.appDeletionJobId), eq(jobs.organization_id, data.organizationId)),
      );
    if (!root || root.type !== APP_DELETION_JOB_TYPE || root.data_storage !== "inline")
      throw new AppDeletionRecoveryPendingError("Original app deletion operation is unavailable");
    const parent = readAppDeletionJobData(root.data);
    const entry = readAppDeletionPlan(root.result)?.find((item) => item.jobId === job.id);
    if (
      parent.appId !== data.appId ||
      parent.organizationId !== data.organizationId ||
      !entry ||
      entry.kind !== data.kind ||
      entry.resourceId !== data.resourceId ||
      entry.digest !== data.resourceDigest
    )
      throw new AppDeletionRecoveryPendingError("Deletion child is not in the original plan");
    const [app] = await tx
      .select()
      .from(apps)
      .where(and(eq(apps.id, data.appId), eq(apps.organization_id, data.organizationId)))
      .for("update");
    await assertJobExecutionAuthority(tx, authority);
    const result = root.result as Record<string, unknown> | null;
    const alreadyConfirmed =
      result?.appDeleted === true &&
      result.appId === data.appId &&
      result.deletionJobId === root.id &&
      Array.isArray(result.confirmedChildIds) &&
      result.confirmedChildIds.includes(job.id);
    if (app) {
      if (app.is_active || app.deletion_job_id !== root.id || alreadyConfirmed)
        throw new AppDeletionRecoveryPendingError("Original app deletion fence changed");
    } else if (!alreadyConfirmed) {
      throw new AppDeletionRecoveryPendingError(
        "App disappeared without this child's confirmation",
      );
    }
    return operation(tx, { job, data, root, app, alreadyConfirmed });
  });
}
