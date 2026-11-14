/**
 * Funding-stop retention for agents (#22967, owner decision in #22957).
 *
 * When funding stops, an agent's container state is kept for 30 days at no
 * charge. This matches the Dedicated fallback retention (#32856). The clock
 * starts from one of two existing authorities; nothing here stops a runtime:
 *   - credits exhausted: the provider-confirmed `billing_request` stop that is
 *     still the agent's latest lifecycle decision (`agent-billing-resume.ts`);
 *   - Plus/Pro plan lapsed past grace: the open `personal_dedicated_fallbacks`
 *     interval and its `retain_until` deadline.
 *
 * Deletion notices go out through the existing email service 7 days and 1 day
 * before the deadline. A deadline is never reached without the 1-day notice:
 * clocks discovered late (for example agents already stopped when this shipped)
 * get at least 7 days. At the deadline the container is removed through the
 * existing sleep lifecycle, which proves a durable backup before it frees
 * compute, and the latest backup is pinned for 90 more days (v2 catalog rows
 * via `retention_reason = 'billing-freeze'`; legacy rows have no time-based GC).
 *
 * Paying before the deadline resumes the same agent through the existing paths
 * (#30702 automatic resume, #32856 plan recovery). This reconciler only closes
 * a credits clock once the agent is running again or its lifecycle moved on,
 * and a plan clock once its fallback interval leaves the withdrawn states.
 */

import { ElizaError } from "@elizaos/core";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { dbWrite } from "../../db/client";
import { listConfirmedBillingSuspensions } from "../../db/repositories/agent-billing-resume";
import { agentComputeStopIntents } from "../../db/schemas/agent-compute-stop-intents";
import {
  type AgentFundingRetention,
  type AgentFundingRetentionClosedReason,
  agentFundingRetentions,
} from "../../db/schemas/agent-funding-retentions";
import { agentSandboxBackups, agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { jobs } from "../../db/schemas/jobs";
import { organizations } from "../../db/schemas/organizations";
import { personalDedicatedFallbacks } from "../../db/schemas/personal-dedicated-fallbacks";
import { users } from "../../db/schemas/users";
import { logger } from "../utils/logger";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Container state is retained this long after funding stops. */
export const AGENT_FUNDING_RETENTION_DAYS = 30;
/** The latest backup is kept this long after the container is deleted. */
export const AGENT_FUNDING_BACKUP_RETENTION_DAYS = 90;
/** Deletion notices, in days before the deadline. */
export const AGENT_FUNDING_RETENTION_NOTICE_DAYS = [7, 1] as const;

const DISCOVERY_PAGE_SIZE = 200;
const OPEN_STATES = ["retained", "container_deletion_pending"] as const;
const PLAN_WITHDRAWN_STATES = ["fallback_pending", "shared_active"] as const;
const PLAN_REASONS = ["subscription_payment_failed", "subscription_ended"] as const;

export interface AgentRetentionNotice {
  retentionId: string;
  email: string;
  organizationName: string;
  agentName: string;
  reason: AgentFundingRetention["reason"];
  daysRemaining: 7 | 1;
  suspendedAt: Date;
  deleteAfter: Date;
  backupRetainUntil: Date;
}

export interface AgentFundingRetentionDependencies {
  now: () => Date;
  /** Sends one deletion notice. Resolves false or throws when it was not sent. */
  sendNotice: (notice: AgentRetentionNotice) => Promise<boolean>;
  /** Enqueues the existing sleep lifecycle job (backup proof, then container removal). */
  enqueueSleep: (input: {
    agentId: string;
    organizationId: string;
    userId: string;
    expectedLifecycleRevision: number;
  }) => Promise<{ jobId: string }>;
}

export interface AgentFundingRetentionRunSummary {
  discovered: number;
  closed: number;
  noticesSent: number;
  containerDeletionsQueued: number;
  containersDeleted: number;
  /** Clocks that reached the deadline but need an operator (for example an unbacked runtime). */
  blocked: Array<{ retentionId: string; agentId: string; reason: string }>;
  failures: Array<{ retentionId: string; agentId: string; error: string }>;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function laterOf(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultSendNotice(notice: AgentRetentionNotice): Promise<boolean> {
  const { emailService } = await import("./email");
  const { getCloudAwareEnv } = await import("../runtime/cloud-bindings");
  const appUrl = getCloudAwareEnv().NEXT_PUBLIC_APP_URL || "https://cloud.eliza.app";
  const format = (date: Date) =>
    date.toLocaleString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short",
    });
  return emailService.sendAgentRetentionDeletionNoticeEmail({
    email: notice.email,
    organizationName: notice.organizationName,
    agentName: notice.agentName,
    reason: notice.reason,
    daysRemaining: notice.daysRemaining,
    suspendedAt: format(notice.suspendedAt),
    deleteAfter: format(notice.deleteAfter),
    backupRetainUntil: format(notice.backupRetainUntil),
    billingUrl: `${appUrl}/cloud/billing`,
    dashboardUrl: `${appUrl}/cloud`,
  });
}

async function defaultEnqueueSleep(input: {
  agentId: string;
  organizationId: string;
  userId: string;
}): Promise<{ jobId: string }> {
  const { provisioningJobService } = await import("./provisioning-job-queue");
  const { job } = await provisioningJobService.enqueueAgentSleepOnce(input);
  return { jobId: job.id };
}

export class AgentFundingRetentionService {
  private readonly deps: AgentFundingRetentionDependencies;

  constructor(deps: Partial<AgentFundingRetentionDependencies> = {}) {
    this.deps = {
      now: deps.now ?? (() => new Date()),
      sendNotice: deps.sendNotice ?? defaultSendNotice,
      enqueueSleep: deps.enqueueSleep ?? defaultEnqueueSleep,
    };
  }

  /** One full pass: discover new clocks, close restored ones, notify, expire. */
  async reconcile(): Promise<AgentFundingRetentionRunSummary> {
    const now = this.deps.now();
    const summary: AgentFundingRetentionRunSummary = {
      discovered: 0,
      closed: 0,
      noticesSent: 0,
      containerDeletionsQueued: 0,
      containersDeleted: 0,
      blocked: [],
      failures: [],
    };
    summary.discovered += await this.discoverCreditStops(now);
    summary.discovered += await this.discoverPlanLapses(now);

    const open = await dbWrite
      .select()
      .from(agentFundingRetentions)
      .where(inArray(agentFundingRetentions.state, [...OPEN_STATES]))
      .orderBy(agentFundingRetentions.delete_after, agentFundingRetentions.id);
    for (const row of open) {
      try {
        await this.advance(row, now, summary);
      } catch (error) {
        const message = errorMessage(error);
        summary.failures.push({ retentionId: row.id, agentId: row.agent_id, error: message });
        logger.error("[AgentFundingRetention] Failed to advance retention clock", {
          retentionId: row.id,
          agentId: row.agent_id,
          organizationId: row.organization_id,
          error: message,
        });
        await dbWrite
          .update(agentFundingRetentions)
          .set({ last_error: message.slice(0, 1000), updated_at: now })
          .where(eq(agentFundingRetentions.id, row.id));
      }
    }
    return summary;
  }

  private async discoverCreditStops(now: Date): Promise<number> {
    let discovered = 0;
    let cursor: string | undefined;
    for (;;) {
      const page = await listConfirmedBillingSuspensions({
        limit: DISCOVERY_PAGE_SIZE,
        afterIntentId: cursor,
      });
      for (const stop of page) {
        const inserted = await dbWrite
          .insert(agentFundingRetentions)
          .values({
            organization_id: stop.organizationId,
            agent_id: stop.agentId,
            user_id: stop.userId,
            reason: "credits_exhausted",
            stop_intent_id: stop.intentId,
            suspended_at: stop.providerConfirmedAt,
            delete_after: this.initialDeadline(
              addDays(stop.providerConfirmedAt, AGENT_FUNDING_RETENTION_DAYS),
              stop.providerConfirmedAt,
              now,
            ),
            created_at: now,
            updated_at: now,
          })
          .onConflictDoNothing()
          .returning({ id: agentFundingRetentions.id });
        discovered += inserted.length;
      }
      if (page.length < DISCOVERY_PAGE_SIZE) return discovered;
      cursor = page[page.length - 1]?.intentId;
    }
  }

  private async discoverPlanLapses(now: Date): Promise<number> {
    const lapses = await dbWrite
      .select({
        fallbackId: personalDedicatedFallbacks.id,
        organizationId: personalDedicatedFallbacks.organization_id,
        agentId: personalDedicatedFallbacks.dedicated_agent_id,
        userId: agentSandboxes.user_id,
        activatedAt: personalDedicatedFallbacks.activated_at,
        retainUntil: personalDedicatedFallbacks.retain_until,
      })
      .from(personalDedicatedFallbacks)
      .innerJoin(
        agentSandboxes,
        and(
          eq(agentSandboxes.id, personalDedicatedFallbacks.dedicated_agent_id),
          eq(agentSandboxes.organization_id, personalDedicatedFallbacks.organization_id),
        ),
      )
      .leftJoin(
        agentFundingRetentions,
        eq(agentFundingRetentions.fallback_id, personalDedicatedFallbacks.id),
      )
      .where(
        and(
          inArray(personalDedicatedFallbacks.state, [...PLAN_WITHDRAWN_STATES]),
          inArray(personalDedicatedFallbacks.reason, [...PLAN_REASONS]),
          sql`${personalDedicatedFallbacks.retain_until} IS NOT NULL`,
          isNull(agentFundingRetentions.id),
        ),
      );
    let discovered = 0;
    for (const lapse of lapses) {
      if (!lapse.retainUntil) continue;
      const inserted = await dbWrite
        .insert(agentFundingRetentions)
        .values({
          organization_id: lapse.organizationId,
          agent_id: lapse.agentId,
          user_id: lapse.userId,
          reason: "subscription_lapsed",
          fallback_id: lapse.fallbackId,
          suspended_at: lapse.activatedAt,
          delete_after: this.initialDeadline(lapse.retainUntil, lapse.activatedAt, now),
          created_at: now,
          updated_at: now,
        })
        .onConflictDoNothing()
        .returning({ id: agentFundingRetentions.id });
      discovered += inserted.length;
    }
    return discovered;
  }

  /**
   * The deadline is 30 days after the stop, but never less than one full
   * notice window after the clock is first observed, so every customer gets
   * the 7-day and 1-day notices before anything is deleted.
   */
  private initialDeadline(policyDeadline: Date, suspendedAt: Date, now: Date): Date {
    const noticeFloor = addDays(now, AGENT_FUNDING_RETENTION_NOTICE_DAYS[0]);
    const deadline = laterOf(policyDeadline, noticeFloor);
    return deadline.getTime() > suspendedAt.getTime() ? deadline : addDays(suspendedAt, 1);
  }

  private async advance(
    row: AgentFundingRetention,
    now: Date,
    summary: AgentFundingRetentionRunSummary,
  ): Promise<void> {
    const [agent] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, row.agent_id),
          eq(agentSandboxes.organization_id, row.organization_id),
        ),
      )
      .limit(1);

    const closeReason = await this.closeReason(row, agent);
    if (closeReason) {
      const closed = await dbWrite
        .update(agentFundingRetentions)
        .set({
          state: "closed",
          closed_at: now,
          closed_reason: closeReason,
          last_error: null,
          updated_at: now,
        })
        .where(
          and(eq(agentFundingRetentions.id, row.id), eq(agentFundingRetentions.state, row.state)),
        )
        .returning({ id: agentFundingRetentions.id });
      summary.closed += closed.length;
      return;
    }
    if (!agent) return;

    if (
      agent.status === "sleeping" &&
      (row.state === "container_deletion_pending" || now >= row.delete_after)
    ) {
      // The container is gone and a durable backup exists: pin it.
      await this.markContainerDeleted(row, now);
      summary.containersDeleted += 1;
      return;
    }

    if (row.state === "container_deletion_pending") {
      // The sleep job may have failed; the enqueue is idempotent while a job
      // is active and admits a fresh attempt otherwise.
      if (agent.status === "stopped" && agent.lifecycle_job_id === null) {
        const { jobId } = await this.deps.enqueueSleep({
          agentId: row.agent_id,
          organizationId: row.organization_id,
          userId: row.user_id,
          expectedLifecycleRevision: agent.lifecycle_revision,
        });
        if (jobId !== row.sleep_job_id) {
          await dbWrite
            .update(agentFundingRetentions)
            .set({ sleep_job_id: jobId, updated_at: now })
            .where(eq(agentFundingRetentions.id, row.id));
        }
      }
      return;
    }

    // state === "retained"
    if (now < row.delete_after) {
      summary.noticesSent += await this.sendDueNotice(row, agent, now);
      return;
    }

    if (!row.notice_7d_sent_at) {
      summary.noticesSent += (await this.sendNoticeNow(row, agent, now, 7, "notice_7d_sent_at"))
        ? 1
        : 0;
      return;
    }

    if (!row.notice_1d_sent_at) {
      // Never delete without the final notice: send it and move the deadline.
      const sent = await this.sendNoticeNow(row, agent, now, 1, "notice_1d_sent_at");
      if (sent) {
        summary.noticesSent += 1;
      }
      return;
    }

    // Even a late final notice must give the owner a full day to act.
    if (now.getTime() < row.notice_1d_sent_at.getTime() + DAY_MS) return;

    if (agent.retained_runtime) {
      // The stopped container holds writes no backup covers (#30746). Removing
      // it would destroy state without the backup the policy promises.
      const reason = "Unbacked retained runtime needs an operator before deletion";
      summary.blocked.push({ retentionId: row.id, agentId: row.agent_id, reason });
      await dbWrite
        .update(agentFundingRetentions)
        .set({ last_error: reason, updated_at: now })
        .where(eq(agentFundingRetentions.id, row.id));
      logger.error("[AgentFundingRetention] Deletion blocked on an unbacked runtime", {
        retentionId: row.id,
        agentId: row.agent_id,
        organizationId: row.organization_id,
      });
      return;
    }
    if (agent.status !== "stopped" || agent.lifecycle_job_id !== null) return;
    if (await this.hasActiveResume(row)) return;

    const { jobId } = await this.deps.enqueueSleep({
      agentId: row.agent_id,
      organizationId: row.organization_id,
      userId: row.user_id,
      expectedLifecycleRevision: agent.lifecycle_revision,
    });
    const queued = await dbWrite
      .update(agentFundingRetentions)
      .set({
        state: "container_deletion_pending",
        sleep_job_id: jobId,
        last_error: null,
        updated_at: now,
      })
      .where(
        and(eq(agentFundingRetentions.id, row.id), eq(agentFundingRetentions.state, "retained")),
      )
      .returning({ id: agentFundingRetentions.id });
    summary.containerDeletionsQueued += queued.length;
    logger.info("[AgentFundingRetention] Retention expired; container deletion queued", {
      retentionId: row.id,
      agentId: row.agent_id,
      organizationId: row.organization_id,
      sleepJobId: jobId,
    });
  }

  private async closeReason(
    row: AgentFundingRetention,
    agent: typeof agentSandboxes.$inferSelect | undefined,
  ): Promise<AgentFundingRetentionClosedReason | null> {
    if (
      !agent ||
      agent.deleted_at ||
      agent.deletion_attempt_id ||
      agent.status === "deletion_pending" ||
      agent.status === "deletion_failed"
    ) {
      return "agent_changed";
    }
    if (row.reason === "subscription_lapsed" && row.fallback_id) {
      const [fallback] = await dbWrite
        .select({ state: personalDedicatedFallbacks.state })
        .from(personalDedicatedFallbacks)
        .where(eq(personalDedicatedFallbacks.id, row.fallback_id))
        .limit(1);
      if (!fallback || !(PLAN_WITHDRAWN_STATES as readonly string[]).includes(fallback.state)) {
        return "funding_restored";
      }
      // The plan is still withdrawn. Activation commits `shared_active` while
      // the suspend is only enqueued (and a lifecycle conflict leaves it
      // `fallback_pending`), so a live runtime here is still on its way down,
      // not a resumed one. Only the fallback leaving these states restores the
      // plan; a closed clock is never rediscovered for the same fallback.
      return null;
    }
    if (row.reason === "credits_exhausted" && row.stop_intent_id) {
      const [stop] = await dbWrite
        .select({ createdAt: agentComputeStopIntents.created_at })
        .from(agentComputeStopIntents)
        .where(eq(agentComputeStopIntents.id, row.stop_intent_id))
        .limit(1);
      if (!stop) return "agent_changed";
      const [later] = await dbWrite
        .select({ id: agentComputeStopIntents.id })
        .from(agentComputeStopIntents)
        .where(
          and(
            eq(agentComputeStopIntents.organization_id, row.organization_id),
            eq(agentComputeStopIntents.agent_id, row.agent_id),
            gt(agentComputeStopIntents.created_at, stop.createdAt),
          ),
        )
        .limit(1);
      if (later) return "agent_changed";
    }
    if (agent.status === "stopped" || agent.status === "sleeping") return null;
    // Transitional lifecycle states keep the clock until they settle.
    if (agent.status === "provisioning" || agent.status === "pending") {
      return row.state === "retained" ? "funding_restored" : null;
    }
    return "funding_restored";
  }

  private async hasActiveResume(row: AgentFundingRetention): Promise<boolean> {
    const [active] = await dbWrite
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.organization_id, row.organization_id),
          eq(jobs.agent_id, row.agent_id),
          inArray(jobs.type, ["agent_resume", "agent_wake"]),
          inArray(jobs.status, ["pending", "in_progress"]),
        ),
      )
      .limit(1);
    return active !== undefined;
  }

  private async sendDueNotice(
    row: AgentFundingRetention,
    agent: typeof agentSandboxes.$inferSelect,
    now: Date,
  ): Promise<number> {
    const [first, last] = AGENT_FUNDING_RETENTION_NOTICE_DAYS;
    if (
      !row.notice_7d_sent_at &&
      !row.notice_1d_sent_at &&
      now >= addDays(row.delete_after, -first)
    ) {
      return (await this.sendNoticeNow(row, agent, now, first, "notice_7d_sent_at")) ? 1 : 0;
    }
    if (!row.notice_1d_sent_at && now >= addDays(row.delete_after, -last)) {
      return (await this.sendNoticeNow(row, agent, now, last, "notice_1d_sent_at")) ? 1 : 0;
    }
    return 0;
  }

  /**
   * Serialize notice delivery for this retention row. A sent timestamp is a
   * receipt, never a pre-send claim: a failed send or worker crash rolls the
   * transaction back and cannot authorize deletion without notice. A crash
   * after provider acceptance can resend a notice, which is safer than losing it.
   */
  private async sendNoticeNow(
    row: AgentFundingRetention,
    agent: typeof agentSandboxes.$inferSelect,
    now: Date,
    daysRemaining: 7 | 1,
    column: "notice_7d_sent_at" | "notice_1d_sent_at",
  ): Promise<boolean> {
    const recipient = await this.recipient(row);
    if (!recipient) {
      throw new ElizaError("No billing recipient for the deletion notice", {
        code: "AGENT_RETENTION_NOTICE_RECIPIENT_MISSING",
        context: { retentionId: row.id, organizationId: row.organization_id },
      });
    }
    return dbWrite.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(agentFundingRetentions)
        .where(eq(agentFundingRetentions.id, row.id))
        .limit(1)
        .for("update");
      if (!current || current.state !== "retained" || current[column]) return false;
      const deleteAfter = laterOf(current.delete_after, addDays(now, daysRemaining));
      const sent = await this.deps.sendNotice({
        retentionId: current.id,
        email: recipient.email,
        organizationName: recipient.organizationName,
        agentName: agent.agent_name ?? "your agent",
        reason: current.reason,
        daysRemaining,
        suspendedAt: current.suspended_at,
        deleteAfter,
        backupRetainUntil: addDays(deleteAfter, AGENT_FUNDING_BACKUP_RETENTION_DAYS),
      });
      if (!sent)
        throw new ElizaError("Deletion notice was not accepted by the email provider", {
          code: "AGENT_RETENTION_NOTICE_FAILED",
          context: { retentionId: current.id },
        });
      await tx
        .update(agentFundingRetentions)
        .set({ [column]: now, delete_after: deleteAfter, last_error: null, updated_at: now })
        .where(eq(agentFundingRetentions.id, current.id));
      return true;
    });
  }

  private async recipient(
    row: AgentFundingRetention,
  ): Promise<{ email: string; organizationName: string } | null> {
    const [organization] = await dbWrite
      .select({ name: organizations.name, billingEmail: organizations.billing_email })
      .from(organizations)
      .where(eq(organizations.id, row.organization_id))
      .limit(1);
    if (!organization) return null;
    if (organization.billingEmail) {
      return { email: organization.billingEmail, organizationName: organization.name };
    }
    const [owner] = await dbWrite
      .select({ email: users.email })
      .from(users)
      .where(or(eq(users.id, row.user_id), eq(users.organization_id, row.organization_id)))
      .orderBy(sql`${users.id} = ${row.user_id} DESC`, users.created_at)
      .limit(1);
    return owner?.email ? { email: owner.email, organizationName: organization.name } : null;
  }

  /**
   * The container is removed; pin the newest durable v2 backup for 90 more
   * days. Legacy inline backups have no time-based GC, so they already outlive
   * the promise; the row still records which backup is kept and until when.
   */
  private async markContainerDeleted(row: AgentFundingRetention, now: Date): Promise<void> {
    const retainUntil = addDays(now, AGENT_FUNDING_BACKUP_RETENTION_DAYS);
    await dbWrite.transaction(async (tx) => {
      const [v2] = await tx
        .select({ id: agentSandboxBackups.id })
        .from(agentSandboxBackups)
        .where(
          and(
            eq(agentSandboxBackups.sandbox_record_id, row.agent_id),
            eq(agentSandboxBackups.catalog_version, 2),
            inArray(agentSandboxBackups.catalog_state, [
              "protected",
              "retained",
              "restore_verified",
            ]),
          ),
        )
        .orderBy(desc(agentSandboxBackups.created_at), desc(agentSandboxBackups.id))
        .limit(1)
        .for("update");
      let backupId = v2?.id ?? null;
      if (v2) {
        await tx
          .update(agentSandboxBackups)
          .set({
            retention_reason: sql`CASE WHEN ${agentSandboxBackups.retention_reason} = 'legal-hold'
              THEN ${agentSandboxBackups.retention_reason} ELSE 'billing-freeze' END`,
            retention_until: sql`GREATEST(COALESCE(${agentSandboxBackups.retention_until}, ${retainUntil}), ${retainUntil})`,
          })
          .where(eq(agentSandboxBackups.id, v2.id));
      } else {
        const [legacy] = await tx
          .select({ id: agentSandboxBackups.id })
          .from(agentSandboxBackups)
          .where(
            and(
              eq(agentSandboxBackups.sandbox_record_id, row.agent_id),
              or(
                isNull(agentSandboxBackups.catalog_state),
                eq(agentSandboxBackups.catalog_state, "legacy_unmigrated"),
              ),
            ),
          )
          .orderBy(desc(agentSandboxBackups.created_at), desc(agentSandboxBackups.id))
          .limit(1);
        backupId = legacy?.id ?? null;
      }
      if (!backupId) {
        throw new ElizaError("Container removed but no durable backup row was found", {
          code: "AGENT_RETENTION_BACKUP_MISSING",
          context: {
            retentionId: row.id,
            agentId: row.agent_id,
            organizationId: row.organization_id,
          },
        });
      }
      await tx
        .update(agentFundingRetentions)
        .set({
          state: "container_deleted",
          container_deleted_at: now,
          retained_backup_id: backupId,
          backup_retain_until: retainUntil,
          last_error: backupId ? null : "No backup row found after container removal",
          updated_at: now,
        })
        .where(
          and(
            eq(agentFundingRetentions.id, row.id),
            inArray(agentFundingRetentions.state, [...OPEN_STATES]),
          ),
        );
    });
    logger.info("[AgentFundingRetention] Container deleted; latest backup pinned", {
      retentionId: row.id,
      agentId: row.agent_id,
      organizationId: row.organization_id,
      backupRetainUntil: retainUntil.toISOString(),
    });
  }
}

export const agentFundingRetentionService = new AgentFundingRetentionService();
