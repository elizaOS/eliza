/** Admission and original identity of app deletion in the existing jobs queue. */
import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq, or, sql } from "drizzle-orm";
import {
  APP_DELETION_JOB_TYPE,
  readAppDeletionJobData,
} from "../../lib/services/app-deletion-authority";
import { withInferencePolicyMutation } from "../../lib/services/inference-policy-fence";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import { apiKeys } from "../schemas/api-keys";
import { apps } from "../schemas/apps";
import { jobs } from "../schemas/jobs";
import { mobileAppAuthGrants } from "../schemas/mobile-app-auth-grants";
import { type Job, prepareJobInsertData } from "./jobs";

export interface AppDeletionAdmission {
  job: Job;
  app: typeof apps.$inferSelect | undefined;
  revokedKeys: Array<{ id: string; organizationId: string }>;
}
interface AdmissionInput {
  appId: string;
  organizationId: string;
  userId?: string;
  deleteGitHubRepo: boolean;
}
class DeletionKeyPlanChanged extends Error {}

async function lookupOriginal(tx: DbTransaction, input: AdmissionInput) {
  const [app] = await tx
    .select()
    .from(apps)
    .where(and(eq(apps.id, input.appId), eq(apps.organization_id, input.organizationId)))
    .for("update");
  const original = app?.deletion_job_id
    ? await tx
        .select()
        .from(jobs)
        .where(
          and(eq(jobs.id, app.deletion_job_id), eq(jobs.organization_id, input.organizationId)),
        )
    : !app
      ? await tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.type, APP_DELETION_JOB_TYPE),
              eq(jobs.organization_id, input.organizationId),
              sql`${jobs.data}->>'appId' = ${input.appId}`,
            ),
          )
      : [];
  if (original.length > 1)
    throw new ElizaError("App deletion has conflicting original jobs", {
      code: "APP_DELETION_IDENTITY_CONFLICT",
    });
  if (original[0]) {
    const data = readAppDeletionJobData(original[0].data);
    if (
      original[0].type !== APP_DELETION_JOB_TYPE ||
      original[0].data_storage !== "inline" ||
      data.appId !== input.appId ||
      data.organizationId !== input.organizationId ||
      data.deleteGitHubRepo !== input.deleteGitHubRepo
    ) {
      throw new ElizaError("App deletion retry does not match its original request", {
        code: "APP_DELETION_REQUEST_CONFLICT",
      });
    }
    return {
      app,
      original: {
        app,
        job: original[0],
        revokedKeys: data.revokedKeys,
      } satisfies AppDeletionAdmission,
    };
  }
  if (app?.deletion_job_id)
    throw new ElizaError("App deletion lost its original job", {
      code: "APP_DELETION_IDENTITY_MISSING",
    });
  return { app, original: undefined };
}

export const appDeletionOperations = {
  async admit(input: AdmissionInput): Promise<AppDeletionAdmission | undefined> {
    input = {
      ...input,
      appId: input.appId.toLowerCase(),
      organizationId: input.organizationId.toLowerCase(),
      ...(input.userId ? { userId: input.userId.toLowerCase() } : {}),
    };
    // Existing operations are status reads: no policy permit or new effect.
    const [observed] = await dbWrite
      .select({ deletionJobId: apps.deletion_job_id })
      .from(apps)
      .where(and(eq(apps.id, input.appId), eq(apps.organization_id, input.organizationId)));
    if (!observed || observed.deletionJobId) {
      return dbWrite.transaction(async (tx) => (await lookupOriginal(tx, input)).original);
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // Issuance takes user/policy locks before the app. Plan those same locks,
      // then recheck after the app lock so a new user's key cannot be omitted.
      const [preflight] = await dbWrite
        .select({ apiKeyId: apps.api_key_id })
        .from(apps)
        .where(and(eq(apps.id, input.appId), eq(apps.organization_id, input.organizationId)));
      const planned = await dbWrite
        .select({
          id: apiKeys.id,
          organizationId: apiKeys.organization_id,
          userId: apiKeys.user_id,
        })
        .from(apiKeys)
        .where(
          or(
            eq(apiKeys.source_app_id, input.appId),
            preflight?.apiKeyId ? eq(apiKeys.id, preflight.apiKeyId) : undefined,
          ),
        );
      try {
        return await withInferencePolicyMutation(
          {
            organizationIds: [
              ...new Set([input.organizationId, ...planned.map((key) => key.organizationId)]),
            ],
            userLockIds: [...new Set(planned.map((key) => key.userId))],
          },
          async (tx) => {
            const { app, original } = await lookupOriginal(tx, input);
            if (original) return original;
            if (!app) return undefined;
            const keys = await tx
              .select({
                id: apiKeys.id,
                organizationId: apiKeys.organization_id,
                userId: apiKeys.user_id,
              })
              .from(apiKeys)
              .where(
                or(
                  eq(apiKeys.source_app_id, input.appId),
                  app.api_key_id ? eq(apiKeys.id, app.api_key_id) : undefined,
                ),
              )
              .for("update");
            if (
              keys.some(
                (key) => key.id === app.api_key_id && key.organizationId !== input.organizationId,
              )
            ) {
              throw new ElizaError("App key ownership is inconsistent", {
                code: "APP_DELETION_KEY_OWNER_CONFLICT",
              });
            }
            const plannedIds = new Set(
              planned.map((key) => `${key.id}:${key.organizationId}:${key.userId}`),
            );
            if (
              keys.some((key) => !plannedIds.has(`${key.id}:${key.organizationId}:${key.userId}`))
            )
              throw new DeletionKeyPlanChanged();
            const prepared = await prepareJobInsertData({
              id: randomUUID(),
              type: APP_DELETION_JOB_TYPE,
              organization_id: input.organizationId,
              user_id: input.userId ?? null,
              data_storage: "inline",
              data: {
                version: 2,
                appId: input.appId,
                organizationId: input.organizationId,
                deleteGitHubRepo: input.deleteGitHubRepo,
                revokedKeys: keys.map(({ id, organizationId }) => ({ id, organizationId })),
              },
            });
            const [job] = await tx
              .insert(jobs)
              .values({
                ...prepared,
                created_at: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
                updated_at: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
                scheduled_for: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
              })
              .returning();
            if (!job)
              throw new ElizaError("App deletion job was not persisted", {
                code: "APP_DELETION_JOB_NOT_PERSISTED",
              });
            const [fenced] = await tx
              .update(apps)
              .set({
                deletion_job_id: job.id,
                is_active: false,
                updated_at: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
              })
              .where(and(eq(apps.id, input.appId), eq(apps.organization_id, input.organizationId)))
              .returning();
            if (!fenced || fenced.is_active || fenced.deletion_job_id !== job.id)
              throw new ElizaError("App deletion authority was not persisted", {
                code: "APP_DELETION_FENCE_NOT_PERSISTED",
              });
            const grants = await tx
              .select({ id: mobileAppAuthGrants.id })
              .from(mobileAppAuthGrants)
              .where(eq(mobileAppAuthGrants.app_id, input.appId))
              .for("update");
            const removedGrants = await tx
              .delete(mobileAppAuthGrants)
              .where(eq(mobileAppAuthGrants.app_id, input.appId))
              .returning({ id: mobileAppAuthGrants.id });
            if (removedGrants.length !== grants.length)
              throw new ElizaError("App grant retirement was not persisted", {
                code: "APP_DELETION_REVOCATION_UNCONFIRMED",
              });
            const revoked = await tx
              .update(apiKeys)
              .set({
                is_active: false,
                deleted_at: sql`COALESCE(${apiKeys.deleted_at}, clock_timestamp() AT TIME ZONE 'UTC')`,
                updated_at: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
                key_ciphertext: null,
                key_nonce: null,
                key_auth_tag: null,
                key_kms_key_id: null,
                key_kms_key_version: null,
              })
              .where(
                or(
                  eq(apiKeys.source_app_id, input.appId),
                  app.api_key_id ? eq(apiKeys.id, app.api_key_id) : undefined,
                ),
              )
              .returning();
            if (
              revoked.length !== keys.length ||
              revoked.some(
                (key) =>
                  key.is_active ||
                  key.deleted_at === null ||
                  key.key_ciphertext !== null ||
                  key.key_nonce !== null ||
                  key.key_auth_tag !== null ||
                  key.key_kms_key_id !== null ||
                  key.key_kms_key_version !== null,
              )
            )
              throw new ElizaError("App credential retirement was not persisted", {
                code: "APP_DELETION_REVOCATION_UNCONFIRMED",
              });
            return {
              app: fenced,
              job,
              revokedKeys: keys.map(({ id, organizationId }) => ({ id, organizationId })),
            };
          },
        );
      } catch (error) {
        if (!(error instanceof DeletionKeyPlanChanged)) throw error;
      }
    }
    throw new ElizaError(
      "App credentials changed during deletion admission; retry the same request",
      { code: "APP_DELETION_ADMISSION_CHANGED" },
    );
  },

  /** Original idempotent revocation delivery may retry without a policy permit.
   * Lock job before app, matching execution and finalization. */
  async confirmRevocations(jobId: string, organizationId: string): Promise<Job> {
    return dbWrite.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.organization_id, organizationId)))
        .for("update");
      if (!job || job.type !== APP_DELETION_JOB_TYPE)
        throw new ElizaError("Original app deletion job is missing", {
          code: "APP_DELETION_IDENTITY_MISSING",
        });
      const data = readAppDeletionJobData(job.data);
      if (job.result?.appDeleted === true || job.result?.revocationsConfirmed === true) return job;
      const [app] = await tx
        .select()
        .from(apps)
        .where(and(eq(apps.id, data.appId), eq(apps.organization_id, organizationId)))
        .for("update");
      if (!app || app.is_active || app.deletion_job_id !== job.id)
        throw new ElizaError("Original app deletion fence changed", {
          code: "APP_DELETION_IDENTITY_CONFLICT",
        });
      const [confirmed] = await tx
        .update(jobs)
        .set({
          result: { ...job.result, revocationsConfirmed: true },
          result_storage: "inline",
          result_key: null,
          updated_at: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
        })
        .where(eq(jobs.id, job.id))
        .returning();
      if (!confirmed)
        throw new ElizaError("App revocation acknowledgement was not stored", {
          code: "APP_DELETION_REVOCATION_UNCONFIRMED",
        });
      return confirmed;
    });
  },
};
