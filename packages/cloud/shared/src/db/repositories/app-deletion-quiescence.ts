/** Restore complete job targets before locking the app, then recheck exact revisions. */
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import { type Job, jobs } from "../schemas/jobs";
import { hydrateJob } from "./jobs";

export function readUnsettledAppDeletionRows(tx: DbTransaction, organizationId: string) {
  return tx
    .select({
      job: jobs,
      revision: sql<string>`to_char(${jobs.updated_at}, 'YYYY-MM-DD HH24:MI:SS.US')`,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.organization_id, organizationId),
        inArray(jobs.type, [
          "app_deploy",
          "app_db_deprovision",
          "container_provision",
          "container_restart",
          "container_upgrade",
          "container_delete",
        ]),
        or(
          inArray(jobs.status, ["pending", "in_progress"]),
          and(isNotNull(jobs.execution_generation), isNull(jobs.execution_quiesced_at)),
        ),
      ),
    );
}
export interface AppDeletionQuiescenceCandidate {
  raw: Job;
  revision: string;
  restored: Job;
}
export async function restoreAppDeletionQuiescence(
  organizationId: string,
): Promise<AppDeletionQuiescenceCandidate[]> {
  const rows = await dbWrite.transaction((tx) => readUnsettledAppDeletionRows(tx, organizationId));
  // No app/resource row lock is held over object-store I/O. Missing or corrupt
  // full payloads reject; an inline preview never proves another app's target.
  return Promise.all(
    rows.map(async (row) => ({
      raw: row.job,
      revision: row.revision,
      restored: await hydrateJob(row.job, { strict: true }),
    })),
  );
}
