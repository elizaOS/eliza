/** Small progress receipts over the immutable original job-data manifest. */
import { ElizaError } from "@elizaos/core";
import { and, eq, sql } from "drizzle-orm";
import { AppDeletionRecoveryPendingError } from "../../lib/services/app-deletion-authority";
import type { JobExecutionAuthority } from "../../lib/services/job-execution-authority";
import { dbWrite } from "../helpers";
import { jobs } from "../schemas/jobs";
import { assertJobExecutionAuthority, lockJobExecutionAuthority } from "./job-execution-authority";

export async function advanceAppDeletionCleanup(
  authority: JobExecutionAuthority,
  digest: string,
  objectCount: number,
  expectedCursor: number,
  acknowledge: boolean,
): Promise<number> {
  return dbWrite.transaction(async (tx) => {
    await lockJobExecutionAuthority(tx, authority);
    await assertJobExecutionAuthority(tx, authority);
    const [job] = await tx
      .select({
        result: jobs.result,
      })
      .from(jobs)
      .where(and(eq(jobs.id, authority.jobId), eq(jobs.type, "app_delete")));
    const result = job?.result;
    const cursor = result?.cleanupCursor;
    if (
      !job ||
      result?.cleanupObjectCount !== objectCount ||
      result?.appDeleted !== true ||
      result.cleanupManifestDigest !== digest ||
      !Number.isSafeInteger(cursor) ||
      typeof cursor !== "number" ||
      cursor < 0 ||
      cursor > objectCount
    )
      throw new ElizaError("App cleanup lost its original receipt", {
        code: "APP_DELETION_CLEANUP_RECEIPT_INVALID",
      });
    if (cursor !== expectedCursor)
      throw new AppDeletionRecoveryPendingError("Original app cleanup progress changed");
    if (!acknowledge) return cursor;
    const next = cursor < objectCount ? cursor + 1 : cursor;
    const [receipt] = await tx
      .update(jobs)
      .set({
        result: { ...result, cleanupCursor: next, cleanupConfirmed: next === objectCount },
        result_storage: "inline",
        result_key: null,
        // Forward progress resets only this root's bounded no-progress recovery budget.
        ...(next > cursor ? { retryable_requeues: 0 } : {}),
        updated_at: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
      })
      .where(eq(jobs.id, authority.jobId))
      .returning({ id: jobs.id });
    if (!receipt)
      throw new ElizaError("App cleanup acknowledgement was not persisted", {
        code: "APP_DELETION_CLEANUP_ACK_UNCONFIRMED",
      });
    return next;
  });
}

/** Marked roots survive account deletion until every original object is acknowledged. */
export async function hasUnconfirmedAppCleanup(organizationId: string): Promise<boolean> {
  const [job] = await dbWrite
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.organization_id, organizationId),
        eq(jobs.type, "app_delete"),
        sql`${jobs.data}->>'version' = '2'`,
        sql`${jobs.result}->>'cleanupConfirmed' IS DISTINCT FROM 'true'`,
      ),
    )
    .limit(1);
  return !!job;
}
