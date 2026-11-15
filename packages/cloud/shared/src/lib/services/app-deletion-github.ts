import { eq, sql } from "drizzle-orm";
import { withAppDeletionExecution } from "../../db/repositories/app-deletion-execution";
import { jobs } from "../../db/schemas/jobs";
import {
  AppDeletionOperatorRecoveryRequiredError,
  AppDeletionRecoveryPendingError,
} from "./app-deletion-authority";
import { githubReposService } from "./github-repos";
import type { JobExecutionAuthority } from "./job-execution-authority";

interface RepositoryIdentity {
  owner: string;
  name: string;
  id: number;
}
interface GitHubReceipt {
  identity: RepositoryIdentity;
  dispatched: boolean;
  confirmed: boolean;
}
function receipt(value: unknown): GitHubReceipt | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object")
    throw new AppDeletionRecoveryPendingError("Invalid repository deletion receipt");
  const result = value as GitHubReceipt;
  if (
    !result.identity ||
    typeof result.identity.owner !== "string" ||
    typeof result.identity.name !== "string" ||
    !Number.isSafeInteger(result.identity.id) ||
    typeof result.dispatched !== "boolean" ||
    typeof result.confirmed !== "boolean"
  )
    throw new AppDeletionRecoveryPendingError("Invalid repository deletion receipt");
  return result;
}

export async function deleteOriginalAppRepository(authority: JobExecutionAuthority): Promise<void> {
  const original = await withAppDeletionExecution(authority, async (_tx, context) => {
    if (context.appDeleted || context.job.result?.githubRequired === false) return null;
    if (
      context.job.result?.githubRequired !== true ||
      typeof context.job.result.originalGitHubRepo !== "string"
    )
      throw new AppDeletionRecoveryPendingError("Original repository decision is unavailable");
    return {
      name: context.job.result.originalGitHubRepo,
      saved: receipt(context.job.result.githubDeletion),
    };
  });
  if (!original || original.saved?.confirmed) return;
  if (original.saved?.dispatched) throw new AppDeletionOperatorRecoveryRequiredError();
  const identity =
    original.saved?.identity ?? (await githubReposService.observeAppRepoForDeletion(original.name));
  const dispatch = await withAppDeletionExecution(authority, async (tx, context) => {
    const saved = receipt(context.job.result?.githubDeletion);
    if (saved?.confirmed) return false;
    if (saved?.dispatched) throw new AppDeletionOperatorRecoveryRequiredError();
    if (context.job.result?.originalGitHubRepo !== original.name)
      throw new AppDeletionRecoveryPendingError("Original repository name changed");
    const [written] = await tx
      .update(jobs)
      .set({
        result: {
          ...context.job.result,
          githubDeletion: { identity, dispatched: true, confirmed: false },
          operatorReconciliationRequired: true,
        },
        result_storage: "inline",
        result_key: null,
        updated_at: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
      })
      .where(eq(jobs.id, context.job.id))
      .returning({ id: jobs.id });
    if (!written)
      throw new AppDeletionRecoveryPendingError("Repository dispatch receipt was not persisted");
    return true;
  });
  if (!dispatch) return;
  // GitHub exposes owner/name deletion, not conditional deletion by immutable
  // id. This rechecks the pinned id, but external rename/reuse during the HTTP
  // request remains a provider-side assumption. No unknown dispatch is replayed.
  try {
    await githubReposService.deleteObservedAppRepo(identity, () =>
      withAppDeletionExecution(authority, async () => {}),
    );
    await withAppDeletionExecution(authority, async (tx, context) => {
      const saved = receipt(context.job.result?.githubDeletion);
      if (!saved?.dispatched || saved.identity.id !== identity.id)
        throw new AppDeletionRecoveryPendingError("Original repository dispatch receipt changed");
      const [written] = await tx
        .update(jobs)
        .set({
          result: {
            ...context.job.result,
            githubDeletion: { ...saved, confirmed: true },
            operatorReconciliationRequired: false,
          },
          updated_at: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
        })
        .where(eq(jobs.id, context.job.id))
        .returning({ id: jobs.id });
      if (!written)
        throw new AppDeletionRecoveryPendingError(
          "Repository completion receipt was not persisted",
        );
    });
  } catch {
    // The pre-dispatch record is already durable. Missing acknowledgement is
    // not provider absence, and neither automatic nor owner retries repeat it.
    throw new AppDeletionOperatorRecoveryRequiredError();
  }
}
