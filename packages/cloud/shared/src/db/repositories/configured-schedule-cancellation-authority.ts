/** Resolves configured-schedule lifecycle authority from immutable command/source history. */
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import type { ConfiguredCancellationAuthority } from "../../lib/services/configured-schedule-cancellation";
import {
  organizationScheduleEffectRequestSchema,
  scheduleEffectRequestDigest,
} from "../../lib/services/organization-schedule-effect-contract";
import { organizationScheduleQuoteTermsSchema } from "../../lib/services/organization-schedule-quote-terms";
import { proveOriginalConfiguredAuthority } from "../../lib/services/organization-schedule-target-authority";
import { settlementDigest } from "../../lib/services/settlement-digest";
import { cancellationReobserve } from "../../lib/services/stripe-period-end-cancellation";
import type { DbTransaction } from "../client";
import {
  type BillingSubscription,
  billingSubscriptionRevisions,
} from "../schemas/billing-subscriptions";
import { organizationScheduleEffects } from "../schemas/organization-schedule-effects";
import { organizationScheduleQuoteTerms } from "../schemas/organization-schedule-quote-terms";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";
import { readOriginalScheduledRenewalAuthority } from "./organization-schedule-renewal-authority";
import { readLatestSubscriptionScheduleCommand } from "./subscription-schedule-lineage";

export async function readConfiguredCancellationAuthority(
  tx: DbTransaction,
  source: BillingSubscription,
): Promise<ConfiguredCancellationAuthority | null> {
  if (source.current_period_end === null) {
    if (source.pending_plan_key !== null)
      cancellationReobserve("configured_cancellation_period_missing");
    return null;
  }
  let pending = source;
  if (source.pending_plan_key === null) {
    const candidates = await tx
      .select({ command: commands, prior: billingSubscriptionRevisions })
      .from(commands)
      .innerJoin(
        billingSubscriptionRevisions,
        and(
          eq(billingSubscriptionRevisions.subscription_id, commands.subscription_id),
          eq(billingSubscriptionRevisions.organization_id, commands.organization_id),
          eq(billingSubscriptionRevisions.revision, commands.expected_subscription_revision),
        ),
      )
      .where(
        and(
          eq(commands.organization_id, source.organization_id),
          eq(commands.subscription_id, source.id),
          eq(commands.kind, "cancel"),
          eq(commands.status, "APPLIED"),
          isNull(commands.billing_scope_id),
          isNull(commands.app_id),
          isNotNull(billingSubscriptionRevisions.pending_plan_key),
          eq(billingSubscriptionRevisions.current_period_end, source.current_period_end),
        ),
      )
      .orderBy(desc(commands.result_subscription_revision))
      .limit(2);
    if (!candidates.length) return null;
    if (candidates.length !== 1) cancellationReobserve("ambiguous_configured_cancellation");
    const root = candidates[0]!;
    let latest = await readLatestSubscriptionScheduleCommand(tx, source);
    const seen = new Set<string>();
    while (latest && latest.id !== root.command.id) {
      if (seen.has(latest.id) || !latest.schedule_predecessor_command_id)
        cancellationReobserve("configured_cancellation_lineage_changed");
      seen.add(latest.id);
      const [previous] = await tx
        .select()
        .from(commands)
        .where(
          and(
            eq(commands.id, latest.schedule_predecessor_command_id),
            eq(commands.organization_id, source.organization_id),
            eq(commands.subscription_id, source.id),
            eq(commands.status, "APPLIED"),
            isNull(commands.billing_scope_id),
            isNull(commands.app_id),
          ),
        );
      if (
        !previous ||
        (previous.kind !== "cancel" && previous.kind !== "resume") ||
        previous.result_subscription_revision === null ||
        latest.expected_subscription_revision === null ||
        previous.result_subscription_revision > latest.expected_subscription_revision
      )
        cancellationReobserve("configured_cancellation_lineage_changed");
      latest = previous;
    }
    if (!latest || latest.id !== root.command.id)
      cancellationReobserve("configured_cancellation_lineage_changed");
    pending = { ...source, ...root.prior, id: source.id, lifecycle_revision: root.prior.revision };
    if (
      pending.plan_key !== source.plan_key ||
      pending.stripe_customer_id !== source.stripe_customer_id ||
      pending.stripe_subscription_id !== source.stripe_subscription_id ||
      pending.stripe_subscription_item_id !== source.stripe_subscription_item_id ||
      pending.current_period_start?.getTime() !== source.current_period_start?.getTime() ||
      pending.catalog_version !== source.catalog_version ||
      pending.provider !== source.provider ||
      pending.provider_environment !== source.provider_environment
    )
      cancellationReobserve("configured_cancellation_source_changed");
  }
  const context = await readOriginalScheduledRenewalAuthority(pending, tx);
  if (!context) cancellationReobserve("original_configured_cancellation_missing");
  proveOriginalConfiguredAuthority({ ...context, source: context.configuredSource });
  const proof = context.command.organization_schedule_configuration_evidence!;
  const [effect] = await tx
    .select()
    .from(organizationScheduleEffects)
    .where(
      and(
        eq(organizationScheduleEffects.id, proof.configurationEffectId),
        eq(organizationScheduleEffects.command_id, context.command.id),
        eq(organizationScheduleEffects.organization_id, source.organization_id),
      ),
    );
  const [terms] = await tx
    .select()
    .from(organizationScheduleQuoteTerms)
    .where(
      and(
        eq(organizationScheduleQuoteTerms.quote_id, context.quoteId),
        eq(organizationScheduleQuoteTerms.organization_id, source.organization_id),
      ),
    );
  if (
    !effect ||
    !terms ||
    effect.state !== "observed" ||
    effect.receipt_digest !== proof.configurationReceiptDigest ||
    effect.request_digest !== proof.requestDigest ||
    settlementDigest(terms.snapshot) !== terms.snapshot_digest ||
    terms.snapshot_digest !== proof.retainedTermsDigest
  )
    cancellationReobserve("configured_cancellation_retained_evidence_missing");
  const request = organizationScheduleEffectRequestSchema.parse(effect.request_payload);
  if (
    request.kind !== "schedule_configure" ||
    scheduleEffectRequestDigest(request) !== proof.requestDigest ||
    request.scheduleId !== context.scheduleId
  )
    cancellationReobserve("configured_cancellation_request_changed");
  const originalSnapshot = z
    .record(z.string(), z.unknown())
    .parse(context.command.organization_schedule_configuration_snapshot);
  const originalTerms = organizationScheduleQuoteTermsSchema.parse(terms.snapshot);
  return {
    scheduleId: context.scheduleId,
    originalSnapshot,
    originalTerms,
    originalRequest: request,
    originalPending: source.pending_plan_key !== null,
    authorityDigest: settlementDigest({
      commandId: context.command.id,
      proof,
      originalTerms,
      request,
    }),
  };
}
