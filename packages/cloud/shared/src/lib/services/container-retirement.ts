/**
 * Atomically retires app-container rows with their durable delete jobs. The
 * container row is the serialization point, while migration 0176 repairs rows
 * created before this invariant existed.
 */

import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/helpers";
import { containers } from "../../db/schemas/containers";
import { jobs } from "../../db/schemas/jobs";
import { logger } from "../utils/logger";
import { JOB_TYPES } from "./provisioning-job-types";

const LIVE_JOB_STATUSES = ["pending", "in_progress"] as const;
const WORKER_OWNED_CONTAINER_STATUSES = new Set(["deleted", "cleanup_required"]);

export interface ContainerRetirementResult {
  containerId: string;
  jobId?: string;
  outcome: "retired" | "already_owned" | "missing" | "worker_owned";
}

interface LockedContainer {
  id: string;
  organizationId: string;
  status: string;
  metadata: Record<string, unknown>;
}

async function findLiveDeleteJob(
  tx: DbTransaction,
  containerId: string,
  organizationId: string,
): Promise<{ id: string } | undefined> {
  const [job] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, JOB_TYPES.CONTAINER_DELETE),
        eq(jobs.organization_id, organizationId),
        inArray(jobs.status, LIVE_JOB_STATUSES),
        sql`${jobs.data}->>'containerId' = ${containerId}`,
      ),
    )
    .orderBy(jobs.created_at)
    .limit(1);
  return job;
}

function retirementMetadata(
  metadata: Record<string, unknown>,
  jobId: string,
): Record<string, unknown> {
  return {
    ...metadata,
    retirement: {
      deleteJobId: jobId,
      retiredAt: new Date().toISOString(),
    },
  };
}

function ownedDeleteJobId(metadata: Record<string, unknown>): string | undefined {
  const retirement = metadata.retirement;
  if (typeof retirement !== "object" || retirement === null) return undefined;
  const deleteJobId = Reflect.get(retirement, "deleteJobId");
  return typeof deleteJobId === "string" ? deleteJobId : undefined;
}

async function retireLockedContainer(
  tx: DbTransaction,
  row: LockedContainer,
): Promise<ContainerRetirementResult> {
  if (WORKER_OWNED_CONTAINER_STATUSES.has(row.status)) {
    return { containerId: row.id, outcome: "worker_owned" };
  }

  const existingJob = await findLiveDeleteJob(tx, row.id, row.organizationId);
  if (
    existingJob &&
    row.status === "deleting" &&
    ownedDeleteJobId(row.metadata) === existingJob.id
  ) {
    return {
      containerId: row.id,
      jobId: existingJob.id,
      outcome: "already_owned",
    };
  }
  const jobId = existingJob?.id ?? randomUUID();

  if (!existingJob) {
    await tx.insert(jobs).values({
      id: jobId,
      type: JOB_TYPES.CONTAINER_DELETE,
      organization_id: row.organizationId,
      data: { containerId: row.id, organizationId: row.organizationId },
      data_storage: "inline",
    });
  }

  const [updated] = await tx
    .update(containers)
    .set({
      status: "deleting",
      metadata: retirementMetadata(row.metadata, jobId),
      updated_at: new Date(),
    })
    .where(
      and(
        eq(containers.id, row.id),
        eq(containers.organization_id, row.organizationId),
        eq(containers.status, row.status),
      ),
    )
    .returning({ id: containers.id });

  if (!updated) {
    throw new ElizaError(
      `Container ${row.id} changed while its retirement transaction held the row`,
      {
        code: "CONTAINER_RETIREMENT_CAS_MISSED",
        context: {
          containerId: row.id,
          organizationId: row.organizationId,
          expectedStatus: row.status,
        },
      },
    );
  }

  return {
    containerId: row.id,
    jobId,
    outcome: existingJob ? "already_owned" : "retired",
  };
}

async function lockContainer(
  tx: DbTransaction,
  containerId: string,
  organizationId: string,
): Promise<LockedContainer | undefined> {
  const [row] = await tx
    .select({
      id: containers.id,
      organizationId: containers.organization_id,
      status: containers.status,
      metadata: containers.metadata,
    })
    .from(containers)
    .where(and(eq(containers.id, containerId), eq(containers.organization_id, organizationId)))
    .for("update")
    .limit(1);
  return row;
}

/** Commit the non-quota-counting state and durable teardown ownership together. */
export async function retireContainerWithDeleteJob(
  containerId: string,
  organizationId: string,
): Promise<ContainerRetirementResult> {
  const result = await dbWrite.transaction(async (tx) => {
    const row = await lockContainer(tx, containerId, organizationId);
    if (!row) return { containerId, outcome: "missing" as const };
    return retireLockedContainer(tx, row);
  });
  logger.info("[ContainerRetirement] retirement transaction committed", {
    containerId,
    organizationId,
    deleteJobId: result.jobId,
    outcome: result.outcome,
  });
  return result;
}
