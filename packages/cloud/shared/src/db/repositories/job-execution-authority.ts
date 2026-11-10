/** Same-transaction authority for dependent writes of a durable job. */
import { and, eq, sql } from "drizzle-orm";
import {
  type JobExecutionAuthority,
  StaleJobExecutionError,
} from "../../lib/services/job-execution-authority";
import type { DbTransaction } from "../client";
import { jobExecutionLeases } from "../schemas/job-execution-leases";
import { jobs } from "../schemas/jobs";

/** Lock order: job, lease, dependent resource. Never hold these locks over I/O. */
export async function lockJobExecutionAuthority(
  tx: DbTransaction,
  authority: JobExecutionAuthority,
): Promise<void> {
  const [job] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.id, authority.jobId), eq(jobs.organization_id, authority.organizationId)))
    .for("update")
    .limit(1);
  if (!job) throw new StaleJobExecutionError(authority.jobId);
  await tx
    .select({ jobId: jobExecutionLeases.job_id })
    .from(jobExecutionLeases)
    .where(eq(jobExecutionLeases.job_id, authority.jobId))
    .for("update")
    .limit(1);
}

/** Call after acquiring the dependent resource lock: NOW() predates lock waits. */
export async function assertJobExecutionAuthority(
  tx: DbTransaction,
  authority: JobExecutionAuthority,
): Promise<void> {
  const [owned] = await tx
    .select({ jobId: jobs.id })
    .from(jobs)
    .innerJoin(jobExecutionLeases, eq(jobExecutionLeases.job_id, jobs.id))
    .where(
      and(
        eq(jobs.id, authority.jobId),
        eq(jobs.organization_id, authority.organizationId),
        eq(jobs.status, "in_progress"),
        eq(jobs.execution_generation, authority.executionGeneration),
        sql`${jobs.execution_quiesced_at} IS NULL`,
        eq(jobExecutionLeases.execution_generation, authority.executionGeneration),
        eq(jobExecutionLeases.owner_id, authority.executionOwnerId),
        // Lease columns retain UTC without an offset. Do not let a session's
        // TimeZone reinterpret that deadline as local time.
        sql`${jobExecutionLeases.expires_at} > (clock_timestamp() AT TIME ZONE 'UTC')`,
      ),
    )
    .limit(1);
  if (!owned) throw new StaleJobExecutionError(authority.jobId);
}
