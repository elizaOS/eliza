/**
 * Operator reconciliation for legacy malformed CONTAINER_DELETE queue rows
 * (#15821). Producers now serialize through the canonical codec, but rows
 * enqueued before that fix may still sit in the queue with payloads the
 * executor cannot fully trust. This module inventories those rows, classifies
 * each one through the same codec the executor uses, and — only in apply
 * mode — performs the two safe transitions: requeue a failed
 * organization-only row that still has `deleting` container rows to consume,
 * and terminally fail a pending row whose payload can never identify an owner.
 *
 * Every mutation is guarded on the status the classification observed, so
 * concurrent daemons or a second reconciler run cannot double-apply a
 * transition; the report counts only rows this run actually changed. The
 * inventory carries ids and counts only (no names, env vars, or hostnames) so
 * it is safe to paste into an issue as operator evidence.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { dbWrite } from "../../db/client";
import { containers } from "../../db/schemas/containers";
import { jobs } from "../../db/schemas/jobs";
import { isContainerDeleteJobData } from "./container-jobs-data";
import { JOB_TYPES } from "./provisioning-job-types";

/** Drizzle surface the reconciler needs; the real `dbWrite` is assignable. */
export type ReconcilerDatabase = Pick<typeof dbWrite, "select" | "update">;

export type ContainerDeleteJobClassification =
  | "valid"
  | "recoverable-organization-only"
  | "unrecoverable";

export type ContainerDeleteJobPlannedAction = "none" | "requeue" | "mark-failed";

/** Sanitized per-job inventory row: ids, states, and counts only. */
export interface ContainerDeleteJobInventoryEntry {
  jobId: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  classification: ContainerDeleteJobClassification;
  /** Present when the payload carried a usable owning organization. */
  organizationId: string | null;
  /** Present only when the payload passed the canonical codec. */
  containerId: string | null;
  /** For organization-only rows: ids of that org's `deleting` container rows. */
  deletingContainerIds: string[];
  /** How many of those deleting rows persisted an immutable host Docker id. */
  deletingContainersWithHostId: number;
  plannedAction: ContainerDeleteJobPlannedAction;
  /** Why the planned action was chosen (operator-facing, deterministic). */
  reason: string;
  /** True when apply mode performed the planned action on this row. */
  applied: boolean;
}

export interface ContainerDeleteJobReconciliationReport {
  dryRun: boolean;
  scannedJobs: number;
  validJobs: number;
  recoverableJobs: number;
  unrecoverableJobs: number;
  requeuedJobs: number;
  markedFailedJobs: number;
  entries: ContainerDeleteJobInventoryEntry[];
}

/** Error text stamped on rows terminally failed by the reconciler. */
export const UNRECOVERABLE_DELETE_JOB_ERROR =
  "CONTAINER_DELETE_PAYLOAD_UNRECOVERABLE: legacy job payload has no valid " +
  "containerId or organizationId; terminally failed by the container-delete " +
  "reconciler (#15821). Any live container is swept by the orphan reconciler " +
  "using its immutable host id.";

/** Statuses that are already settled and must never be touched. */
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

function readOrganizationId(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const organizationId = Reflect.get(data, "organizationId");
  return typeof organizationId === "string" && organizationId.trim().length > 0
    ? organizationId
    : null;
}

/** Classify one persisted payload through the executor's own codec. */
export function classifyContainerDeleteJobData(data: unknown): ContainerDeleteJobClassification {
  if (isContainerDeleteJobData(data)) return "valid";
  return readOrganizationId(data) === null ? "unrecoverable" : "recoverable-organization-only";
}

interface ScannedJobRow {
  id: string;
  status: string;
  data: unknown;
  attempts: number;
  max_attempts: number;
  created_at: Date;
  organization_id: string;
}

interface PlannedEntry {
  entry: ContainerDeleteJobInventoryEntry;
  guardStatus: string | null;
}

function planEntry(
  row: ScannedJobRow,
  deletingRows: Array<{ id: string; hasHostId: boolean }>,
): PlannedEntry {
  const classification = classifyContainerDeleteJobData(row.data);
  const payloadOrganizationId = readOrganizationId(row.data);
  const base: ContainerDeleteJobInventoryEntry = {
    jobId: row.id,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at.toISOString(),
    classification,
    organizationId: payloadOrganizationId,
    containerId:
      classification === "valid" &&
      typeof row.data === "object" &&
      row.data !== null &&
      typeof Reflect.get(row.data, "containerId") === "string"
        ? (Reflect.get(row.data, "containerId") as string)
        : null,
    deletingContainerIds: deletingRows.map((r) => r.id),
    deletingContainersWithHostId: deletingRows.filter((r) => r.hasHostId).length,
    plannedAction: "none",
    reason: "",
    applied: false,
  };

  if (classification === "valid") {
    base.reason = "payload passes the canonical codec; normal worker path owns it";
    return { entry: base, guardStatus: null };
  }
  if (TERMINAL_JOB_STATUSES.has(row.status) && row.status !== "failed") {
    base.reason = `terminal status ${row.status}; no reconciliation applies`;
    return { entry: base, guardStatus: null };
  }
  if (classification === "recoverable-organization-only") {
    if (row.status === "failed" && deletingRows.length > 0) {
      base.plannedAction = "requeue";
      base.reason =
        "failed organization-only payload with live deleting rows; requeue so the " +
        "executor's bounded recovery branch consumes them";
      return { entry: base, guardStatus: "failed" };
    }
    base.reason =
      row.status === "failed"
        ? "failed organization-only payload but no deleting rows remain; nothing stranded"
        : `status ${row.status}; the executor's recovery branch already owns this row`;
    return { entry: base, guardStatus: null };
  }
  // unrecoverable
  if (row.status === "pending") {
    base.plannedAction = "mark-failed";
    base.reason = "pending payload identifies no owner; terminally fail with operator context";
    return { entry: base, guardStatus: "pending" };
  }
  base.reason =
    row.status === "failed"
      ? "already failed with no usable payload; escalate to an operator"
      : `status ${row.status}; left untouched — a live worker may hold it`;
  return { entry: base, guardStatus: null };
}

/**
 * Inventory (and in apply mode reconcile) every CONTAINER_DELETE job row.
 * Dry-run performs no writes; apply mode performs only status-guarded
 * single-row transitions, so it is idempotent and safe under concurrency.
 */
export async function reconcileContainerDeleteJobs(
  db: ReconcilerDatabase,
  options: { apply?: boolean } = {},
): Promise<ContainerDeleteJobReconciliationReport> {
  const apply = options.apply === true;
  const rows = (await db
    .select({
      id: jobs.id,
      status: jobs.status,
      data: jobs.data,
      attempts: jobs.attempts,
      max_attempts: jobs.max_attempts,
      created_at: jobs.created_at,
      organization_id: jobs.organization_id,
    })
    .from(jobs)
    .where(eq(jobs.type, JOB_TYPES.CONTAINER_DELETE))
    .orderBy(jobs.created_at)) as ScannedJobRow[];

  const organizationIds = new Set<string>();
  for (const row of rows) {
    if (classifyContainerDeleteJobData(row.data) === "recoverable-organization-only") {
      const organizationId = readOrganizationId(row.data);
      if (organizationId) organizationIds.add(organizationId);
    }
  }

  const deletingByOrganization = new Map<string, Array<{ id: string; hasHostId: boolean }>>();
  if (organizationIds.size > 0) {
    const deletingRows = await db
      .select({
        id: containers.id,
        organization_id: containers.organization_id,
        hasHostId: sql<boolean>`jsonb_exists(coalesce(${containers.metadata}, '{}'::jsonb), 'hostContainerId')`,
      })
      .from(containers)
      .where(
        and(
          eq(containers.status, "deleting"),
          inArray(containers.organization_id, [...organizationIds]),
        ),
      );
    for (const row of deletingRows) {
      const list = deletingByOrganization.get(row.organization_id) ?? [];
      list.push({ id: row.id, hasHostId: row.hasHostId === true });
      deletingByOrganization.set(row.organization_id, list);
    }
  }

  const report: ContainerDeleteJobReconciliationReport = {
    dryRun: !apply,
    scannedJobs: rows.length,
    validJobs: 0,
    recoverableJobs: 0,
    unrecoverableJobs: 0,
    requeuedJobs: 0,
    markedFailedJobs: 0,
    entries: [],
  };

  for (const row of rows) {
    const organizationId = readOrganizationId(row.data);
    const deletingRows = organizationId ? (deletingByOrganization.get(organizationId) ?? []) : [];
    const { entry, guardStatus } = planEntry(row, deletingRows);
    if (entry.classification === "valid") report.validJobs += 1;
    else if (entry.classification === "recoverable-organization-only") report.recoverableJobs += 1;
    else report.unrecoverableJobs += 1;

    if (apply && guardStatus !== null && entry.plannedAction !== "none") {
      const changed = await applyTransition(db, row.id, entry.plannedAction, guardStatus);
      entry.applied = changed;
      if (changed && entry.plannedAction === "requeue") report.requeuedJobs += 1;
      if (changed && entry.plannedAction === "mark-failed") report.markedFailedJobs += 1;
    }
    report.entries.push(entry);
  }
  return report;
}

async function applyTransition(
  db: ReconcilerDatabase,
  jobId: string,
  action: Exclude<ContainerDeleteJobPlannedAction, "none">,
  guardStatus: string,
): Promise<boolean> {
  const values =
    action === "requeue"
      ? {
          status: "pending" as const,
          scheduled_for: new Date(),
          error: null,
          completed_at: null,
          updated_at: new Date(),
        }
      : {
          status: "failed" as const,
          error: UNRECOVERABLE_DELETE_JOB_ERROR,
          completed_at: new Date(),
          updated_at: new Date(),
        };
  const updated = await db
    .update(jobs)
    .set(values)
    .where(and(eq(jobs.id, jobId), eq(jobs.status, guardStatus)))
    .returning({ id: jobs.id });
  return updated.length === 1;
}
