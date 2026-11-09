/** Resume exact immutable object deletes after the app metadata has disappeared. */
import { advanceAppDeletionCleanup } from "../../db/repositories/app-deletion-cleanup";
import { withAppDeletionExecution } from "../../db/repositories/app-deletion-execution";
import { getRuntimeR2Bucket } from "../storage/r2-runtime-binding";
import { AppDeletionRecoveryPendingError } from "./app-deletion-authority";
import { cleanupObjectKeys, readAppDeletionCleanupPlan } from "./app-deletion-cleanup-plan";
import type { JobExecutionAuthority } from "./job-execution-authority";

export async function finishAppDeletionCleanup(authority: JobExecutionAuthority): Promise<void> {
  const original = await withAppDeletionExecution(authority, async (_tx, context) => {
    if (context.data.version !== 2) return null;
    if (!context.appDeleted)
      throw new AppDeletionRecoveryPendingError("App metadata deletion is unconfirmed");
    return {
      plan: readAppDeletionCleanupPlan(context.job.data),
      cursor: context.job.result?.cleanupCursor,
      confirmed: context.job.result?.cleanupConfirmed === true,
    };
  });
  if (!original || original.confirmed) return;
  const { plan } = original;
  const initialCursor = original.cursor;
  if (
    typeof initialCursor !== "number" ||
    !Number.isSafeInteger(initialCursor) ||
    initialCursor < 0 ||
    initialCursor > plan.objectCount
  )
    throw new AppDeletionRecoveryPendingError("Original cleanup cursor is unavailable");
  let cursor: number = initialCursor;
  const keys = cleanupObjectKeys(plan.deployments);
  const bucket = getRuntimeR2Bucket();
  if (keys.length && !bucket)
    throw new AppDeletionRecoveryPendingError("Original artifact storage is unavailable");
  // Bound one worker run; the same leased root resumes its small durable cursor.
  const stop = Math.min(keys.length, cursor + 64);
  while (cursor < stop) {
    await advanceAppDeletionCleanup(authority, plan.digest, plan.objectCount, cursor, false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        bucket!.delete(keys[cursor]!),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Artifact delete timed out")), 30_000);
        }),
      ]);
    } catch (error) {
      // The request may have succeeded remotely. Only the same immutable key is retried.
      throw new AppDeletionRecoveryPendingError("Original artifact deletion is unconfirmed", {
        cause: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      clearTimeout(timer);
    }
    cursor = await advanceAppDeletionCleanup(
      authority,
      plan.digest,
      plan.objectCount,
      cursor,
      true,
    );
  }
  if (cursor < keys.length)
    throw new AppDeletionRecoveryPendingError("Original artifact cleanup has more work");
  if (keys.length === 0) await advanceAppDeletionCleanup(authority, plan.digest, 0, 0, true);
}
