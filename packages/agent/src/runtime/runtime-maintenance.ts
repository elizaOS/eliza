/**
 * Runs independent startup data maintenance after SQL migrations and before
 * runtime readiness. Every job settles before this boundary returns so adapter
 * shutdown cannot race a detached task read or write.
 */

import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { scheduleAttachmentKnowledgeBackfill } from "../api/attachment-knowledge-backfill.ts";
import { scheduleMediaGc } from "../api/media-runtime.ts";
import { migrateWorkbenchScheduleTags } from "../triggers/workbench-migration.ts";

interface MaintenanceJob {
  scope: string;
  run: () => Promise<unknown>;
}

/** Settle all independent post-migration jobs or fail boot with every cause. */
export async function runRuntimeStartupMaintenance(
  runtime: IAgentRuntime,
  abortSignal?: AbortSignal,
): Promise<void> {
  abortSignal?.throwIfAborted();
  const jobs: MaintenanceJob[] = [
    {
      scope: "workbench-schedule-tag-migration",
      run: () => migrateWorkbenchScheduleTags(runtime),
    },
    {
      scope: "knowledge-backfill-schedule",
      run: () => scheduleAttachmentKnowledgeBackfill(runtime),
    },
    {
      scope: "media-gc-schedule",
      run: () => scheduleMediaGc(runtime),
    },
  ];

  const results = await Promise.allSettled(
    jobs.map(async ({ scope, run }) => {
      abortSignal?.throwIfAborted();
      try {
        await run();
        abortSignal?.throwIfAborted();
      } catch (error) {
        if (abortSignal?.aborted) throw error;
        runtime.reportError(scope, error, { phase: "startup-maintenance" });
        throw new ElizaError(`Runtime maintenance failed: ${scope}`, {
          code: "RUNTIME_STARTUP_MAINTENANCE_JOB_FAILED",
          cause: error,
          context: { scope },
        });
      }
    }),
  );
  abortSignal?.throwIfAborted();

  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    // error-policy:J2 all jobs are allowed to settle before adapter teardown;
    // preserve every failure behind the boot boundary error.
    throw new ElizaError(
      `Runtime startup maintenance failed in ${failures.length} job(s)`,
      {
        code: "RUNTIME_STARTUP_MAINTENANCE_FAILED",
        cause: new AggregateError(failures),
        context: { failedJobs: failures.length },
      },
    );
  }
}
