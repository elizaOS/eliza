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

import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { settleComputeRateSegments } from "../../db/repositories/compute-billing-segments";
import { containersRepository } from "../../db/repositories/containers";
import { containerComputeStopIntents } from "../../db/schemas/compute-stop-intents";
import { containers } from "../../db/schemas/containers";
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

/**
 * Daemon: stop + remove the live container for a claimed CONTAINER_STOP job.
 * Preserves the volume (`purgeVolume: false`) and decrements the node's
 * allocated count (HetznerContainersClient.stopContainer does both). A
 * container whose row is already `stopped`/gone is treated as already-stopped
 * (idempotent) — the same `container_not_found` short-circuit the delete path
 * tolerates — so a re-claim after the row was finalized cannot fail the job.
 */
export async function dispatchContainerStopJob(job: {
  id?: string;
  organization_id?: string;
  data: unknown;
}): Promise<ContainerStopOutcome> {
  const { containerId, organizationId, intentId, lifecycleRevision } =
    readContainerStopJobData(job);
  if (job.organization_id !== undefined && job.organization_id !== organizationId) {
    throw new Error("CONTAINER_STOP job tenant envelope mismatch");
  }
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
    if (organization.pay_as_you_go_from_earnings) {
      const [sourceUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.organization_id, organizationId))
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

    // Intent is always the final lock in the billing order. A lifecycle writer
    // that owns workload+organization can supersede it without deadlocking a
    // simultaneous stop claim.
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
    if (
      !container ||
      container.lifecycle_revision !== lifecycleRevision ||
      container.status !== "running" ||
      container.billing_status !== "shutdown_pending"
    ) {
      const supersededAt = new Date();
      await tx
        .update(containerComputeStopIntents)
        .set({ status: "superseded", superseded_at: supersededAt, updated_at: supersededAt })
        .where(eq(containerComputeStopIntents.id, intentId));
      return { outcome: { stopped: false, reason: "stale-lifecycle-generation" } };
    }

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
        .where(and(eq(containers.id, containerId), eq(containers.organization_id, organizationId)));
      return { outcome: { stopped: false, reason: "funding-restored" } };
    }

    const attempt = intent.attempts + 1;
    const startedAt = new Date();
    await tx
      .update(containerComputeStopIntents)
      .set({
        status: "dispatching",
        attempts: attempt,
        provider_started_at: startedAt,
        last_error: null,
        updated_at: startedAt,
      })
      .where(eq(containerComputeStopIntents.id, intentId));

    try {
      const provider = await getHetznerContainersClient().stopContainerRuntimeForBilling(
        containerId,
        organizationId,
        lifecycleRevision,
      );
      const confirmedAt = new Date();
      await tx
        .update(containers)
        .set({ status: "stopped", billing_status: "suspended", updated_at: confirmedAt })
        .where(and(eq(containers.id, containerId), eq(containers.organization_id, organizationId)));
      await tx
        .update(containerComputeStopIntents)
        .set({
          status: "provider_confirmed",
          provider_confirmed_at: confirmedAt,
          provider_node_id: provider.nodeId,
          updated_at: confirmedAt,
        })
        .where(eq(containerComputeStopIntents.id, intentId));
      return { outcome: { stopped: true }, releaseNodeId: provider.nodeId };
    } catch (error) {
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
      return { outcome: { stopped: false }, error: new Error(message) };
    }
  });
  if (dispatch.error) {
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
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`container-stop:${p.organizationId}:${p.containerId}`}))`,
    );
    const [container] = await tx
      .select({
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
      container.billing_status !== "shutdown_pending" ||
      !container.scheduled_shutdown_at ||
      container.scheduled_shutdown_at > now
    ) {
      throw new Error("Container is not eligible for a billing stop intent");
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
    if (existingIntent?.job_id) {
      return { requested: true, id: existingIntent.job_id, created: false };
    }

    const [intent] = existingIntent
      ? [existingIntent]
      : await tx
          .insert(containerComputeStopIntents)
          .values({
            organization_id: p.organizationId,
            container_id: p.containerId,
            lifecycle_revision: container.lifecycle_revision,
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
  return await dbWrite
    .select()
    .from(containerComputeStopIntents)
    .where(
      and(
        inArray(containerComputeStopIntents.status, ["pending", "retry", "terminal_attention"]),
        lte(containerComputeStopIntents.next_attempt_at, now),
      ),
    )
    .limit(limit);
}
