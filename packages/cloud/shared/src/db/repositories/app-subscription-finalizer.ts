/**
 * Applies a freshly retrieved provider observation to the existing subscription journal,
 * entitlement projection, noncash grant ledger, receipts and delivery outbox atomically.
 * Scope locks and the post-lock database clock fence stale observations and expired grants.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { deriveAppBillingPolicy } from "../../lib/services/generic-billing-policy";
import type {
  BillingProviderEvent,
  BillingProviderInvoice,
  BillingProviderObservation,
  BillingProviderSubscription,
} from "../../lib/services/generic-billing-provider-types";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import {
  appBillingPlanRevisions,
  appBillingScopes,
  appSubscriptionOutbox,
  appSubscriptionPaidPeriods,
  appSubscriptionTrials,
} from "../schemas/app-billing";
import { billingSubscriptions } from "../schemas/billing-subscriptions";
import { organizationEntitlements } from "../schemas/organization-entitlements";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";
import { subscriptionAllowanceTransactions } from "../schemas/subscription-allowance-transactions";
import {
  billingSubscriptionCommands,
  billingSubscriptionEventReceipts,
} from "../schemas/subscription-billing-operations";
import {
  type AppBillingDeletionRecoveryAuthority,
  requireAppBillingDeletionRecovery,
} from "./app-billing-deletion-authority";
import {
  appBillingConflict,
  lockAppBillingScope,
  requireAppBillingAdministrator,
  type ScopedBillingContext,
} from "./app-subscription-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";
import {
  type SubscriptionRevisionValues,
  subscriptionAuthorityRepository,
} from "./subscription-authority";

export interface ApplyAppSubscriptionObservation {
  scopeId: string;
  planRevisionId: string;
  expectedSubscriptionRevision: number | null;
  subscription: BillingProviderObservation<BillingProviderSubscription>;
  invoice: BillingProviderObservation<BillingProviderInvoice> | null;
  command: {
    id: string;
    stateRevision: number;
    executionGeneration: number;
    leaseToken: string | null;
    deletionAuthority?: AppBillingDeletionRecoveryAuthority;
  } | null;
  event: BillingProviderEvent | null;
  eventReceipt?: { id: string; leaseToken: string };
  /** Original triggering invoice evidence is separate from the current invoice used for policy. */
  eventInvoice?: BillingProviderObservation<BillingProviderInvoice>;
  /** Completes an existing intent after another worker advanced lifecycle; current observation CAS remains mandatory. */
  commandReconciliation?: true;
  scopeReconciliationLease?: { token: string };
}

function requireObservation<T>(
  scope: ScopedBillingContext,
  observation: BillingProviderObservation<T>,
): void {
  if (
    observation.merchantId !== scope.merchantId ||
    observation.livemode !== scope.livemode ||
    observation.apiVersion !== "2024-11-20.acacia" ||
    (scope.merchantKey !== "platform" && observation.providerAccountId !== scope.merchantKey) ||
    !/^[0-9a-f]{64}$/.test(observation.digest) ||
    !/^[0-9a-f]{64}$/.test(observation.inputDigest) ||
    !Number.isFinite(Date.parse(observation.observedAt))
  )
    appBillingConflict("Provider observation belongs to another merchant, environment or request");
}

function providerDate(seconds: number): Date;
function providerDate(seconds: number | null): Date | null;
function providerDate(seconds: number | null): Date | null {
  if (seconds === null) return null;
  if (!Number.isSafeInteger(seconds) || seconds <= 0)
    appBillingConflict("Provider date is invalid");
  return new Date(seconds * 1000);
}

async function persistGrant(
  tx: DbTransaction,
  input: {
    scope: ScopedBillingContext;
    subscriptionId: string;
    revision: number;
    planKey: string;
    planRevisionId: string;
    digest: string;
    now: Date;
    grant: NonNullable<ReturnType<typeof deriveAppBillingPolicy>["grant"]>;
  },
) {
  const { scope, grant } = input;
  const [existing] = await tx
    .select()
    .from(subscriptionAllowancePeriods)
    .where(
      and(
        eq(subscriptionAllowancePeriods.billing_scope_id, scope.scopeId),
        grant.source === "trial_claim"
          ? eq(subscriptionAllowancePeriods.trial_claim_id, grant.trialClaimId!)
          : eq(subscriptionAllowancePeriods.stripe_invoice_id, grant.invoiceId!),
      ),
    )
    .for("update");
  if (existing) {
    if (
      existing.subscription_id !== input.subscriptionId ||
      existing.grant_source !== grant.source ||
      existing.granted_amount !== grant.amountUsd ||
      existing.period_start.getTime() !== grant.periodStart.getTime() ||
      existing.period_end.getTime() !== grant.periodEnd.getTime()
    )
      appBillingConflict("Allowance source replay changes the original grant");
    return existing;
  }
  const [period] = await tx
    .insert(subscriptionAllowancePeriods)
    .values({
      organization_id: scope.organizationId,
      billing_scope_id: scope.scopeId,
      merchant_key: scope.merchantKey,
      subscription_id: input.subscriptionId,
      subscription_revision: input.revision,
      provider: "stripe",
      provider_environment: scope.livemode ? "live" : "test",
      stripe_invoice_id: grant.invoiceId,
      grant_source: grant.source,
      trial_claim_id: grant.trialClaimId,
      plan_key: input.planKey,
      catalog_version: input.planRevisionId,
      period_start: grant.periodStart,
      period_end: grant.periodEnd,
      expires_at: grant.periodEnd,
      granted_amount: grant.amountUsd,
      available_amount: grant.amountUsd,
    })
    .returning();
  if (!period) appBillingConflict("Allowance grant persistence returned no period");
  await tx.insert(subscriptionAllowanceTransactions).values({
    organization_id: scope.organizationId,
    billing_scope_id: scope.scopeId,
    merchant_key: scope.merchantKey,
    allowance_period_id: period.id,
    trial_claim_id: grant.trialClaimId,
    sequence: 1,
    kind: "grant",
    amount: grant.amountUsd,
    available_before: "0.000000",
    available_after: grant.amountUsd,
    reserved_before: "0.000000",
    reserved_after: "0.000000",
    settled_before: "0.000000",
    settled_after: "0.000000",
    expired_before: "0.000000",
    expired_after: "0.000000",
    clawed_back_before: "0.000000",
    clawed_back_after: "0.000000",
    idempotency_key: `app-grant:${grant.source}:${grant.trialClaimId ?? grant.invoiceId}`,
    request_digest: input.digest,
    occurred_at: input.now,
  });
  return period;
}

export class AppSubscriptionFinalizer {
  async applyObservation(input: ApplyAppSubscriptionObservation, transaction?: DbTransaction) {
    const apply = async (tx: DbTransaction) => {
      const scope = await lockAppBillingScope(tx, input.scopeId, true);
      let scopeLeaseExpiresAt: Date | null = null;
      if (input.scopeReconciliationLease) {
        const [lease] = await tx
          .select()
          .from(appBillingScopes)
          .where(eq(appBillingScopes.id, scope.scopeId));
        const leaseNow = await readPostLockDatabaseNow(tx);
        if (
          !lease ||
          lease.reconcile_lease_token !== input.scopeReconciliationLease.token ||
          !lease.reconcile_lease_expires_at ||
          lease.reconcile_lease_expires_at <= leaseNow
        )
          appBillingConflict("Periodic reconciliation lost its current scope lease");
        scopeLeaseExpiresAt = lease.reconcile_lease_expires_at;
        // These writes commit only with the lifecycle transaction; failures retain a recoverable lease.
        await tx
          .update(appBillingScopes)
          .set({
            reconcile_lease_token: null,
            reconcile_lease_expires_at: null,
            reconcile_after: new Date(leaseNow.getTime() + 300_000),
            reconcile_error_code: null,
          })
          .where(eq(appBillingScopes.id, scope.scopeId));
      }
      requireObservation(scope, input.subscription);
      if (input.invoice) requireObservation(scope, input.invoice);
      if (input.eventInvoice) requireObservation(scope, input.eventInvoice);
      const observed = input.subscription.value;
      if (scope.stripeCustomerId === null || observed.customerId !== scope.stripeCustomerId)
        appBillingConflict("Subscription does not belong to the immutable app customer binding");
      const [current] = await tx
        .select()
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.billing_scope_id, scope.scopeId),
            eq(billingSubscriptions.stripe_subscription_id, observed.subscriptionId),
          ),
        )
        .for("update");
      let eventReceipt: typeof billingSubscriptionEventReceipts.$inferSelect | undefined;
      if (input.eventReceipt && !input.event)
        appBillingConflict("Event receipt requires its normalized provider event");
      if (input.event) {
        const event = input.event;
        if (
          (input.eventInvoice &&
            (input.eventInvoice.value.subscriptionId !== observed.subscriptionId ||
              input.eventInvoice.value.customerId !== observed.customerId)) ||
          event.merchantId !== scope.merchantId ||
          event.livemode !== scope.livemode ||
          event.providerAccountId !== input.subscription.providerAccountId ||
          event.apiVersion !== input.subscription.apiVersion ||
          (event.objectType !== "subscription" && event.objectType !== "invoice") ||
          (event.objectType === "subscription"
            ? event.objectId !== observed.subscriptionId
            : event.objectId !== (input.eventInvoice ?? input.invoice)?.value.invoiceId)
        )
          appBillingConflict("Provider event belongs to another subscription scope");
        const [receipt] = await tx
          .select()
          .from(billingSubscriptionEventReceipts)
          .where(
            and(
              eq(billingSubscriptionEventReceipts.merchant_key, scope.merchantKey),
              eq(billingSubscriptionEventReceipts.livemode, scope.livemode),
              eq(billingSubscriptionEventReceipts.provider_event_id, event.eventId),
            ),
          )
          .for("update");
        if (receipt) {
          if (
            receipt.billing_scope_id !== scope.scopeId ||
            receipt.organization_id !== scope.organizationId ||
            receipt.subscription_id !== current?.id ||
            receipt.event_type !== event.eventType ||
            receipt.provider_object_type !== event.objectType ||
            receipt.provider_object_id !== event.objectId ||
            receipt.payload_digest !== event.payloadDigest ||
            receipt.event_created_at.getTime() !== event.createdAt * 1000
          )
            appBillingConflict("Provider event replay changes immutable receipt identity");
          if (receipt.status === "applied") {
            const [entitlement] = await tx
              .select()
              .from(organizationEntitlements)
              .where(eq(organizationEntitlements.billing_scope_id, scope.scopeId));
            if (!entitlement?.source_subscription_id)
              appBillingConflict("Applied event has no current entitlement authority");
            const [projectedSubscription] = await tx
              .select()
              .from(billingSubscriptions)
              .where(
                and(
                  eq(billingSubscriptions.id, entitlement.source_subscription_id),
                  eq(billingSubscriptions.billing_scope_id, scope.scopeId),
                ),
              );
            if (
              !projectedSubscription ||
              entitlement.source_subscription_revision !== projectedSubscription.lifecycle_revision
            )
              appBillingConflict("Applied event current projection revision is inconsistent");
            return {
              subscription: projectedSubscription,
              entitlement,
              allowance: null,
              outbox: null,
              databaseNow: await readPostLockDatabaseNow(tx),
              replayed: true,
            };
          }
          if (
            !input.eventReceipt ||
            input.eventReceipt.id !== receipt.id ||
            receipt.status !== "processing" ||
            receipt.lease_token !== input.eventReceipt.leaseToken ||
            !receipt.lease_expires_at
          )
            appBillingConflict("Provider event requires its current processing lease");
          eventReceipt = receipt;
        } else if (input.eventReceipt)
          appBillingConflict("Claimed provider event receipt is unavailable");
      }
      if (current) {
        const [projectionSource] = await tx
          .select({ subscriptionId: organizationEntitlements.source_subscription_id })
          .from(organizationEntitlements)
          .where(eq(organizationEntitlements.billing_scope_id, scope.scopeId));
        if (projectionSource && projectionSource.subscriptionId !== current.id)
          appBillingConflict("Historical subscription cannot replace a newer scope authority");
      }
      if ((current?.lifecycle_revision ?? null) !== input.expectedSubscriptionRevision)
        appBillingConflict("Provider observation source revision is stale");
      if (!current) {
        const [live] = await tx
          .select({ id: billingSubscriptions.id })
          .from(billingSubscriptions)
          .where(
            and(
              eq(billingSubscriptions.billing_scope_id, scope.scopeId),
              inArray(billingSubscriptions.status, [
                "pending",
                "incomplete",
                "trialing",
                "active",
                "grace",
                "past_due",
                "unpaid",
                "paused",
              ]),
            ),
          );
        if (live || !input.command)
          appBillingConflict(
            "New subscription requires its original durable command and an empty scope",
          );
      }
      const [plan] = await tx
        .select()
        .from(appBillingPlanRevisions)
        .where(
          and(
            eq(appBillingPlanRevisions.id, input.planRevisionId),
            eq(appBillingPlanRevisions.app_id, scope.appId),
            eq(appBillingPlanRevisions.merchant_id, scope.merchantId),
            eq(appBillingPlanRevisions.product_family_key, scope.productFamilyKey),
          ),
        );
      if (!plan || !plan.published_at)
        appBillingConflict("Observed plan does not belong to this scope");
      const [command] = input.command
        ? await tx
            .select()
            .from(billingSubscriptionCommands)
            .where(
              and(
                eq(billingSubscriptionCommands.id, input.command.id),
                eq(billingSubscriptionCommands.billing_scope_id, scope.scopeId),
              ),
            )
            .for("update")
        : [];
      const imported =
        command?.kind === "import" && command.request_payload?.domain === "operator"
          ? command.request_payload
          : null;
      if (
        imported &&
        (!imported.manifest.provider ||
          imported.manifestDigest !== command?.request_digest ||
          imported.manifest.scopeId !== scope.scopeId ||
          imported.manifest.planRevisionId !== plan.id ||
          imported.manifest.quantity !== observed.quantity ||
          imported.manifest.provider.customerId !== observed.customerId ||
          imported.manifest.provider.subscriptionId !== observed.subscriptionId ||
          imported.manifest.provider.invoiceId !== observed.latestInvoiceId)
      )
        appBillingConflict("Import observation changes the reviewed provider identity or catalog");
      if (imported && (!input.command?.leaseToken || !command?.lease_expires_at))
        appBillingConflict("Historical import requires its live execution lease");
      if (input.command) {
        if (observed.pendingUpdate)
          appBillingConflict("Pending provider updates cannot complete a billing command");
        if (
          !command ||
          !["OUTCOME_UNKNOWN", "SUCCEEDED"].includes(command.status) ||
          command.state_revision !== input.command.stateRevision ||
          command.execution_generation !== input.command.executionGeneration ||
          command.lease_token !== input.command.leaseToken ||
          (command.expected_subscription_revision !== input.expectedSubscriptionRevision &&
            !(
              input.commandReconciliation &&
              current &&
              command.expected_subscription_revision !== null &&
              command.expected_subscription_revision <= current.lifecycle_revision
            )) ||
          (!imported && command.request_digest !== input.subscription.inputDigest) ||
          (command.subscription_id !== null && command.subscription_id !== current?.id)
        )
          appBillingConflict("Provider result lost its durable command execution fence");
        if (input.command.deletionAuthority)
          await requireAppBillingDeletionRecovery(tx, input.command.deletionAuthority, command);
        else await requireAppBillingAdministrator(tx, scope, command.requested_by_user_id);
        if (
          !input.command.deletionAuthority &&
          command.kind !== "cancel" &&
          command.kind !== "import" &&
          scope.fenced
        )
          appBillingConflict("App sales authority was revoked before finalization");
        if (
          command.target_plan_revision_id !== null &&
          !observed.pendingUpdate &&
          (command.target_plan_revision_id !== plan.id ||
            command.target_quantity !== observed.quantity)
        )
          appBillingConflict("Provider result changes the authorized plan or quantity");
      }
      const [claim] = await tx
        .select()
        .from(appSubscriptionTrials)
        .where(eq(appSubscriptionTrials.billing_scope_id, scope.scopeId));
      const [claimPlan] = claim
        ? await tx
            .select()
            .from(appBillingPlanRevisions)
            .where(eq(appBillingPlanRevisions.id, claim.plan_revision_id))
        : [];
      if (
        !current &&
        !imported &&
        observed.status === "trialing" &&
        claim?.command_id !== command?.id
      )
        appBillingConflict("New provider trial does not match its original claim command");
      if (claim && !claimPlan) appBillingConflict("Trial claim lost its original plan revision");
      const [paid] = current
        ? await tx
            .select()
            .from(appSubscriptionPaidPeriods)
            .where(
              and(
                eq(appSubscriptionPaidPeriods.billing_scope_id, scope.scopeId),
                eq(appSubscriptionPaidPeriods.subscription_id, current.id),
              ),
            )
            .orderBy(desc(appSubscriptionPaidPeriods.created_at))
            .limit(1)
        : [];
      const now = await readPostLockDatabaseNow(tx);
      if (scopeLeaseExpiresAt && scopeLeaseExpiresAt <= now)
        appBillingConflict("Periodic scope lease expired before finalization");
      if (eventReceipt?.lease_expires_at && eventReceipt.lease_expires_at <= now)
        appBillingConflict("Provider event lease expired before finalization");
      if (command?.lease_expires_at && command.lease_expires_at <= now)
        appBillingConflict("Provider execution lease expired before finalization");
      const decision = deriveAppBillingPolicy({
        plan,
        subscription: observed,
        invoice: input.invoice?.value ?? null,
        trial:
          claim && claimPlan
            ? {
                id: claim.id,
                starts_at: claim.starts_at,
                ends_at: claim.ends_at,
                allowanceUsd: claimPlan.trial_allowance_usd,
              }
            : null,
        paidPeriod: paid
          ? {
              subscriptionId: observed.subscriptionId,
              planRevisionId: paid.plan_revision_id,
              priceId: paid.stripe_price_id,
              quantity: paid.quantity,
              periodStart: paid.period_start,
              periodEnd: paid.period_end,
            }
          : null,
        databaseNow: now,
      });
      if (input.commandReconciliation) {
        if (
          !command ||
          !current ||
          !command.lease_token ||
          !command.lease_expires_at ||
          observed.pendingUpdate
        )
          appBillingConflict(
            "Reconciled command requires an existing subscription and fulfilled provider state",
          );
        const cancelComplete =
          command.kind === "cancel" &&
          command.request_payload?.domain === "buyer" &&
          command.request_payload.action === "cancel" &&
          (observed.status === "canceled" ||
            (command.request_payload.timing === "period_end" && observed.cancelAtPeriodEnd));
        const resumeComplete =
          command.kind === "resume" &&
          !observed.cancelAtPeriodEnd &&
          observed.status !== "canceled" &&
          decision.entitlementEffective;
        const targetComplete =
          ["upgrade", "downgrade", "checkout"].includes(command.kind) &&
          command.target_plan_revision_id === plan.id &&
          command.target_quantity === observed.quantity &&
          decision.entitlementEffective &&
          (observed.status === "trialing"
            ? claim?.command_id === command.id ||
              current.trial_end?.getTime() === claim?.ends_at.getTime()
            : observed.status === "active" &&
              (decision.qualifyingPaidPeriod !== null ||
                (paid?.plan_revision_id === plan.id &&
                  paid.quantity === observed.quantity &&
                  paid.period_start.getTime() === observed.currentPeriodStart * 1000 &&
                  paid.period_end.getTime() === observed.currentPeriodEnd * 1000)));
        if (!cancelComplete && !resumeComplete && !targetComplete)
          appBillingConflict(
            "Current provider state does not fulfill the original authorized command",
          );
      }
      if (scope.fenced) {
        decision.entitlementEffective = false;
        decision.access = "denied";
        decision.features = [];
        decision.grant = null;
        decision.rateLimits = { completionsRpm: 0, embeddingsRpm: 0, standardRpm: 0, strictRpm: 0 };
      }
      const values: SubscriptionRevisionValues = {
        billing_scope_id: scope.scopeId,
        merchant_key: scope.merchantKey,
        plan_revision_id: plan.id,
        quantity: observed.quantity,
        provider: "stripe",
        provider_environment: scope.livemode ? "live" : "test",
        stripe_customer_id: observed.customerId,
        stripe_subscription_id: observed.subscriptionId,
        stripe_subscription_item_id: observed.itemId,
        catalog_version: plan.id,
        plan_key: plan.plan_key,
        status: observed.status,
        current_period_start: providerDate(observed.currentPeriodStart),
        current_period_end: providerDate(observed.currentPeriodEnd),
        trial_start: providerDate(observed.trialStart),
        trial_end: providerDate(observed.trialEnd),
        cancel_at_period_end: observed.cancelAtPeriodEnd,
        canceled_at: providerDate(observed.canceledAt),
        ended_at: providerDate(observed.endedAt),
        dunning_started_at:
          observed.status === "past_due" ? (current?.dunning_started_at ?? now) : null,
        grace_expires_at: null,
        pending_plan_key: observed.pendingUpdate
          ? (command?.target_plan_key ?? current?.pending_plan_key ?? null)
          : null,
        last_provider_event_id: input.event?.eventId ?? null,
        last_provider_event_created_at: input.event ? providerDate(input.event.createdAt) : null,
        provider_object_digest: input.subscription.digest,
      };
      const [previousProjection] = await tx
        .select()
        .from(organizationEntitlements)
        .where(eq(organizationEntitlements.billing_scope_id, scope.scopeId))
        .for("update");
      if (
        !input.command &&
        !input.event &&
        current &&
        previousProjection &&
        current.provider_object_digest === input.subscription.digest &&
        current.plan_revision_id === plan.id &&
        previousProjection.source_subscription_revision === current.lifecycle_revision &&
        previousProjection.state === decision.state &&
        previousProjection.access === decision.access &&
        previousProjection.entitlement_effective === decision.entitlementEffective &&
        previousProjection.quantity === decision.quantity &&
        previousProjection.effective_from.getTime() === decision.effectiveFrom.getTime() &&
        previousProjection.effective_until?.getTime() === decision.effectiveUntil.getTime() &&
        JSON.stringify(previousProjection.features) === JSON.stringify(decision.features)
      ) {
        return {
          subscription: current,
          entitlement: previousProjection,
          allowance: null,
          outbox: null,
          databaseNow: now,
          replayed: true,
        };
      }
      const mutation = current
        ? await subscriptionAuthorityRepository.advance(
            {
              organizationId: scope.organizationId,
              subscriptionId: current.id,
              expectedRevision: current.lifecycle_revision,
              source: input.event ? "webhook" : "reconciliation",
              observation: "authoritative_provider_retrieval",
              values,
              forceRevision: true,
            },
            tx,
          )
        : await subscriptionAuthorityRepository.create(
            { ...values, organization_id: scope.organizationId },
            imported ? "backfill" : "checkout",
            null,
            tx,
          );
      const subscription = mutation.subscription;
      const projection = {
        organization_id: scope.organizationId,
        billing_scope_id: scope.scopeId,
        plan_key: plan.plan_key,
        state: decision.state,
        entitlement_effective: decision.entitlementEffective,
        access: decision.access,
        features: decision.features,
        quantity: decision.quantity,
        effective_from: decision.effectiveFrom,
        effective_until: decision.effectiveUntil,
        completions_rpm: decision.rateLimits.completionsRpm,
        embeddings_rpm: decision.rateLimits.embeddingsRpm,
        standard_rpm: decision.rateLimits.standardRpm,
        strict_rpm: decision.rateLimits.strictRpm,
        catalog_version: plan.id,
        projection_revision: (previousProjection?.projection_revision ?? 0) + 1,
        source_digest: input.subscription.digest,
        source_subscription_id: subscription.id,
        source_subscription_revision: subscription.lifecycle_revision,
        updated_at: now,
        rebuilt_at: now,
      };
      const [entitlement] = previousProjection
        ? await tx
            .update(organizationEntitlements)
            .set(projection)
            .where(eq(organizationEntitlements.id, previousProjection.id))
            .returning()
        : await tx.insert(organizationEntitlements).values(projection).returning();
      if (!entitlement) appBillingConflict("App entitlement projection returned no record");
      const proof = decision.qualifyingPaidPeriod;
      if (proof) {
        await tx
          .insert(appSubscriptionPaidPeriods)
          .values({
            billing_scope_id: scope.scopeId,
            subscription_id: subscription.id,
            plan_revision_id: proof.planRevisionId,
            merchant_key: scope.merchantKey,
            livemode: scope.livemode,
            stripe_invoice_id: proof.invoiceId,
            stripe_price_id: proof.priceId,
            quantity: proof.quantity,
            period_start: proof.periodStart,
            period_end: proof.periodEnd,
            provider_digest: input.invoice!.digest,
          })
          .onConflictDoNothing();
        const [storedProof] = await tx
          .select()
          .from(appSubscriptionPaidPeriods)
          .where(
            and(
              eq(appSubscriptionPaidPeriods.merchant_key, scope.merchantKey),
              eq(appSubscriptionPaidPeriods.livemode, scope.livemode),
              eq(appSubscriptionPaidPeriods.stripe_invoice_id, proof.invoiceId),
            ),
          );
        if (
          !storedProof ||
          storedProof.billing_scope_id !== scope.scopeId ||
          storedProof.subscription_id !== subscription.id ||
          storedProof.plan_revision_id !== proof.planRevisionId ||
          storedProof.stripe_price_id !== proof.priceId ||
          storedProof.quantity !== proof.quantity ||
          storedProof.period_start.getTime() !== proof.periodStart.getTime() ||
          storedProof.period_end.getTime() !== proof.periodEnd.getTime()
        )
          appBillingConflict("Settled paid period replay changes its original scope or plan");
      }
      const allowance = decision.grant
        ? await persistGrant(tx, {
            scope,
            subscriptionId: subscription.id,
            revision: subscription.lifecycle_revision,
            planKey: decision.grant.source === "trial_claim" ? claimPlan!.plan_key : plan.plan_key,
            planRevisionId: decision.grant.source === "trial_claim" ? claimPlan!.id : plan.id,
            digest: input.subscription.digest,
            now,
            grant: decision.grant,
          })
        : null;
      if (command)
        await tx
          .update(billingSubscriptionCommands)
          .set({
            status: "APPLIED",
            state_revision: command.state_revision + 1,
            provider_response_digest: input.subscription.digest,
            result_subscription_id: subscription.id,
            completed_at: now,
            applied_at: now,
            error_code: null,
            lease_token: null,
            lease_expires_at: null,
            updated_at: now,
          })
          .where(eq(billingSubscriptionCommands.id, command.id));
      if (eventReceipt)
        await tx
          .update(billingSubscriptionEventReceipts)
          .set({
            status: "applied",
            lease_token: null,
            lease_expires_at: null,
            applied_subscription_revision: subscription.lifecycle_revision,
            disposition: "app_subscription_observed",
            processed_at: now,
            updated_at: now,
            error_code: null,
          })
          .where(eq(billingSubscriptionEventReceipts.id, eventReceipt.id));
      else if (input.event)
        await tx.insert(billingSubscriptionEventReceipts).values({
          organization_id: scope.organizationId,
          billing_scope_id: scope.scopeId,
          merchant_key: scope.merchantKey,
          subscription_id: subscription.id,
          provider_event_id: input.event.eventId,
          event_type: input.event.eventType,
          provider_object_type: input.event.objectType === "invoice" ? "invoice" : "subscription",
          provider_object_id: input.event.objectId,
          livemode: scope.livemode,
          event_created_at: providerDate(input.event.createdAt)!,
          payload_digest: input.event.payloadDigest,
          status: "applied",
          applied_subscription_revision: subscription.lifecycle_revision,
          disposition: "app_subscription_observed",
          processed_at: now,
          updated_at: now,
        });
      const [outbox] = await tx
        .insert(appSubscriptionOutbox)
        .values({
          billing_scope_id: scope.scopeId,
          subscription_id: subscription.id,
          subscription_revision: subscription.lifecycle_revision,
          kind: "app.subscription.updated",
        })
        .returning();
      if (!outbox) appBillingConflict("App subscription outbox returned no record");
      return { subscription, entitlement, allowance, outbox, databaseNow: now, replayed: false };
    };
    return transaction ? apply(transaction) : writeTransaction(apply);
  }
}
export const appSubscriptionFinalizer = new AppSubscriptionFinalizer();
