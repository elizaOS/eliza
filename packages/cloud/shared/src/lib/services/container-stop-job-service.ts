/**
 * CONTAINER_STOP job service (#8342) — stop a billed container's live Docker
 * runtime when billing is suspended, WITHOUT the Worker ever touching SSH.
 *
 * The daily container-billing cron runs on the Cloudflare Worker. When an org
 * runs out of credit the cron flips the row to `status='stopped',
 * billing_status='suspended'` (ContainerBillingRepository.suspendContainer) and
 * stops charging — but the container was created with `--restart unless-stopped`
 * and KEEPS RUNNING on the Hetzner node, because the Worker cannot SSH (`ssh2`
 * is stubbed in workerd). The result is unbounded free compute: billing stopped,
 * the container did not.
 *
 * This closes that leak with the same Worker-enqueues / daemon-executes pattern
 * the agent-suspend (enqueueAgentSuspendOnce) and APP_DB_DEPROVISION (#8401)
 * paths already use: the cron ENQUEUES a CONTAINER_STOP job (a plain DB insert,
 * no SSH) and the provisioning-worker daemon claims it and runs the real
 * `docker stop` + remove via the node-only HetznerContainersClient — which also
 * decrements the node's allocated-slot count. The volume is PRESERVED
 * (`purgeVolume: false`) so the org can top up and redeploy.
 *
 * The dispatcher lazy-imports the Hetzner client so this module stays safe to
 * load on workerd (the enqueue side never pulls `ssh2`).
 */

import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import type { DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/helpers";
import { settleComputeRateSegments } from "../../db/repositories/compute-billing-segments";
import {
  containerBillingRepository,
  unreconciledContainerStopProviderEffectExistsSql,
} from "../../db/repositories/container-billing";
import { containersRepository } from "../../db/repositories/containers";
import { computeBillingRateSegments } from "../../db/schemas/compute-billing-rate-segments";
import { containerComputeStopIntents } from "../../db/schemas/compute-stop-intents";
import { containers } from "../../db/schemas/containers";
import { jobExecutionLeases } from "../../db/schemas/job-execution-leases";
import { jobs } from "../../db/schemas/jobs";
import { organizations } from "../../db/schemas/organizations";
import { redeemableEarnings } from "../../db/schemas/redeemable-earnings";
import { users } from "../../db/schemas/users";
import type { ContainerJobsWriter } from "./container-job-service";
import { JOB_TYPES } from "./provisioning-job-types";

/** Outcome of a daemon-side container stop. */
export interface ContainerStopOutcome {
  stopped: boolean;
  reason?: string;
}

const STOP_INTENT_MAX_ORDINARY_ATTEMPTS = 3;
const STOP_INTENT_RETRY_MS = 5 * 60 * 1000;
const CONTAINER_PROVIDER_STOP_SEGMENT_NAMESPACE = "facf6254-df55-5f64-8383-6832a383e24b";
const ACTIVE_STOP_INTENT_STATUSES = [
  "pending",
  "dispatching",
  "retry",
  "terminal_attention",
] as const;

/**
 * Shared serialization key for every stop admission targeting one container.
 * Keep admission callers on this helper so billing and explicit cancellation cannot
 * silently drift onto different advisory-lock namespaces.
 */
export function containerStopAdvisoryLockSql(organizationId: string, containerId: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${`container-stop:${organizationId}:${containerId}`}))`;
}

/**
 * Publish the provider-confirmed absence boundary outside the settlement
 * savepoint. The locked container row serializes this exact tenant/lifecycle
 * transition, so a retry can reconstruct the same immutable zero-rate segment
 * without appending duplicates.
 */
async function persistContainerProviderStopFenceInTx(
  tx: DbTransaction,
  p: {
    containerId: string;
    organizationId: string;
    lifecycleRevision: number;
    providerConfirmedAt: Date;
  },
): Promise<void> {
  const [fenced] = await tx
    .update(containers)
    .set({
      // Keep status='running' until terminal settlement succeeds so the stop
      // remains recoverable, but exclude the absent runtime from normal cron
      // discovery immediately.
      billing_status: "suspended",
      next_billing_at: null,
      updated_at: p.providerConfirmedAt,
    })
    .where(
      and(
        eq(containers.id, p.containerId),
        eq(containers.organization_id, p.organizationId),
        eq(containers.lifecycle_revision, p.lifecycleRevision),
        eq(containers.status, "running"),
      ),
    )
    .returning({ id: containers.id });
  if (!fenced) {
    throw new Error("CONTAINER_STOP provider proof lost its live lifecycle fence");
  }

  const segmentId = uuidv5(
    `${p.organizationId}:${p.containerId}:${p.lifecycleRevision}:${p.providerConfirmedAt.toISOString()}`,
    CONTAINER_PROVIDER_STOP_SEGMENT_NAMESPACE,
  );
  await tx
    .insert(computeBillingRateSegments)
    .values({
      id: segmentId,
      organization_id: p.organizationId,
      workload_kind: "container",
      workload_id: p.containerId,
      lifecycle_revision: p.lifecycleRevision,
      billing_state: "not_billable",
      rate_per_hour: "0.000000",
      effective_at: p.providerConfirmedAt,
      created_at: p.providerConfirmedAt,
    })
    .onConflictDoNothing({ target: computeBillingRateSegments.id });
  const [persisted] = await tx
    .select()
    .from(computeBillingRateSegments)
    .where(eq(computeBillingRateSegments.id, segmentId))
    .limit(1);
  if (
    !persisted ||
    persisted.organization_id !== p.organizationId ||
    persisted.workload_kind !== "container" ||
    persisted.workload_id !== p.containerId ||
    persisted.lifecycle_revision !== p.lifecycleRevision ||
    persisted.billing_state !== "not_billable" ||
    !new Decimal(persisted.rate_per_hour).isZero() ||
    persisted.effective_at.getTime() !== p.providerConfirmedAt.getTime()
  ) {
    throw new Error("CONTAINER_STOP deterministic provider cutoff segment conflicted");
  }

  const exactCutoffSegments = await tx
    .select({
      billingState: computeBillingRateSegments.billing_state,
      ratePerHour: computeBillingRateSegments.rate_per_hour,
    })
    .from(computeBillingRateSegments)
    .where(
      and(
        eq(computeBillingRateSegments.organization_id, p.organizationId),
        eq(computeBillingRateSegments.workload_kind, "container"),
        eq(computeBillingRateSegments.workload_id, p.containerId),
        eq(computeBillingRateSegments.lifecycle_revision, p.lifecycleRevision),
        eq(computeBillingRateSegments.effective_at, p.providerConfirmedAt),
      ),
    );
  if (
    exactCutoffSegments.every(
      (segment) =>
        segment.billingState === "not_billable" && new Decimal(segment.ratePerHour).isZero(),
    )
  ) {
    return;
  }
  throw new Error("CONTAINER_STOP provider cutoff conflicts with an existing rate segment");
}

/**
 * Acquire the container stop target before an explicit cancellation takes
 * organization/user authority locks. This helper deliberately performs no
 * lifecycle validation or durable write: the enqueue path repeats the locked
 * read after credential admission and remains the sole behavior authority.
 */
export async function lockContainerStopTargetInTx(
  tx: DbTransaction,
  p: { containerId: string; organizationId: string },
): Promise<void> {
  await tx.execute(containerStopAdvisoryLockSql(p.organizationId, p.containerId));
  await tx
    .select({ id: containers.id })
    .from(containers)
    .where(and(eq(containers.id, p.containerId), eq(containers.organization_id, p.organizationId)))
    .for("update")
    .limit(1);
}

export type EnqueueContainerUserStopResult =
  | {
      requested: true;
      intentId: string;
      jobId: string;
      created: boolean;
      replayed: boolean;
    }
  | {
      requested: false;
      intentId: null;
      jobId: null;
      created: false;
      replayed: false;
      reason: "stale_lifecycle";
      currentLifecycleRevision: number | null;
    };

/** Extract + validate a CONTAINER_STOP job payload (throws if malformed). */
export function readContainerStopJobData(job: { data: unknown }): {
  containerId: string;
  organizationId: string;
  intentId: string;
  lifecycleRevision: number;
} {
  const data = (job.data ?? {}) as Record<string, unknown>;
  if (typeof data.containerId !== "string" || data.containerId.length === 0) {
    throw new Error("CONTAINER_STOP job missing data.containerId");
  }
  if (typeof data.organizationId !== "string" || data.organizationId.length === 0) {
    throw new Error("CONTAINER_STOP job missing data.organizationId");
  }
  if (typeof data.intentId !== "string" || data.intentId.length === 0) {
    throw new Error("CONTAINER_STOP job missing data.intentId");
  }
  if (!Number.isSafeInteger(data.lifecycleRevision) || Number(data.lifecycleRevision) < 0) {
    throw new Error("CONTAINER_STOP job has invalid data.lifecycleRevision");
  }
  return {
    containerId: data.containerId,
    organizationId: data.organizationId,
    intentId: data.intentId,
    lifecycleRevision: Number(data.lifecycleRevision),
  };
}

const CONTAINER_STOP_JOB_DATA_KEYS = new Set([
  "containerId",
  "organizationId",
  "intentId",
  "lifecycleRevision",
  "providerEffectStartedAt",
]);

function assertExactContainerStopJobData(
  job: { data: unknown },
  expected: ReturnType<typeof readContainerStopJobData>,
  mismatchMessage: string,
): ReturnType<typeof readContainerStopJobData> {
  const data = job.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("CONTAINER_STOP claimed job data must be an inline object");
  }
  const keys = Object.keys(data);
  const expectedKeyCount = Object.hasOwn(data, "providerEffectStartedAt") ? 5 : 4;
  if (
    keys.length !== expectedKeyCount ||
    keys.some((key) => !CONTAINER_STOP_JOB_DATA_KEYS.has(key))
  ) {
    throw new Error(mismatchMessage);
  }
  const durable = readContainerStopJobData(job);
  if (
    durable.containerId !== expected.containerId ||
    durable.organizationId !== expected.organizationId ||
    durable.intentId !== expected.intentId ||
    durable.lifecycleRevision !== expected.lifecycleRevision
  ) {
    throw new Error(mismatchMessage);
  }
  return durable;
}

interface ClaimedContainerStopJob {
  id: string;
  organization_id: string;
  execution_generation: string | null;
  data: unknown;
}

function requireProviderAdmissionTimestamp(value: unknown, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`CONTAINER_STOP provider admission has invalid ${field}`);
  }
  return parsed;
}

function readProviderEffectStartedAt(
  data: unknown,
  bounds: { createdAt: Date; databaseNow: Date },
): Date | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("CONTAINER_STOP claimed job data must be an inline object");
  }
  if (!Object.hasOwn(data, "providerEffectStartedAt")) return null;
  const value = (data as Record<string, unknown>).providerEffectStartedAt;
  if (typeof value !== "string") {
    throw new Error("CONTAINER_STOP job has invalid data.providerEffectStartedAt");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("CONTAINER_STOP job has non-canonical data.providerEffectStartedAt");
  }
  if (
    parsed.getTime() < bounds.createdAt.getTime() ||
    parsed.getTime() > bounds.databaseNow.getTime()
  ) {
    throw new Error("CONTAINER_STOP job has out-of-bounds data.providerEffectStartedAt");
  }
  return parsed;
}

/**
 * Durably admit the provider effect before opening the container transaction.
 *
 * The execution generation and renewable owner lease make this a claim-scoped
 * write: a stale worker cannot refresh the marker or reach provider I/O after a
 * successor claim. The timestamp is write-once and survives a later container
 * transaction rollback, providing the conservative cutoff when a retry finds
 * Docker already absent.
 */
async function persistContainerStopProviderEffectAdmission(
  job: ClaimedContainerStopJob,
  executionOwnerId: string,
  expected: ReturnType<typeof readContainerStopJobData>,
): Promise<{ startedAt: Date; preexisting: boolean }> {
  if (!job.id || !job.execution_generation || !executionOwnerId) {
    throw new Error("CONTAINER_STOP provider effect requires an owned execution claim");
  }
  const executionGeneration = job.execution_generation;
  return await dbWrite.transaction(async (tx) => {
    const claimFence = and(
      eq(jobs.id, job.id),
      eq(jobs.type, JOB_TYPES.CONTAINER_STOP),
      eq(jobs.organization_id, expected.organizationId),
      eq(jobs.status, "in_progress"),
      eq(jobs.execution_generation, executionGeneration),
      isNull(jobs.execution_quiesced_at),
      eq(jobs.data_storage, "inline"),
      isNull(jobs.data_key),
      sql`EXISTS (
        SELECT 1
        FROM ${jobExecutionLeases}
        WHERE ${jobExecutionLeases.job_id} = ${job.id}
          AND ${jobExecutionLeases.execution_generation} = ${executionGeneration}
          AND ${jobExecutionLeases.owner_id} = ${executionOwnerId}
          AND ${jobExecutionLeases.expires_at} > NOW()
      )`,
    );
    const [claimed] = await tx
      .select({
        data: jobs.data,
        createdAt: jobs.created_at,
        databaseNow: sql<Date>`NOW()`,
      })
      .from(jobs)
      .where(claimFence)
      .for("update")
      .limit(1);
    if (!claimed) {
      throw new Error("CONTAINER_STOP provider effect lost its exact execution lease");
    }
    assertExactContainerStopJobData(
      claimed,
      expected,
      "CONTAINER_STOP claimed job payload changed before provider admission",
    );
    const createdAt = requireProviderAdmissionTimestamp(claimed.createdAt, "job creation time");
    const databaseNow = requireProviderAdmissionTimestamp(claimed.databaseNow, "database time");
    const existing = readProviderEffectStartedAt(claimed.data, { createdAt, databaseNow });
    if (existing) return { startedAt: existing, preexisting: true };

    const admittedAt = databaseNow;
    const [updated] = await tx
      .update(jobs)
      .set({
        data: {
          ...(claimed.data as Record<string, unknown>),
          providerEffectStartedAt: admittedAt.toISOString(),
        },
        updated_at: admittedAt,
      })
      .where(and(claimFence, sql`NOT jsonb_exists(${jobs.data}, 'providerEffectStartedAt')`))
      .returning({ id: jobs.id });
    if (!updated) {
      throw new Error("CONTAINER_STOP provider effect admission lost its claim fence");
    }
    return { startedAt: admittedAt, preexisting: false };
  });
}

/**
 * Revalidate and pin the exact execution claim at the provider-effect boundary.
 *
 * The durable admission above runs in a completed job-only transaction. This
 * second fence deliberately runs after the lifecycle/accounting/intent lock
 * chain and acquires the job row last. Rearm follows the same
 * container -> intent -> job order, while claim/quiesce paths only need the job
 * row, so no transaction holds a job lock while waiting for a container lock.
 * Keeping this job row locked until the outer transaction commits prevents a
 * successor generation or quiesce from crossing the provider call.
 */
async function lockContainerStopProviderEffectClaimInTx(
  tx: DbTransaction,
  job: ClaimedContainerStopJob,
  executionOwnerId: string,
  expected: ReturnType<typeof readContainerStopJobData>,
  providerEffectStartedAt: Date,
): Promise<void> {
  if (!job.id || !job.execution_generation || !executionOwnerId) {
    throw new Error("CONTAINER_STOP provider effect requires an owned execution claim");
  }
  const executionGeneration = job.execution_generation;
  const [claimed] = await tx
    .select({
      data: jobs.data,
      createdAt: jobs.created_at,
      databaseNow: sql<Date>`clock_timestamp()`,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.type, JOB_TYPES.CONTAINER_STOP),
        eq(jobs.organization_id, expected.organizationId),
        eq(jobs.status, "in_progress"),
        eq(jobs.execution_generation, executionGeneration),
        isNull(jobs.execution_quiesced_at),
        eq(jobs.data_storage, "inline"),
        isNull(jobs.data_key),
      ),
    )
    .for("update")
    .limit(1);
  if (!claimed) {
    throw new Error("CONTAINER_STOP provider effect lost its exact execution claim");
  }
  assertExactContainerStopJobData(
    claimed,
    expected,
    "CONTAINER_STOP claimed job payload changed before provider effect",
  );
  const createdAt = requireProviderAdmissionTimestamp(claimed.createdAt, "job creation time");
  const databaseNow = requireProviderAdmissionTimestamp(claimed.databaseNow, "database time");
  const durableAdmission = readProviderEffectStartedAt(claimed.data, { createdAt, databaseNow });
  if (!durableAdmission || durableAdmission.getTime() !== providerEffectStartedAt.getTime()) {
    throw new Error("CONTAINER_STOP provider admission changed before provider effect");
  }

  // `clock_timestamp()` is intentional: PostgreSQL NOW() is fixed at the
  // transaction start and could accept a lease that expired while lifecycle or
  // funding locks were blocked.
  const [lease] = await tx
    .select({ jobId: jobExecutionLeases.job_id })
    .from(jobExecutionLeases)
    .where(
      and(
        eq(jobExecutionLeases.job_id, job.id),
        eq(jobExecutionLeases.execution_generation, executionGeneration),
        eq(jobExecutionLeases.owner_id, executionOwnerId),
        sql`${jobExecutionLeases.expires_at} > clock_timestamp()`,
      ),
    )
    .limit(1);
  if (!lease) {
    throw new Error("CONTAINER_STOP provider effect lost its exact execution lease");
  }
}

/**
 * Daemon: stop + remove the live container for a claimed CONTAINER_STOP job.
 * Preserves the volume (`purgeVolume: false`) and decrements the node's
 * allocated count (HetznerContainersClient.stopContainer does both). A
 * container whose row is already `stopped`/gone is treated as already-stopped
 * (idempotent) — the same `container_not_found` short-circuit the delete path
 * tolerates — so a re-claim after the row was finalized cannot fail the job.
 */
export async function dispatchContainerStopJob(
  job: ClaimedContainerStopJob,
  options: { executionOwnerId: string },
): Promise<ContainerStopOutcome> {
  const { containerId, organizationId, intentId, lifecycleRevision } =
    readContainerStopJobData(job);
  if (job.organization_id !== organizationId) {
    throw new Error("CONTAINER_STOP job tenant envelope mismatch");
  }
  const providerAdmission = await persistContainerStopProviderEffectAdmission(
    job,
    options.executionOwnerId,
    { containerId, organizationId, intentId, lifecycleRevision },
  );
  const providerEffectStartedAt = providerAdmission.startedAt;
  // Node-only: HetznerContainersClient uses `ssh2`. Imported lazily so the
  // Worker enqueue path never loads it.
  const { getHetznerContainersClient } = await import("./containers/hetzner-client");
  const dispatch = await dbWrite.transaction(async (tx) => {
    const [candidateIntent] = await tx
      .select()
      .from(containerComputeStopIntents)
      .where(
        and(
          eq(containerComputeStopIntents.id, intentId),
          eq(containerComputeStopIntents.organization_id, organizationId),
          eq(containerComputeStopIntents.container_id, containerId),
        ),
      )
      .limit(1);
    if (!candidateIntent) {
      throw new Error("CONTAINER_STOP durable intent not found for tenant envelope");
    }
    if (candidateIntent.lifecycle_revision !== lifecycleRevision) {
      throw new Error("CONTAINER_STOP payload lifecycle revision does not match durable intent");
    }

    // This row lock is intentionally held across provider I/O. Every restart
    // and redeploy must first mutate this row, so a newer lifecycle generation
    // cannot race between the final fence check and docker stop.
    const [container] = await tx
      .select({
        name: containers.name,
        user_id: containers.user_id,
        status: containers.status,
        billing_status: containers.billing_status,
        lifecycle_revision: containers.lifecycle_revision,
        last_billed_at: containers.last_billed_at,
        created_at: containers.created_at,
      })
      .from(containers)
      .where(and(eq(containers.id, containerId), eq(containers.organization_id, organizationId)))
      .for("update")
      .limit(1);

    // Every stop path takes the complete compute-accounting lock chain before
    // the durable intent. The provider call remains unconditional for an
    // explicit user request, but these locks make its terminal settlement
    // atomic with concurrent top-ups, conversions, restarts, and stop claims.
    const [organization] = await tx
      .select({
        credit_balance: organizations.credit_balance,
        pay_as_you_go_from_earnings: organizations.pay_as_you_go_from_earnings,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for("update")
      .limit(1);
    if (!organization) throw new Error("CONTAINER_STOP billing organization not found");

    let earningsAvailable = new Decimal(0);
    let earningsSourceUserId: string | null = null;
    if (organization.pay_as_you_go_from_earnings) {
      const [sourceUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.organization_id, organizationId))
        .orderBy(desc(sql`${users.role} = 'owner'`), asc(users.created_at), asc(users.id))
        .limit(1);
      if (sourceUser) {
        earningsSourceUserId = sourceUser.id;
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`redeemable_earnings:${sourceUser.id}`}))`,
        );
        const [earnings] = await tx
          .select({ available_balance: redeemableEarnings.available_balance })
          .from(redeemableEarnings)
          .where(eq(redeemableEarnings.user_id, sourceUser.id))
          .for("update")
          .limit(1);
        if (earnings) earningsAvailable = new Decimal(earnings.available_balance);
      }
    }

    // Authorization is durable effect authority, so the daemon must branch on
    // the locked intent rather than trusting the job payload. The workload row
    // is locked first, matching every lifecycle writer for this container; a
    // concurrent promotion or restart therefore cannot cross the provider
    // fence while this claim is in flight.
    const [intent] = await tx
      .select()
      .from(containerComputeStopIntents)
      .where(
        and(
          eq(containerComputeStopIntents.id, intentId),
          eq(containerComputeStopIntents.organization_id, organizationId),
          eq(containerComputeStopIntents.container_id, containerId),
        ),
      )
      .for("update")
      .limit(1);
    if (!intent || intent.lifecycle_revision !== lifecycleRevision) {
      throw new Error("CONTAINER_STOP durable intent changed during claim");
    }
    if (intent.job_id && job.id && intent.job_id !== job.id) {
      throw new Error("CONTAINER_STOP job is not the current durable intent owner");
    }
    if (intent.status === "provider_confirmed") {
      return {
        outcome: { stopped: true, reason: "already-provider-confirmed" },
        releaseNodeId: intent.slot_released_at ? null : intent.provider_node_id,
      };
    }
    if (intent.status === "superseded") {
      return { outcome: { stopped: false, reason: "superseded" } };
    }
    const userRequested = intent.authorization === "user_request";
    const hasProviderProof = intent.provider_confirmed_at !== null;
    if (
      !container ||
      container.lifecycle_revision !== lifecycleRevision ||
      container.status !== "running" ||
      (!userRequested && !hasProviderProof && container.billing_status !== "shutdown_pending")
    ) {
      const supersededAt = new Date();
      await tx
        .update(containerComputeStopIntents)
        .set({ status: "superseded", superseded_at: supersededAt, updated_at: supersededAt })
        .where(eq(containerComputeStopIntents.id, intentId));
      return { outcome: { stopped: false, reason: "stale-lifecycle-generation" } };
    }

    // Billing authority remains conditional on insufficient funding at the
    // effect boundary. An explicit user request is unconditional at the
    // provider boundary; funding only decides its post-provider settlement.
    if (!userRequested && !hasProviderProof && !providerAdmission.preexisting) {
      const settled = await settleComputeRateSegments(tx, {
        organizationId,
        workloadKind: "container",
        workloadId: containerId,
        periodStart: container.last_billed_at ?? container.created_at,
        periodEnd: new Date(),
      });
      const creditAvailable = new Decimal(organization.credit_balance);
      if (!creditAvailable.isFinite() || !earningsAvailable.isFinite()) {
        throw new Error("CONTAINER_STOP funding source contains an invalid numeric balance");
      }
      if (creditAvailable.plus(earningsAvailable).gte(settled.amount)) {
        const fundedAt = new Date();
        await tx
          .update(containerComputeStopIntents)
          .set({ status: "superseded", superseded_at: fundedAt, updated_at: fundedAt })
          .where(eq(containerComputeStopIntents.id, intentId));
        await tx
          .update(containers)
          .set({
            billing_status: "active",
            next_billing_at: fundedAt,
            shutdown_warning_sent_at: null,
            scheduled_shutdown_at: null,
            updated_at: fundedAt,
          })
          .where(
            and(eq(containers.id, containerId), eq(containers.organization_id, organizationId)),
          );
        return { outcome: { stopped: false, reason: "funding-restored" } };
      }
    }

    const attempt = intent.attempts + 1;
    const startedAt = new Date();
    await tx
      .update(containerComputeStopIntents)
      .set({
        status: "dispatching",
        attempts: attempt,
        provider_started_at: intent.provider_started_at ?? providerEffectStartedAt,
        last_error: null,
        updated_at: startedAt,
      })
      .where(eq(containerComputeStopIntents.id, intentId));

    let confirmedAt = intent.provider_confirmed_at;
    let providerNodeId = intent.provider_node_id;
    if (!confirmedAt) {
      await lockContainerStopProviderEffectClaimInTx(
        tx,
        job,
        options.executionOwnerId,
        { containerId, organizationId, intentId, lifecycleRevision },
        providerEffectStartedAt,
      );
      try {
        const provider = await getHetznerContainersClient().stopContainerRuntimeForBilling(
          containerId,
          organizationId,
          lifecycleRevision,
        );
        providerNodeId = provider.nodeId;
        confirmedAt = provider.alreadyAbsent ? providerEffectStartedAt : new Date();
      } catch (error) {
        // error-policy:J2 context-adding rethrow — persist the durable retry
        // classification, then propagate provider context with its original cause.
        const message = error instanceof Error ? error.message : String(error);
        const failedAt = new Date();
        await tx
          .update(containerComputeStopIntents)
          .set({
            status: attempt >= STOP_INTENT_MAX_ORDINARY_ATTEMPTS ? "terminal_attention" : "retry",
            last_error: message,
            next_attempt_at: new Date(failedAt.getTime() + STOP_INTENT_RETRY_MS),
            updated_at: failedAt,
          })
          .where(eq(containerComputeStopIntents.id, intentId));
        return {
          outcome: { stopped: false },
          error: new ElizaError(`Container provider stop failed: ${message}`, {
            code: "CONTAINER_STOP_PROVIDER_FAILED",
            context: { containerId, organizationId, intentId, lifecycleRevision, attempt },
            cause: error,
          }),
        };
      }

      // Persist the first successful provider cutoff before the settlement
      // savepoints. If this outer transaction itself aborts, the job admission
      // marker survives and an already-absent retry reconstructs the original
      // conservative boundary instead of moving it to retry time.
      if (!confirmedAt) {
        throw new Error("CONTAINER_STOP provider acknowledgement did not produce a cutoff");
      }
      const proofPersistedAt = new Date();
      await tx
        .update(containerComputeStopIntents)
        .set({
          provider_confirmed_at: confirmedAt,
          provider_node_id: providerNodeId,
          updated_at: proofPersistedAt,
        })
        .where(eq(containerComputeStopIntents.id, intentId));
    }
    if (!confirmedAt) {
      throw new Error("CONTAINER_STOP provider confirmation timestamp was not persisted");
    }
    try {
      // The provider proof above is the only post-I/O write allowed directly
      // in the outer transaction. A SQL failure while publishing the billing
      // fence must roll back to a savepoint, otherwise PostgreSQL leaves the
      // outer transaction aborted and the proof/retry state cannot commit.
      await tx.transaction(async (fenceTx) => {
        await persistContainerProviderStopFenceInTx(fenceTx, {
          containerId,
          organizationId,
          lifecycleRevision,
          providerConfirmedAt: confirmedAt,
        });
      });
      // Provider confirmation is the authoritative terminal cutoff. The
      // billing writes and final state publication share a savepoint, while the
      // provider proof above remains in the outer transaction if they fail.
      return await tx.transaction(async (settlementTx) => {
        const settlement =
          await containerBillingRepository.recordSuccessfulDailyBillingInTransaction(
            settlementTx,
            {
              containerId,
              organizationId,
              userId: container.user_id,
              containerName: container.name,
              dailyRate: 0,
              earningsSourceUserId,
              payAsYouGoFromEarnings: organization.pay_as_you_go_from_earnings,
              newBalance: 0,
              now: confirmedAt,
            },
            {
              forceLifecycleSettlement: true,
              terminalInsufficientDisposition: "uncollected",
            },
          );
        if (settlement.insufficient && !settlement.uncollected) {
          throw new Error("CONTAINER_STOP terminal settlement did not record its disposition");
        }

        await settlementTx
          .update(containers)
          .set({
            status: "stopped",
            billing_status: "suspended",
            next_billing_at: null,
            shutdown_warning_sent_at: null,
            scheduled_shutdown_at: null,
            updated_at: confirmedAt,
          })
          .where(
            and(eq(containers.id, containerId), eq(containers.organization_id, organizationId)),
          );
        await settlementTx
          .update(containerComputeStopIntents)
          .set({
            status: "provider_confirmed",
            provider_confirmed_at: confirmedAt,
            provider_node_id: providerNodeId,
            updated_at: confirmedAt,
          })
          .where(eq(containerComputeStopIntents.id, intentId));
        return { outcome: { stopped: true }, releaseNodeId: providerNodeId };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = new Date();
      await tx
        .update(containerComputeStopIntents)
        .set({
          status: attempt >= STOP_INTENT_MAX_ORDINARY_ATTEMPTS ? "terminal_attention" : "retry",
          provider_confirmed_at: confirmedAt,
          provider_node_id: providerNodeId,
          last_error: message,
          next_attempt_at: new Date(failedAt.getTime() + STOP_INTENT_RETRY_MS),
          updated_at: failedAt,
        })
        .where(eq(containerComputeStopIntents.id, intentId));
      return { outcome: { stopped: false }, error: new Error(message) };
    }
  });
  if ("error" in dispatch && dispatch.error) {
    throw dispatch.error;
  }
  if (dispatch.releaseNodeId) {
    await containersRepository.tryReleaseNodeSlot(
      containerId,
      organizationId,
      dispatch.releaseNodeId,
    );
    await dbWrite
      .update(containerComputeStopIntents)
      .set({ slot_released_at: new Date(), updated_at: new Date() })
      .where(eq(containerComputeStopIntents.id, intentId));
  }
  return dispatch.outcome;
}

/** Enqueue a CONTAINER_STOP job (SSH-free) over the shared job writer. */
export function enqueueContainerStop(
  writer: ContainerJobsWriter,
  p: {
    containerId: string;
    organizationId: string;
    intentId: string;
    lifecycleRevision: number;
    userId?: string;
  },
): Promise<{ id: string }> {
  return writer.insertJob({
    type: JOB_TYPES.CONTAINER_STOP,
    organizationId: p.organizationId,
    userId: p.userId,
    data: {
      containerId: p.containerId,
      organizationId: p.organizationId,
      intentId: p.intentId,
      lifecycleRevision: p.lifecycleRevision,
    },
  });
}

async function insertContainerStopJobInTx(
  tx: DbTransaction,
  p: {
    containerId: string;
    organizationId: string;
    userId: string;
    intentId: string;
    lifecycleRevision: number;
  },
): Promise<string> {
  const [created] = await tx
    .insert(jobs)
    .values({
      type: JOB_TYPES.CONTAINER_STOP,
      status: "pending",
      organization_id: p.organizationId,
      user_id: p.userId,
      data: {
        containerId: p.containerId,
        organizationId: p.organizationId,
        intentId: p.intentId,
        lifecycleRevision: p.lifecycleRevision,
      },
    })
    .returning({ id: jobs.id });
  if (!created) throw new Error("Container stop job insert returned no row");
  await tx
    .update(containerComputeStopIntents)
    .set({ job_id: created.id, updated_at: new Date() })
    .where(eq(containerComputeStopIntents.id, p.intentId));
  return created.id;
}

async function findLiveContainerStopJobInTx(
  tx: DbTransaction,
  p: {
    jobId: string | null;
    containerId: string;
    organizationId: string;
    intentId: string;
    lifecycleRevision: number;
  },
): Promise<string | null> {
  if (!p.jobId) return null;
  const [liveJob] = await tx
    .select({ id: jobs.id, data: jobs.data })
    .from(jobs)
    .where(
      and(
        eq(jobs.id, p.jobId),
        eq(jobs.type, JOB_TYPES.CONTAINER_STOP),
        eq(jobs.organization_id, p.organizationId),
        inArray(jobs.status, ["pending", "in_progress"]),
      ),
    )
    .for("update")
    .limit(1);
  if (!liveJob) return null;
  const data = readContainerStopJobData(liveJob);
  if (
    data.containerId !== p.containerId ||
    data.organizationId !== p.organizationId ||
    data.intentId !== p.intentId ||
    data.lifecycleRevision !== p.lifecycleRevision
  ) {
    throw new Error("Live container stop job payload does not match its durable intent");
  }
  return liveJob.id;
}

async function rearmContainerStopIntentJobInTx(
  tx: DbTransaction,
  p: {
    containerId: string;
    organizationId: string;
    userId: string;
    intentId: string;
    lifecycleRevision: number;
    hasProviderProof: boolean;
    preserveProviderConfirmedStatus?: boolean;
    jobId: string | null;
    rearmAt?: Date;
  },
): Promise<string> {
  const rearmedAt = p.rearmAt ?? new Date();
  const [boundJob] = p.jobId
    ? await tx
        .select({
          id: jobs.id,
          type: jobs.type,
          organizationId: jobs.organization_id,
          status: jobs.status,
          data: jobs.data,
        })
        .from(jobs)
        .where(eq(jobs.id, p.jobId))
        .for("update")
        .limit(1)
    : [undefined];
  if (
    boundJob &&
    (boundJob.type !== JOB_TYPES.CONTAINER_STOP || boundJob.organizationId !== p.organizationId)
  ) {
    throw new Error("Container stop intent is bound to a foreign job envelope");
  }
  if (boundJob) {
    const data = readContainerStopJobData(boundJob);
    if (
      data.containerId !== p.containerId ||
      data.organizationId !== p.organizationId ||
      data.intentId !== p.intentId ||
      data.lifecycleRevision !== p.lifecycleRevision
    ) {
      throw new Error("Container stop intent is bound to a mismatched job payload");
    }
  }
  if (boundJob && ["pending", "in_progress"].includes(boundJob.status)) {
    return boundJob.id;
  }
  if (boundJob && boundJob.status !== "failed") {
    throw new Error(`Terminal container stop job cannot be rearmed from ${boundJob.status}`);
  }

  await tx
    .update(containerComputeStopIntents)
    .set(
      p.preserveProviderConfirmedStatus
        ? {
            status: "provider_confirmed",
            job_id: boundJob?.id ?? null,
            next_attempt_at: rearmedAt,
            updated_at: rearmedAt,
          }
        : p.hasProviderProof
          ? {
              status: "retry",
              job_id: boundJob?.id ?? null,
              next_attempt_at: rearmedAt,
              updated_at: rearmedAt,
            }
          : {
              status: "pending",
              job_id: boundJob?.id ?? null,
              attempts: 0,
              last_error: null,
              next_attempt_at: rearmedAt,
              provider_started_at: null,
              provider_confirmed_at: null,
              provider_node_id: null,
              superseded_at: null,
              updated_at: rearmedAt,
            },
    )
    .where(eq(containerComputeStopIntents.id, p.intentId));
  if (boundJob) {
    await tx.delete(jobExecutionLeases).where(eq(jobExecutionLeases.job_id, boundJob.id));
    const [rearmedJob] = await tx
      .update(jobs)
      .set({
        status: "pending",
        user_id: p.userId,
        attempts: 0,
        execution_interruptions: 0,
        retryable_requeues: 0,
        estimated_completion_at: null,
        scheduled_for: rearmedAt,
        execution_generation: null,
        execution_quiesced_at: null,
        completed_at: null,
        updated_at: rearmedAt,
      })
      .where(
        and(
          eq(jobs.id, boundJob.id),
          eq(jobs.type, JOB_TYPES.CONTAINER_STOP),
          eq(jobs.organization_id, p.organizationId),
          eq(jobs.status, "failed"),
        ),
      )
      .returning({ id: jobs.id });
    if (!rearmedJob) {
      throw new Error("Failed container stop job lost its rearm fence");
    }
    return boundJob.id;
  }
  return await insertContainerStopJobInTx(tx, p);
}

/**
 * Ensure a due durable stop intent has an executable job without applying the
 * billing cron's ordinary due/scheduled-shutdown admission rules. This is the
 * independent recovery path for user stops and provider-confirmed settlement
 * retries, including containers fenced as suspended after provider I/O.
 */
export async function rearmRecoverableContainerStopIntentOnce(p: {
  intentId: string;
  containerId: string;
  organizationId: string;
  lifecycleRevision: number;
  now: Date;
}): Promise<{ id: string; rearmed: boolean }> {
  return await dbWrite.transaction(async (tx) => {
    await tx.execute(containerStopAdvisoryLockSql(p.organizationId, p.containerId));
    const [container] = await tx
      .select({
        userId: containers.user_id,
        status: containers.status,
        billingStatus: containers.billing_status,
        lifecycleRevision: containers.lifecycle_revision,
      })
      .from(containers)
      .where(
        and(eq(containers.id, p.containerId), eq(containers.organization_id, p.organizationId)),
      )
      .for("update")
      .limit(1);
    if (!container || container.lifecycleRevision !== p.lifecycleRevision) {
      throw new Error("Recoverable container stop intent lost its live lifecycle fence");
    }

    const [intent] = await tx
      .select()
      .from(containerComputeStopIntents)
      .where(
        and(
          eq(containerComputeStopIntents.id, p.intentId),
          eq(containerComputeStopIntents.organization_id, p.organizationId),
          eq(containerComputeStopIntents.container_id, p.containerId),
          eq(containerComputeStopIntents.lifecycle_revision, p.lifecycleRevision),
          inArray(containerComputeStopIntents.status, [
            "pending",
            "retry",
            "terminal_attention",
            "provider_confirmed",
          ]),
          lte(containerComputeStopIntents.next_attempt_at, p.now),
        ),
      )
      .for("update")
      .limit(1);
    if (!intent) {
      throw new Error("Container stop intent is no longer due for recovery");
    }
    const providerConfirmedSlotRelease =
      intent.status === "provider_confirmed" &&
      intent.provider_confirmed_at !== null &&
      intent.provider_node_id !== null &&
      intent.slot_released_at === null &&
      container.status === "stopped";
    const liveStopRecovery =
      container.status === "running" && intent.status !== "provider_confirmed";
    if (!providerConfirmedSlotRelease && !liveStopRecovery) {
      throw new Error("Recoverable container stop intent lost its live lifecycle fence");
    }
    if (
      !providerConfirmedSlotRelease &&
      intent.authorization === "billing_request" &&
      intent.provider_confirmed_at === null &&
      container.billingStatus !== "shutdown_pending"
    ) {
      throw new Error("Billing stop recovery lost its shutdown authority");
    }

    const liveJobId = await findLiveContainerStopJobInTx(tx, {
      jobId: intent.job_id,
      containerId: p.containerId,
      organizationId: p.organizationId,
      intentId: intent.id,
      lifecycleRevision: intent.lifecycle_revision,
    });
    if (liveJobId) return { id: liveJobId, rearmed: false };
    const jobId = await rearmContainerStopIntentJobInTx(tx, {
      containerId: p.containerId,
      organizationId: p.organizationId,
      userId: container.userId,
      intentId: intent.id,
      lifecycleRevision: intent.lifecycle_revision,
      hasProviderProof: intent.provider_confirmed_at !== null,
      preserveProviderConfirmedStatus: providerConfirmedSlotRelease,
      jobId: intent.job_id,
      rearmAt: p.now,
    });
    return { id: jobId, rearmed: true };
  });
}

/**
 * Persist an explicit user stop inside the caller's transaction.
 *
 * The exact logical user intent is read before the current lifecycle revision,
 * so a retry after a lost response returns the original job even if that job
 * has already stopped the generation. A first-time stale request creates
 * neither an intent nor a job. Billing authority for the same live generation
 * is promoted in place and can never be downgraded again.
 */
export async function enqueueContainerUserStopInTx(
  tx: DbTransaction,
  p: {
    containerId: string;
    organizationId: string;
    userId: string;
    expectedLifecycleRevision: number;
  },
): Promise<EnqueueContainerUserStopResult> {
  if (!Number.isSafeInteger(p.expectedLifecycleRevision) || p.expectedLifecycleRevision < 0) {
    throw new Error("Container stop expected lifecycle revision must be a non-negative integer");
  }

  await tx.execute(containerStopAdvisoryLockSql(p.organizationId, p.containerId));

  const [replayedIntent] = await tx
    .select()
    .from(containerComputeStopIntents)
    .where(
      and(
        eq(containerComputeStopIntents.organization_id, p.organizationId),
        eq(containerComputeStopIntents.container_id, p.containerId),
        eq(containerComputeStopIntents.lifecycle_revision, p.expectedLifecycleRevision),
        eq(containerComputeStopIntents.authorization, "user_request"),
      ),
    )
    .for("update")
    .limit(1);
  if (replayedIntent) {
    const rearmable = ACTIVE_STOP_INTENT_STATUSES.includes(
      replayedIntent.status as (typeof ACTIVE_STOP_INTENT_STATUSES)[number],
    );
    if (rearmable) {
      const liveJobId = await findLiveContainerStopJobInTx(tx, {
        jobId: replayedIntent.job_id,
        containerId: p.containerId,
        organizationId: p.organizationId,
        intentId: replayedIntent.id,
        lifecycleRevision: replayedIntent.lifecycle_revision,
      });
      if (!liveJobId) {
        const jobId = await rearmContainerStopIntentJobInTx(tx, {
          ...p,
          intentId: replayedIntent.id,
          lifecycleRevision: p.expectedLifecycleRevision,
          hasProviderProof: replayedIntent.provider_confirmed_at !== null,
          jobId: replayedIntent.job_id,
        });
        return {
          requested: true,
          intentId: replayedIntent.id,
          jobId,
          created: true,
          replayed: true,
        };
      }
    }
    if (!replayedIntent.job_id) {
      throw new Error("Terminal container user stop intent is missing its historical job binding");
    }
    return {
      requested: true,
      intentId: replayedIntent.id,
      jobId: replayedIntent.job_id,
      created: false,
      replayed: true,
    };
  }

  const [container] = await tx
    .select({
      lifecycle_revision: containers.lifecycle_revision,
      status: containers.status,
    })
    .from(containers)
    .where(and(eq(containers.id, p.containerId), eq(containers.organization_id, p.organizationId)))
    .for("update")
    .limit(1);
  if (
    !container ||
    container.lifecycle_revision !== p.expectedLifecycleRevision ||
    container.status !== "running"
  ) {
    return {
      requested: false,
      intentId: null,
      jobId: null,
      created: false,
      replayed: false,
      reason: "stale_lifecycle",
      currentLifecycleRevision: container?.lifecycle_revision ?? null,
    };
  }

  const [billingIntent] = await tx
    .select()
    .from(containerComputeStopIntents)
    .where(
      and(
        eq(containerComputeStopIntents.organization_id, p.organizationId),
        eq(containerComputeStopIntents.container_id, p.containerId),
        eq(containerComputeStopIntents.lifecycle_revision, p.expectedLifecycleRevision),
        eq(containerComputeStopIntents.authorization, "billing_request"),
        inArray(containerComputeStopIntents.status, [...ACTIVE_STOP_INTENT_STATUSES]),
      ),
    )
    .for("update")
    .limit(1);
  if (billingIntent) {
    const liveBillingJobId = await findLiveContainerStopJobInTx(tx, {
      jobId: billingIntent.job_id,
      containerId: p.containerId,
      organizationId: p.organizationId,
      intentId: billingIntent.id,
      lifecycleRevision: billingIntent.lifecycle_revision,
    });
    const promotedAt = new Date();
    await tx
      .update(containerComputeStopIntents)
      .set({ authorization: "user_request", updated_at: promotedAt })
      .where(eq(containerComputeStopIntents.id, billingIntent.id));
    if (liveBillingJobId) {
      // Preserve the existing job envelope verbatim. A daemon may already hold
      // a claimed snapshot whose settlement fence includes user_id; rewriting
      // it here would strand that safe in-flight execution.
      return {
        requested: true,
        intentId: billingIntent.id,
        jobId: liveBillingJobId,
        created: false,
        replayed: false,
      };
    }
    const jobId = await rearmContainerStopIntentJobInTx(tx, {
      ...p,
      intentId: billingIntent.id,
      lifecycleRevision: p.expectedLifecycleRevision,
      hasProviderProof: billingIntent.provider_confirmed_at !== null,
      jobId: billingIntent.job_id,
    });
    return {
      requested: true,
      intentId: billingIntent.id,
      jobId,
      created: true,
      replayed: false,
    };
  }

  // A stale active intent from an older generation cannot retain the
  // per-container active slot once the locked container proves a newer live
  // generation. Its already-enqueued job remains safe: dispatch observes the
  // terminal status/lifecycle fence and performs no provider call.
  const supersededAt = new Date();
  await tx
    .update(containerComputeStopIntents)
    .set({ status: "superseded", superseded_at: supersededAt, updated_at: supersededAt })
    .where(
      and(
        eq(containerComputeStopIntents.organization_id, p.organizationId),
        eq(containerComputeStopIntents.container_id, p.containerId),
        ne(containerComputeStopIntents.lifecycle_revision, p.expectedLifecycleRevision),
        inArray(containerComputeStopIntents.status, [...ACTIVE_STOP_INTENT_STATUSES]),
      ),
    );

  const [intent] = await tx
    .insert(containerComputeStopIntents)
    .values({
      organization_id: p.organizationId,
      container_id: p.containerId,
      lifecycle_revision: p.expectedLifecycleRevision,
      authorization: "user_request",
    })
    .returning();
  if (!intent) throw new Error("Container user stop intent insert returned no row");
  const jobId = await insertContainerStopJobInTx(tx, {
    ...p,
    intentId: intent.id,
    lifecycleRevision: p.expectedLifecycleRevision,
  });
  return {
    requested: true,
    intentId: intent.id,
    jobId,
    created: true,
    replayed: false,
  };
}

/** Public transaction wrapper for callers that do not already own a receipt transaction. */
export async function enqueueContainerUserStopOnce(p: {
  containerId: string;
  organizationId: string;
  userId: string;
  expectedLifecycleRevision: number;
}): Promise<EnqueueContainerUserStopResult> {
  return await dbWrite.transaction((tx) => enqueueContainerUserStopInTx(tx, p));
}

/**
 * Persist one active stop job per tenant/container under a transaction-scoped
 * lock. Retries after a route crash reuse the pending/in-progress job instead
 * of issuing another provider stop generation.
 */
export async function enqueueContainerStopOnce(p: {
  containerId: string;
  organizationId: string;
  userId?: string;
}): Promise<
  | { requested: true; id: string; created: boolean }
  | { requested: false; id: null; created: false; reason: "funding_restored" }
> {
  return await dbWrite.transaction(async (tx) => {
    await tx.execute(containerStopAdvisoryLockSql(p.organizationId, p.containerId));
    const [container] = await tx
      .select({
        user_id: containers.user_id,
        lifecycle_revision: containers.lifecycle_revision,
        status: containers.status,
        billing_status: containers.billing_status,
        scheduled_shutdown_at: containers.scheduled_shutdown_at,
        last_billed_at: containers.last_billed_at,
        created_at: containers.created_at,
      })
      .from(containers)
      .where(
        and(eq(containers.id, p.containerId), eq(containers.organization_id, p.organizationId)),
      )
      .for("update")
      .limit(1);
    if (!container) throw new Error("Container stop target not found in tenant");
    const now = new Date();
    if (
      container.status !== "running" ||
      !["shutdown_pending", "suspended"].includes(container.billing_status) ||
      !container.scheduled_shutdown_at ||
      container.scheduled_shutdown_at > now
    ) {
      throw new Error("Container is not eligible for a billing stop intent");
    }
    const [userIntent] = await tx
      .select()
      .from(containerComputeStopIntents)
      .where(
        and(
          eq(containerComputeStopIntents.organization_id, p.organizationId),
          eq(containerComputeStopIntents.container_id, p.containerId),
          eq(containerComputeStopIntents.lifecycle_revision, container.lifecycle_revision),
          eq(containerComputeStopIntents.authorization, "user_request"),
          inArray(containerComputeStopIntents.status, [...ACTIVE_STOP_INTENT_STATUSES]),
        ),
      )
      .for("update")
      .limit(1);
    if (userIntent) {
      const liveJobId = await findLiveContainerStopJobInTx(tx, {
        jobId: userIntent.job_id,
        containerId: p.containerId,
        organizationId: p.organizationId,
        intentId: userIntent.id,
        lifecycleRevision: userIntent.lifecycle_revision,
      });
      if (liveJobId) {
        return { requested: true, id: liveJobId, created: false };
      }
      const jobId = await rearmContainerStopIntentJobInTx(tx, {
        containerId: p.containerId,
        organizationId: p.organizationId,
        userId: container.user_id,
        intentId: userIntent.id,
        lifecycleRevision: userIntent.lifecycle_revision,
        hasProviderProof: userIntent.provider_confirmed_at !== null,
        jobId: userIntent.job_id,
      });
      return { requested: true, id: jobId, created: true };
    }
    const [organization] = await tx
      .select({
        credit_balance: organizations.credit_balance,
        pay_as_you_go_from_earnings: organizations.pay_as_you_go_from_earnings,
      })
      .from(organizations)
      .where(eq(organizations.id, p.organizationId))
      .for("update")
      .limit(1);
    if (!organization) throw new Error("Container billing organization not found");

    let earningsAvailable = new Decimal(0);
    if (organization.pay_as_you_go_from_earnings) {
      const [sourceUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.organization_id, p.organizationId))
        .orderBy(desc(sql`${users.role} = 'owner'`), asc(users.created_at), asc(users.id))
        .limit(1);
      if (sourceUser) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`redeemable_earnings:${sourceUser.id}`}))`,
        );
        const [earnings] = await tx
          .select({ available_balance: redeemableEarnings.available_balance })
          .from(redeemableEarnings)
          .where(eq(redeemableEarnings.user_id, sourceUser.id))
          .for("update")
          .limit(1);
        if (earnings) earningsAvailable = new Decimal(earnings.available_balance);
      }
    }
    const [existingIntent] = await tx
      .select()
      .from(containerComputeStopIntents)
      .where(
        and(
          eq(containerComputeStopIntents.organization_id, p.organizationId),
          eq(containerComputeStopIntents.container_id, p.containerId),
          inArray(containerComputeStopIntents.status, [
            "pending",
            "dispatching",
            "retry",
            "terminal_attention",
          ]),
        ),
      )
      .for("update")
      .limit(1);
    const [providerEffectAdmission] = existingIntent
      ? await tx
          .select({
            exists: unreconciledContainerStopProviderEffectExistsSql(
              p.organizationId,
              p.containerId,
            ),
          })
          .from(containerComputeStopIntents)
          .where(eq(containerComputeStopIntents.id, existingIntent.id))
          .limit(1)
      : [undefined];
    if (
      existingIntent &&
      (existingIntent.provider_confirmed_at || providerEffectAdmission?.exists)
    ) {
      const liveJobId = await findLiveContainerStopJobInTx(tx, {
        jobId: existingIntent.job_id,
        containerId: p.containerId,
        organizationId: p.organizationId,
        intentId: existingIntent.id,
        lifecycleRevision: existingIntent.lifecycle_revision,
      });
      if (liveJobId) return { requested: true, id: liveJobId, created: false };
      const jobId = await rearmContainerStopIntentJobInTx(tx, {
        containerId: p.containerId,
        organizationId: p.organizationId,
        userId: container.user_id,
        intentId: existingIntent.id,
        lifecycleRevision: existingIntent.lifecycle_revision,
        hasProviderProof: existingIntent.provider_confirmed_at !== null,
        jobId: existingIntent.job_id,
      });
      return { requested: true, id: jobId, created: true };
    }
    if (container.billing_status === "suspended") {
      throw new Error("Suspended container has no recoverable provider-confirmed stop intent");
    }

    const periodStart = container.last_billed_at ?? container.created_at;
    const settled = await settleComputeRateSegments(tx, {
      organizationId: p.organizationId,
      workloadKind: "container",
      workloadId: p.containerId,
      periodStart,
      periodEnd: now,
    });
    const creditAvailable = new Decimal(organization.credit_balance);
    if (!creditAvailable.isFinite() || !earningsAvailable.isFinite()) {
      throw new Error("Container stop funding source contains an invalid numeric balance");
    }
    if (creditAvailable.plus(earningsAvailable).gte(settled.amount)) {
      await tx
        .update(containerComputeStopIntents)
        .set({ status: "superseded", superseded_at: now, updated_at: now })
        .where(
          and(
            eq(containerComputeStopIntents.organization_id, p.organizationId),
            eq(containerComputeStopIntents.container_id, p.containerId),
            eq(containerComputeStopIntents.authorization, "billing_request"),
            inArray(containerComputeStopIntents.status, [
              "pending",
              "dispatching",
              "retry",
              "terminal_attention",
            ]),
          ),
        );
      await tx
        .update(containers)
        .set({
          billing_status: "active",
          next_billing_at: now,
          shutdown_warning_sent_at: null,
          scheduled_shutdown_at: null,
          updated_at: now,
        })
        .where(
          and(eq(containers.id, p.containerId), eq(containers.organization_id, p.organizationId)),
        );
      return { requested: false, id: null, created: false, reason: "funding_restored" };
    }
    if (existingIntent) {
      const liveJobId = await findLiveContainerStopJobInTx(tx, {
        jobId: existingIntent.job_id,
        containerId: p.containerId,
        organizationId: p.organizationId,
        intentId: existingIntent.id,
        lifecycleRevision: existingIntent.lifecycle_revision,
      });
      if (liveJobId) return { requested: true, id: liveJobId, created: false };
      const jobId = await rearmContainerStopIntentJobInTx(tx, {
        containerId: p.containerId,
        organizationId: p.organizationId,
        userId: container.user_id,
        intentId: existingIntent.id,
        lifecycleRevision: existingIntent.lifecycle_revision,
        hasProviderProof: false,
        jobId: existingIntent.job_id,
      });
      return { requested: true, id: jobId, created: true };
    }

    const [intent] = await tx
      .insert(containerComputeStopIntents)
      .values({
        organization_id: p.organizationId,
        container_id: p.containerId,
        lifecycle_revision: container.lifecycle_revision,
        authorization: "billing_request",
      })
      .returning();
    if (!intent) throw new Error("Container stop intent insert returned no row");

    const [created] = await tx
      .insert(jobs)
      .values({
        type: JOB_TYPES.CONTAINER_STOP,
        status: "pending",
        organization_id: p.organizationId,
        user_id: p.userId ?? null,
        data: {
          containerId: p.containerId,
          organizationId: p.organizationId,
          intentId: intent.id,
          lifecycleRevision: intent.lifecycle_revision,
        },
      })
      .returning({ id: jobs.id });
    if (!created) throw new Error("Container stop job insert returned no row");
    await tx
      .update(containerComputeStopIntents)
      .set({ job_id: created.id, updated_at: new Date() })
      .where(eq(containerComputeStopIntents.id, intent.id));
    return { requested: true, id: created.id, created: true };
  });
}

/** Independently scans stop recovery state, including terminal provider failures. */
export async function listRecoverableContainerStopIntents(now: Date, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];

  type RecoveryCursor = { nextAttemptAtText: string; id: string };
  type RecoveryCandidate = {
    intent: typeof containerComputeStopIntents.$inferSelect;
    cursorNextAttemptAtText: string;
    boundJob: {
      id: string | null;
      type: string | null;
      organizationId: string | null;
      status: string | null;
      dataStorage: string | null;
      data: Record<string, unknown> | null;
      createdAt: Date | null;
      databaseNow: Date | null;
    } | null;
  };
  const recoverable: Array<typeof containerComputeStopIntents.$inferSelect> = [];
  const pageSize = Math.max(100, Math.min(limit, 500));
  let cursor: RecoveryCursor | null = null;

  while (recoverable.length < limit) {
    const page: RecoveryCandidate[] = await dbWrite
      .select({
        intent: { ...getTableColumns(containerComputeStopIntents) },
        cursorNextAttemptAtText: sql<string>`${containerComputeStopIntents.next_attempt_at}::text`,
        boundJob: {
          id: jobs.id,
          type: jobs.type,
          organizationId: jobs.organization_id,
          status: jobs.status,
          dataStorage: jobs.data_storage,
          data: jobs.data,
          createdAt: jobs.created_at,
          databaseNow: sql<Date>`clock_timestamp()`,
        },
      })
      .from(containerComputeStopIntents)
      .innerJoin(
        containers,
        and(
          eq(containers.id, containerComputeStopIntents.container_id),
          eq(containers.organization_id, containerComputeStopIntents.organization_id),
          eq(containers.lifecycle_revision, containerComputeStopIntents.lifecycle_revision),
        ),
      )
      .leftJoin(jobs, eq(jobs.id, containerComputeStopIntents.job_id))
      .where(
        and(
          lte(containerComputeStopIntents.next_attempt_at, now),
          cursor
            ? sql`(${containerComputeStopIntents.next_attempt_at}, ${containerComputeStopIntents.id}) >
                (${cursor.nextAttemptAtText}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
          or(
            and(
              eq(containers.status, "running"),
              inArray(containerComputeStopIntents.status, [
                "pending",
                "retry",
                "terminal_attention",
              ]),
              or(
                // Explicit user authority remains valid without a billing schedule.
                eq(containerComputeStopIntents.authorization, "user_request"),
                and(
                  eq(containerComputeStopIntents.authorization, "billing_request"),
                  or(
                    // Provider-confirmed retries must settle even after ordinary
                    // billing discovery has been fenced off.
                    isNotNull(containerComputeStopIntents.provider_confirmed_at),
                    and(
                      eq(containers.billing_status, "shutdown_pending"),
                      isNotNull(containers.scheduled_shutdown_at),
                      lte(containers.scheduled_shutdown_at, now),
                    ),
                  ),
                ),
              ),
            ),
            // Provider settlement is already terminal; this path only retries
            // the idempotent node-slot release after the bound job dies.
            and(
              eq(containers.status, "stopped"),
              eq(containerComputeStopIntents.status, "provider_confirmed"),
              isNotNull(containerComputeStopIntents.provider_confirmed_at),
              isNotNull(containerComputeStopIntents.provider_node_id),
              isNull(containerComputeStopIntents.slot_released_at),
            ),
          ),
          // Live work is independently recoverable by the provisioning worker.
          // Invalid failed envelopes are excluded before LIMIT; payloads are
          // decoded below without SQL casts and cursor pagination skips poison
          // rows without starving a later valid recovery intent.
          or(
            isNull(containerComputeStopIntents.job_id),
            isNull(jobs.id),
            and(
              eq(jobs.status, "failed"),
              eq(jobs.type, JOB_TYPES.CONTAINER_STOP),
              eq(jobs.organization_id, containerComputeStopIntents.organization_id),
              eq(jobs.data_storage, "inline"),
              isNull(jobs.data_key),
            ),
          ),
        ),
      )
      .orderBy(
        asc(containerComputeStopIntents.next_attempt_at),
        asc(containerComputeStopIntents.id),
      )
      .limit(pageSize);

    if (page.length === 0) break;
    for (const candidate of page) {
      const { intent, boundJob } = candidate;
      let safelyRearmable = true;
      if (intent.job_id && boundJob?.id) {
        try {
          assertExactContainerStopJobData(
            boundJob,
            {
              containerId: intent.container_id,
              organizationId: intent.organization_id,
              intentId: intent.id,
              lifecycleRevision: intent.lifecycle_revision,
            },
            "Container stop recovery job payload does not match its durable intent",
          );
          const createdAt = requireProviderAdmissionTimestamp(
            boundJob.createdAt,
            "job creation time",
          );
          const databaseNow = requireProviderAdmissionTimestamp(
            boundJob.databaseNow,
            "database time",
          );
          readProviderEffectStartedAt(boundJob.data, { createdAt, databaseNow });
          safelyRearmable = true;
        } catch {
          // error-policy:J3 untrusted-input sanitizing — malformed persisted job
          // envelopes are excluded explicitly and never treated as recoverable.
          safelyRearmable = false;
        }
      }
      if (safelyRearmable) recoverable.push(intent);
      if (recoverable.length >= limit) break;
    }

    const last: RecoveryCandidate | undefined = page.at(-1);
    if (!last || page.length < pageSize) break;
    cursor = { nextAttemptAtText: last.cursorNextAttemptAtText, id: last.intent.id };
  }
  return recoverable;
}
