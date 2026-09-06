/**
 * Reconciles verified lookup triggers and missed events through the existing subscription
 * receipts, command journal and atomic finalizer. Provider state is retrieved only after
 * acquiring its current lease; a losing worker never refreshes CAS around an old response.
 */
import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { dbWrite, writeTransaction } from "../../db/helpers";
import { appBillingProviderBindings } from "../../db/repositories/app-billing-provider-bindings";
import {
  appBillingConflict,
  lockAppBillingScope,
} from "../../db/repositories/app-subscription-authority";
import { appSubscriptionFinalizer } from "../../db/repositories/app-subscription-finalizer";
import { readPostLockDatabaseNow } from "../../db/repositories/primary-database-clock";
import { subscriptionBillingOperationsRepository } from "../../db/repositories/subscription-billing-operations";
import { appBillingPlanRevisions, appBillingScopes } from "../../db/schemas/app-billing";
import { billingSubscriptions } from "../../db/schemas/billing-subscriptions";
import { organizationEntitlements } from "../../db/schemas/organization-entitlements";
import {
  billingSubscriptionCommands,
  billingSubscriptionEventReceipts,
} from "../../db/schemas/subscription-billing-operations";
import { webhookEvents } from "../../db/schemas/webhook-events";
import type { AppBillingWebhookTrigger } from "../../types/app-billing-webhook";
import type { GenericBillingProvider } from "./generic-billing-provider";
import { appBillingProviderPlan, getAppBillingProvider } from "./generic-billing-provider-runtime";
import type { BillingProviderEvent } from "./generic-billing-provider-types";

interface ReconciliationDependencies {
  provider(merchantId: string, livemode: boolean): Promise<GenericBillingProvider>;
  reconcileCommand(input: { scopeId: string; commandId: string }): Promise<unknown>;
}
const errorCode = (error: unknown) =>
  error instanceof ElizaError ? error.code : "APP_BILLING_RECONCILIATION_UNAVAILABLE";
async function snapshot(scopeId: string, subscriptionId: string, allowHistorical = false) {
  return writeTransaction(async (tx) => {
    const scope = await lockAppBillingScope(tx, scopeId, true);
    const [subscription] = await tx
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.billing_scope_id, scopeId),
          eq(billingSubscriptions.stripe_subscription_id, subscriptionId),
        ),
      );
    const [entitlement] = await tx
      .select({ id: organizationEntitlements.source_subscription_id })
      .from(organizationEntitlements)
      .where(eq(organizationEntitlements.billing_scope_id, scopeId));
    if (
      !subscription ||
      (!allowHistorical && entitlement && entitlement.id !== subscription.id) ||
      !scope.stripeCustomerId
    )
      appBillingConflict("Subscription is not the current durable scope authority");
    const plans = await tx
      .select()
      .from(appBillingPlanRevisions)
      .where(
        and(
          eq(appBillingPlanRevisions.app_id, scope.appId),
          eq(appBillingPlanRevisions.merchant_id, scope.merchantId),
          eq(appBillingPlanRevisions.product_family_key, scope.productFamilyKey),
          isNotNull(appBillingPlanRevisions.published_at),
        ),
      );
    if (!plans.length) appBillingConflict("Scoped subscription catalog is unavailable");
    return { scope, subscription, plans, now: await readPostLockDatabaseNow(tx) };
  });
}
export class AppBillingReconciliation {
  constructor(
    private readonly dependencies: ReconciliationDependencies = {
      provider: getAppBillingProvider,
      reconcileCommand: async (input) =>
        (await import("./generic-billing-runtime")).genericBillingRuntime.reconcileCommand(input),
    },
  ) {}
  async originalCommand(trigger: AppBillingWebhookTrigger) {
    const event = trigger.event;
    const rows = await dbWrite
      .select({ command: billingSubscriptionCommands, scope: appBillingScopes })
      .from(billingSubscriptionCommands)
      .innerJoin(
        appBillingScopes,
        eq(appBillingScopes.id, billingSubscriptionCommands.billing_scope_id),
      )
      .where(
        and(
          eq(appBillingScopes.merchant_id, event.merchantId),
          eq(appBillingScopes.livemode, event.livemode),
          isNotNull(billingSubscriptionCommands.app_id),
          inArray(billingSubscriptionCommands.status, [
            "PREPARED",
            "OUTCOME_UNKNOWN",
            "SUCCEEDED",
            "APPLIED",
            "FAILED",
            "SUPERSEDED",
          ]),
        ),
      );
    const matches = rows.filter(({ command }) => {
      if (command.request_payload?.domain !== "buyer") return false;
      const result = command.provider_result;
      const bound =
        result?.kind === "checkout" &&
        (event.objectType === "checkout.session"
          ? result.checkoutSessionId === event.objectId
          : result.subscriptionId === trigger.subscriptionIdHint);
      const ownedIntent =
        command.id === trigger.commandIdHint &&
        command.request_digest === trigger.requestDigestHint;
      return bound || ownedIntent;
    });
    if (matches.length !== 1)
      appBillingConflict("First provider object requires one original durable billing command");
    const match = matches[0]!;
    if (["APPLIED", "FAILED", "SUPERSEDED"].includes(match.command.status)) return;
    await this.dependencies.reconcileCommand({
      scopeId: match.scope.id,
      commandId: match.command.id,
    });
  }
  private async observe(
    state: Awaited<ReturnType<typeof snapshot>>,
    event: BillingProviderEvent | null,
    receipt?: { id: string; leaseToken: string },
    scopeToken?: string,
  ) {
    const provider = await this.dependencies.provider(state.scope.merchantId, state.scope.livemode);
    const request = {
      subscriptionId: state.subscription.stripe_subscription_id,
      customerId: state.scope.stripeCustomerId!,
      plans: state.plans.map(appBillingProviderPlan),
    };
    const initial = await provider.retrieveSubscriptionFromCatalog(state.scope, request);
    const plan = state.plans.find((row) => row.id === initial.planRevisionId);
    if (!plan) appBillingConflict("Provider response lost its scoped catalog binding");
    const invoiceRequest = {
      subscriptionId: request.subscriptionId,
      customerId: request.customerId,
      plan: appBillingProviderPlan(plan),
    };
    const invoice = initial.subscription.value.latestInvoiceId
      ? await provider.retrieveInvoice(state.scope, {
          ...invoiceRequest,
          invoiceId: initial.subscription.value.latestInvoiceId,
        })
      : null;
    const eventInvoice =
      event?.objectType === "invoice"
        ? event.objectId === invoice?.value.invoiceId
          ? invoice
          : await provider.retrieveInvoice(state.scope, {
              ...invoiceRequest,
              invoiceId: event.objectId,
            })
        : undefined;
    const fresh = await provider.retrieveSubscriptionFromCatalog(state.scope, request);
    if (
      fresh.subscription.digest !== initial.subscription.digest ||
      fresh.planRevisionId !== initial.planRevisionId
    )
      appBillingConflict(
        "Provider state changed while its invoices were retrieved; retry with fresh observations",
      );
    return appSubscriptionFinalizer.applyObservation({
      scopeId: state.scope.scopeId,
      planRevisionId: fresh.planRevisionId,
      expectedSubscriptionRevision: state.subscription.lifecycle_revision,
      subscription: fresh.subscription,
      invoice,
      eventInvoice,
      command: null,
      event,
      eventReceipt: receipt,
      scopeReconciliationLease: scopeToken ? { token: scopeToken } : undefined,
    });
  }
  async processTrigger(trigger: AppBillingWebhookTrigger) {
    const event = trigger.event;
    const binding =
      event.objectType === "checkout.session"
        ? null
        : await appBillingProviderBindings.resolveBinding({
            objectType: "subscription",
            objectId: trigger.subscriptionIdHint ?? event.objectId,
            merchantId: event.merchantId,
            providerAccountId: event.providerAccountId,
            livemode: event.livemode,
          });
    if (!binding?.scopeId || event.objectType === "checkout.session") {
      await this.originalCommand(trigger);
      return "command_reconciled" as const;
    }
    const [lifecycle] = await dbWrite
      .select({ id: billingSubscriptions.id })
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.billing_scope_id, binding.scopeId),
          eq(
            billingSubscriptions.stripe_subscription_id,
            trigger.subscriptionIdHint ?? event.objectId,
          ),
        ),
      );
    if (!lifecycle) {
      // A committed create response can be bound before its first atomic projection.
      await this.originalCommand(trigger);
      return "command_reconciled" as const;
    }
    const state = await snapshot(
      binding.scopeId,
      trigger.subscriptionIdHint ?? event.objectId,
      true,
    );
    if (
      state.scope.merchantKey !== trigger.merchantKey ||
      state.scope.merchantId !== event.merchantId ||
      state.scope.livemode !== event.livemode
    )
      appBillingConflict("Verified trigger merchant no longer matches durable scope");
    if (event.objectType !== "subscription" && event.objectType !== "invoice")
      appBillingConflict("Provider event is not a subscription reconciliation trigger");
    const billingScope = { scopeId: state.scope.scopeId, merchantKey: state.scope.merchantKey };
    const recorded = await subscriptionBillingOperationsRepository.recordEvent({
      billingScope,
      organizationId: state.scope.organizationId,
      subscriptionId: state.subscription.id,
      providerEventId: event.eventId,
      eventType: event.eventType,
      providerObjectType: event.objectType,
      providerObjectId: event.objectId,
      livemode: event.livemode,
      eventCreatedAt: new Date(event.createdAt * 1000),
      payloadDigest: event.payloadDigest,
      now: state.now,
    });
    if (recorded.value.status === "applied" || recorded.value.status === "ignored")
      return "replayed" as const;
    const token = randomUUID();
    const receipt = await subscriptionBillingOperationsRepository.claimEvent({
      billingScope,
      organizationId: state.scope.organizationId,
      receiptId: recorded.value.id,
      leaseToken: token,
      leaseDurationMs: 180_000,
    });
    if (!receipt)
      throw new ElizaError("Provider receipt is leased by another worker", {
        code: "APP_BILLING_EVENT_BUSY",
      });
    try {
      const ignored = await writeTransaction(async (tx) => {
        await lockAppBillingScope(tx, binding.scopeId!, true);
        const [projection] = await tx
          .select({ id: billingSubscriptions.id })
          .from(organizationEntitlements)
          .innerJoin(
            billingSubscriptions,
            and(
              eq(billingSubscriptions.id, organizationEntitlements.source_subscription_id),
              eq(billingSubscriptions.billing_scope_id, binding.scopeId!),
            ),
          )
          .where(eq(organizationEntitlements.billing_scope_id, binding.scopeId!));
        if (!projection) appBillingConflict("Historical event lost current scope projection");
        if (projection.id === state.subscription.id) return false;
        const now = await readPostLockDatabaseNow(tx);
        const [saved] = await tx
          .update(billingSubscriptionEventReceipts)
          .set({
            status: "ignored",
            lease_token: null,
            lease_expires_at: null,
            disposition: "superseded_scope_subscription",
            processed_at: now,
            updated_at: now,
            error_code: null,
          })
          .where(
            and(
              eq(billingSubscriptionEventReceipts.id, receipt.id),
              eq(billingSubscriptionEventReceipts.billing_scope_id, binding.scopeId!),
              eq(billingSubscriptionEventReceipts.subscription_id, state.subscription.id),
              eq(billingSubscriptionEventReceipts.status, "processing"),
              eq(billingSubscriptionEventReceipts.lease_token, token),
              gt(billingSubscriptionEventReceipts.lease_expires_at, now),
            ),
          )
          .returning({ id: billingSubscriptionEventReceipts.id });
        if (!saved) appBillingConflict("Historical event lost its current receipt lease");
        return true;
      });
      if (ignored) return "ignored" as const;
      const fresh = await snapshot(binding.scopeId, trigger.subscriptionIdHint ?? event.objectId);
      await this.observe(fresh, event, { id: receipt.id, leaseToken: token });
      return "applied" as const;
    } catch (error) {
      // error-policy:J2 Preserve the explicit provider/authority failure after releasing this receipt for durable retry.
      await subscriptionBillingOperationsRepository.failEvent({
        billingScope,
        organizationId: state.scope.organizationId,
        receiptId: receipt.id,
        leaseToken: token,
        status: "failed",
        errorCode: errorCode(error),
      });
      throw error;
    }
  }
  async processPersisted(receiptKey: string, trigger: AppBillingWebhookTrigger) {
    const [receipt] = await dbWrite
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.event_id, receiptKey), eq(webhookEvents.provider, "stripe")));
    if (!receipt?.app_billing_trigger || receipt.payload_hash !== trigger.event.payloadDigest)
      appBillingConflict("Provider queue message has no matching durable intake receipt");
    if (receipt.app_billing_completed_at) return "replayed" as const;
    // Only the stored signed intake can choose lookup hints; a queue body is not authority.
    try {
      const result = await this.processTrigger(receipt.app_billing_trigger);
      await dbWrite
        .update(webhookEvents)
        .set({ app_billing_completed_at: sql`clock_timestamp()`, app_billing_error_code: null })
        .where(
          and(eq(webhookEvents.id, receipt.id), isNull(webhookEvents.app_billing_completed_at)),
        );
      return result;
    } catch (error) {
      // error-policy:J2 Failed delivery remains queryable and recoverable even after Redis exhausts retries.
      await dbWrite
        .update(webhookEvents)
        .set({
          app_billing_error_code: errorCode(error),
          app_billing_next_attempt_at: sql`clock_timestamp()+interval '1 minute'`,
        })
        .where(
          and(eq(webhookEvents.id, receipt.id), isNull(webhookEvents.app_billing_completed_at)),
        );
      throw error;
    }
  }
  async recoverIntake(limit = 25) {
    const due = await dbWrite
      .select()
      .from(webhookEvents)
      .where(
        and(
          isNotNull(webhookEvents.app_billing_trigger),
          isNull(webhookEvents.app_billing_completed_at),
          lte(webhookEvents.app_billing_next_attempt_at, sql`clock_timestamp()`),
        ),
      )
      .orderBy(asc(webhookEvents.app_billing_next_attempt_at))
      .limit(limit);
    const result = { applied: 0, failed: 0 };
    for (const row of due) {
      try {
        await this.processPersisted(row.event_id, row.app_billing_trigger!);
        result.applied++;
      } catch {
        // error-policy:J4 The durable intake stores its explicit error and next retry; other tenants continue.
        result.failed++;
      }
    }
    return result;
  }
  async recoverCommands(limit = 25) {
    const commands = await dbWrite
      .select({ command: billingSubscriptionCommands })
      .from(billingSubscriptionCommands)
      .innerJoin(
        appBillingScopes,
        eq(appBillingScopes.id, billingSubscriptionCommands.billing_scope_id),
      )
      .where(
        and(
          lte(appBillingScopes.command_reconcile_after, sql`clock_timestamp()`),
          isNotNull(billingSubscriptionCommands.billing_scope_id),
          isNotNull(billingSubscriptionCommands.app_id),
          inArray(billingSubscriptionCommands.status, ["PREPARED", "OUTCOME_UNKNOWN", "SUCCEEDED"]),
          or(
            isNull(billingSubscriptionCommands.lease_expires_at),
            lte(billingSubscriptionCommands.lease_expires_at, sql`clock_timestamp()`),
          ),
          sql`${billingSubscriptionCommands.request_payload}->>'domain'='buyer'`,
          sql`(${billingSubscriptionCommands.status}<>'SUCCEEDED' OR ${billingSubscriptionCommands.provider_result}->>'kind' IN ('checkout','pending_update'))`,
        ),
      )
      .orderBy(
        asc(appBillingScopes.command_reconcile_after),
        asc(billingSubscriptionCommands.updated_at),
      )
      .limit(limit);
    const result = { processed: 0, failed: 0 };
    for (const { command } of commands) {
      const scheduled = await writeTransaction(async (tx) => {
        await lockAppBillingScope(tx, command.billing_scope_id!, true);
        const now = await readPostLockDatabaseNow(tx);
        const [scope] = await tx
          .update(appBillingScopes)
          .set({ command_reconcile_after: new Date(now.getTime() + 60_000) })
          .where(
            and(
              eq(appBillingScopes.id, command.billing_scope_id!),
              lte(appBillingScopes.command_reconcile_after, now),
            ),
          )
          .returning({ id: appBillingScopes.id });
        return Boolean(scope);
      });
      if (!scheduled) continue;
      try {
        await this.dependencies.reconcileCommand({
          scopeId: command.billing_scope_id!,
          commandId: command.id,
        });
        result.processed++;
      } catch {
        // error-policy:J4 The original command remains durable; failed authority does not authorize another purchase.
        result.failed++;
      }
    }
    return result;
  }
  async claimPeriodic() {
    const [candidate] = await dbWrite
      .select({ id: appBillingScopes.id })
      .from(appBillingScopes)
      .innerJoin(
        organizationEntitlements,
        and(
          eq(organizationEntitlements.billing_scope_id, appBillingScopes.id),
          isNotNull(organizationEntitlements.source_subscription_id),
        ),
      )
      .where(
        and(
          lte(appBillingScopes.reconcile_after, sql`clock_timestamp()`),
          or(
            isNull(appBillingScopes.reconcile_lease_expires_at),
            lte(appBillingScopes.reconcile_lease_expires_at, sql`clock_timestamp()`),
          ),
        ),
      )
      .orderBy(asc(appBillingScopes.reconcile_after))
      .limit(1);
    if (!candidate) return null;
    return writeTransaction(async (tx) => {
      await lockAppBillingScope(tx, candidate.id, true);
      const now = await readPostLockDatabaseNow(tx);
      const [row] = await tx
        .select()
        .from(appBillingScopes)
        .where(eq(appBillingScopes.id, candidate.id));
      if (
        !row ||
        row.reconcile_after > now ||
        (row.reconcile_lease_expires_at && row.reconcile_lease_expires_at > now)
      )
        return null;
      const token = randomUUID();
      await tx
        .update(appBillingScopes)
        .set({
          reconcile_lease_token: token,
          reconcile_lease_expires_at: new Date(now.getTime() + 180_000),
          reconcile_error_code: null,
        })
        .where(eq(appBillingScopes.id, row.id));
      const [current] = await tx
        .select({ subscriptionId: billingSubscriptions.stripe_subscription_id })
        .from(organizationEntitlements)
        .innerJoin(
          billingSubscriptions,
          eq(billingSubscriptions.id, organizationEntitlements.source_subscription_id),
        )
        .where(
          and(
            eq(organizationEntitlements.billing_scope_id, row.id),
            eq(billingSubscriptions.billing_scope_id, row.id),
          ),
        );
      if (!current) appBillingConflict("Periodic reconciliation lost current subscription binding");
      return { scopeId: row.id, subscriptionId: current.subscriptionId, token };
    });
  }
  async reconcilePeriodic(
    claim: NonNullable<Awaited<ReturnType<AppBillingReconciliation["claimPeriodic"]>>>,
  ) {
    try {
      return await this.observe(
        await snapshot(claim.scopeId, claim.subscriptionId),
        null,
        undefined,
        claim.token,
      );
    } catch (error) {
      // error-policy:J2 Releasing only the matching scope lease preserves another worker's authority.
      await dbWrite
        .update(appBillingScopes)
        .set({
          reconcile_lease_token: null,
          reconcile_lease_expires_at: null,
          reconcile_after: sql`clock_timestamp()+interval '1 minute'`,
          reconcile_error_code: errorCode(error),
        })
        .where(
          and(
            eq(appBillingScopes.id, claim.scopeId),
            eq(appBillingScopes.reconcile_lease_token, claim.token),
          ),
        );
      throw error;
    }
  }
  async recoverPeriodic(limit = 25) {
    const result = { processed: 0, failed: 0 };
    for (let index = 0; index < limit; index++) {
      const claim = await this.claimPeriodic();
      if (!claim) break;
      try {
        await this.reconcilePeriodic(claim);
        result.processed++;
      } catch {
        // error-policy:J4 The scope retains a concrete retry state while independent scopes continue.
        result.failed++;
      }
    }
    return result;
  }
}
export const appBillingReconciliation = new AppBillingReconciliation();
