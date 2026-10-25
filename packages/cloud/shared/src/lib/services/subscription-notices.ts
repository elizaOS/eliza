/** Sweeps durable cancellation notices under the existing cron owner and fences submission against current source and approved policy. */
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite, writeTransaction } from "../../db/helpers";
import { readPostLockDatabaseNow } from "../../db/repositories/primary-database-clock";
import {
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../../db/schemas/billing-subscriptions";
import { organizations } from "../../db/schemas/organizations";
import {
  subscriptionNoticeAttempts as attempts,
  subscriptionNoticeIntents as intents,
} from "../../db/schemas/subscription-notices";
import { type EmailDispatchResult, EmailService } from "./email";
import { resolveSubscriptionNoticePolicy } from "./subscription-notice-policy";

async function lockCurrent(
  tx: DbTransaction,
  notice: typeof intents.$inferSelect,
): Promise<boolean> {
  const [org] = await tx
    .select({
      state: organizations.account_lifecycle_state,
      active: organizations.is_active,
      fencedAt: organizations.paid_work_fenced_at,
    })
    .from(organizations)
    .where(eq(organizations.id, notice.organization_id))
    .for("update");
  const [account] = await tx
    .select()
    .from(organizationSubscriptionAuthorities)
    .where(eq(organizationSubscriptionAuthorities.organization_id, notice.organization_id))
    .for("update");
  const [source] = await tx
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.id, notice.subscription_id),
        eq(billingSubscriptions.organization_id, notice.organization_id),
      ),
    )
    .for("update");
  return (
    org?.state === "active" &&
    org.active &&
    org.fencedAt === null &&
    account?.state === "current" &&
    account.subscription_id === notice.subscription_id &&
    source?.status === "canceled" &&
    source.lifecycle_revision === notice.source_revision
  );
}
async function complete(
  tx: DbTransaction,
  noticeId: string,
  attemptId: string,
  status: string,
  result: { provider?: string; messageId?: string | null; reason?: string } = {},
): Promise<void> {
  await tx
    .update(attempts)
    .set({
      status,
      provider: result.provider ?? null,
      message_id: result.messageId ?? null,
      reason: result.reason ?? null,
      completed_at: sql`clock_timestamp()`,
    })
    .where(and(eq(attempts.id, attemptId), eq(attempts.status, "dispatching")));
  await tx
    .update(intents)
    .set({ state: status, updated_at: sql`clock_timestamp()` })
    .where(and(eq(intents.id, noticeId), eq(intents.state, "dispatching")));
}
export async function claimSubscriptionNotice(
  id: string,
  leaseDurationMs = 60_000,
): Promise<{ noticeId: string; attemptId: string } | null> {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1 || leaseDurationMs > 60_000)
    throw new ElizaError("Notice lease duration is invalid", {
      code: "SUBSCRIPTION_NOTICE_LEASE_INVALID",
    });
  const [observed] = await dbWrite.select().from(intents).where(eq(intents.id, id));
  if (!observed) return null;
  return await writeTransaction(async (tx) => {
    const current = await lockCurrent(tx, observed);
    const [notice] = await tx.select().from(intents).where(eq(intents.id, id)).for("update");
    if (!notice || !["policy_unavailable", "scheduled", "dispatching"].includes(notice.state))
      return null;
    const now = await readPostLockDatabaseNow(tx);
    await tx.update(intents).set({ last_inspected_at: now }).where(eq(intents.id, id));
    if (notice.state === "dispatching") {
      const [attempt] = await tx
        .select()
        .from(attempts)
        .where(eq(attempts.notice_id, id))
        .for("update");
      if (attempt && attempt.expires_at <= now)
        await complete(tx, id, attempt.id, "uncertain", {
          reason: "submission_outcome_unrecorded",
        });
      return null;
    }
    const policy = resolveSubscriptionNoticePolicy(notice);
    if (!current || (policy.state === "configured" && new Date(policy.value.notAfter) <= now)) {
      await tx
        .update(intents)
        .set({ state: "superseded", updated_at: now })
        .where(eq(intents.id, id));
      return null;
    }
    if (policy.state === "unavailable" || new Date(policy.value.sendAt) > now) {
      const state = policy.state === "unavailable" ? "policy_unavailable" : "scheduled";
      if (notice.state !== state)
        await tx.update(intents).set({ state, updated_at: now }).where(eq(intents.id, id));
      return null;
    }
    // A prior submission may have reached the recipient. Explicit revision policy
    // alone cannot authorize another delivery or resolve an uncertain predecessor.
    const [priorAttempt] = await tx
      .select({ id: attempts.id })
      .from(attempts)
      .innerJoin(intents, eq(intents.id, attempts.notice_id))
      .where(
        and(
          eq(intents.subscription_id, notice.subscription_id),
          ne(intents.id, id),
          ne(attempts.status, "superseded"),
        ),
      )
      .limit(1);
    if (priorAttempt) {
      await tx
        .update(intents)
        .set({ state: "reconciliation_required", updated_at: now })
        .where(eq(intents.id, id));
      return null;
    }
    const [attempt] = await tx
      .insert(attempts)
      .values({
        notice_id: id,
        organization_id: notice.organization_id,
        policy_digest: policy.digest,
        started_at: now,
        expires_at: new Date(now.getTime() + leaseDurationMs),
      })
      .returning();
    if (!attempt)
      throw new ElizaError("Notice attempt insert returned no row", {
        code: "SUBSCRIPTION_NOTICE_ATTEMPT_UNAVAILABLE",
      });
    await tx
      .update(intents)
      .set({ state: "dispatching", updated_at: now })
      .where(eq(intents.id, id));
    return { noticeId: id, attemptId: attempt.id };
  });
}
export async function dispatchSubscriptionNotice(claim: {
  noticeId: string;
  attemptId: string;
}): Promise<void> {
  const id = claim.noticeId;
  const [observed] = await dbWrite.select().from(intents).where(eq(intents.id, id));
  if (!observed) return;
  // The dispatching marker is already committed. A crash from here never licenses a resend.
  await writeTransaction(async (tx) => {
    const current = await lockCurrent(tx, observed);
    const [notice] = await tx.select().from(intents).where(eq(intents.id, id)).for("update");
    const [attempt] = await tx
      .select()
      .from(attempts)
      .where(and(eq(attempts.id, claim.attemptId), eq(attempts.notice_id, id)))
      .for("update");
    if (!notice || !attempt || notice.state !== "dispatching" || attempt.status !== "dispatching")
      return;
    const now = await readPostLockDatabaseNow(tx);
    const checkedAt = performance.now();
    const policy = resolveSubscriptionNoticePolicy(notice);
    if (
      !current ||
      policy.state !== "configured" ||
      policy.digest !== attempt.policy_digest ||
      new Date(policy.value.notAfter) <= now
    ) {
      await complete(tx, id, attempt.id, "superseded", { reason: "source_or_policy_changed" });
      return;
    }
    if (attempt.expires_at <= now) {
      await complete(tx, id, attempt.id, "uncertain", { reason: "submission_outcome_unrecorded" });
      return;
    }
    const submissionWindowMs = Math.floor(
      Math.min(
        10_000,
        attempt.expires_at.getTime() - now.getTime(),
        new Date(policy.value.notAfter).getTime() - now.getTime(),
      ) -
        (performance.now() - checkedAt),
    );
    if (submissionWindowMs <= 0) {
      await complete(tx, id, attempt.id, "uncertain", { reason: "submission_outcome_unrecorded" });
      return;
    }
    // Hold the lifecycle fence through socket closure. Acceptance still does not prove delivery.
    const result: EmailDispatchResult = await new EmailService().dispatchBounded(
      {
        to: policy.value.recipient,
        subject: policy.value.subject,
        text: policy.value.text,
        html: policy.value.html,
      },
      submissionWindowMs,
    );
    await complete(tx, id, attempt.id, result.status, result);
  });
}
export async function processSubscriptionNotice(id: string): Promise<boolean> {
  const claim = await claimSubscriptionNotice(id);
  if (claim) await dispatchSubscriptionNotice(claim);
  return claim !== null;
}
export async function sweepSubscriptionNotices(): Promise<{
  inspected: number;
  policyUnavailable: number;
}> {
  const pending = await dbWrite
    .select()
    .from(intents)
    .where(inArray(intents.state, ["policy_unavailable", "scheduled", "dispatching"]))
    .orderBy(
      sql`${intents.last_inspected_at} ASC NULLS FIRST`,
      asc(intents.created_at),
      asc(intents.id),
    )
    .limit(10);
  let inspected = 0,
    policyUnavailable = 0;
  for (const notice of pending) {
    const policy = resolveSubscriptionNoticePolicy(notice);
    if (policy.state === "unavailable") policyUnavailable += 1;
    const attempted = await processSubscriptionNotice(notice.id);
    inspected += 1;
    // Inspection consumes no submission budget; unavailable and future rows rotate fairly.
    if (attempted) break;
  }
  return { inspected, policyUnavailable };
}
