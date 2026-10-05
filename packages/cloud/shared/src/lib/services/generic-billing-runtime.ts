/**
 * Executes purchaser intents through the registered merchant and existing
 * subscription journal. Retries recover the original provider intent; local
 * redirects and client assertions never authorize subscription access.
 */

import type { AppBillingOperation, AppBillingUpdateQuote } from "@elizaos/cloud-sdk/app-billing";
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { appBillingCommandRuntimeRepository } from "../../db/repositories/app-billing-command-runtime";
import type { AppBillingCommandActor } from "../../db/repositories/app-billing-deletion-authority";
import { failExpiredAppBillingPayment } from "../../db/repositories/app-billing-payment-action";
import {
  type AppBillingReadIdentity,
  appBillingQueries,
} from "../../db/repositories/app-billing-queries";
import { appBillingUpdateQuotesRepository } from "../../db/repositories/app-billing-update-quotes";
import {
  appBillingConflict,
  appSubscriptionAuthorityRepository,
} from "../../db/repositories/app-subscription-authority";
import { appSubscriptionFinalizer } from "../../db/repositories/app-subscription-finalizer";
import { billingMerchants } from "../../db/schemas/app-billing";
import {
  billingSubscriptionRevisions,
  billingSubscriptions,
} from "../../db/schemas/billing-subscriptions";
import { logger } from "../utils/logger";
import type { BuyerBillingCommandPayload } from "./generic-billing-command-types";
import { appBillingOperationDto } from "./generic-billing-operation";
import type { createGenericBillingProvider } from "./generic-billing-provider";
import { appBillingProviderPlan, getAppBillingProvider } from "./generic-billing-provider-runtime";
import type {
  BillingProviderObservation,
  BillingProviderSubscription,
  DurableProviderIntent,
} from "./generic-billing-provider-types";
import { getAppBillingUiOrigin } from "./generic-billing-runtime-config";
import { settlementDigest } from "./settlement-digest";

export interface BuyerBillingIdentity extends AppBillingReadIdentity {
  clientRegistrationId: string | null;
}
type Claimed = NonNullable<Awaited<ReturnType<typeof appBillingCommandRuntimeRepository.claim>>>;
type Provider = ReturnType<typeof createGenericBillingProvider>;

function billingReturnUrl(identity: BuyerBillingIdentity) {
  const origin = getAppBillingUiOrigin();
  const url = new URL(
    `/cloud/billing/apps/${identity.appId}/${encodeURIComponent(identity.productFamilyKey)}`,
    origin,
  );
  url.searchParams.set("accountId", identity.billingAccountId);
  return url.toString();
}

function intentFor(claim: Claimed, phase: string): DurableProviderIntent {
  return {
    commandId: claim.command.id,
    idempotencyKey: `${claim.command.provider_idempotency_key}:${phase}`,
    requestDigest: claim.command.request_digest,
  };
}

function retryWindowOpen(claim: Claimed) {
  return (
    !claim.scope.salesFenced &&
    claim.command.provider_started_at !== null &&
    claim.now.getTime() - claim.command.provider_started_at.getTime() < 23 * 60 * 60 * 1000
  );
}

export class GenericBillingRuntime {
  constructor(private readonly resolveProvider = getAppBillingProvider) {}

  async portal(
    identity: BuyerBillingIdentity,
    input: { idempotencyKey: string; expectedSubscriptionRevision: number | null },
  ) {
    return this.prepare(identity, {
      ...input,
      payload: {
        version: 1,
        domain: "buyer",
        action: "portal",
        returnUrl: billingReturnUrl(identity),
      },
    });
  }

  async reconcileCommand(input: { scopeId: string; commandId: string }) {
    const command = await appBillingCommandRuntimeRepository.originalActor(input);
    return this.run({ ...input, actorUserId: command.requested_by_user_id });
  }

  async prepare(
    identity: BuyerBillingIdentity,
    input: {
      idempotencyKey: string;
      expectedSubscriptionRevision: number | null;
      payload: BuyerBillingCommandPayload;
    },
  ): Promise<AppBillingOperation> {
    const action = input.payload.action;
    const planId = "planRevisionId" in input.payload ? input.payload.planRevisionId : null;
    let scope;
    if (planId) {
      const plan = await appSubscriptionAuthorityRepository.getHistoricalPlan({
        appId: identity.appId,
        planRevisionId: planId,
      });
      const [merchant] = await dbWrite
        .select({ mode: billingMerchants.livemode })
        .from(billingMerchants)
        .where(eq(billingMerchants.id, plan.merchant_id));
      if (
        !merchant ||
        merchant.mode !== identity.livemode ||
        plan.product_family_key !== identity.productFamilyKey
      )
        appBillingConflict(
          "Selected plan belongs to a different app product or billing environment",
        );
      scope = await appSubscriptionAuthorityRepository.resolveScope({
        ...identity,
        merchantId: plan.merchant_id,
      });
    } else scope = await appSubscriptionAuthorityRepository.getScope(identity);
    const quantity = "quantity" in input.payload ? input.payload.quantity : 1;
    const kind =
      action === "trial" || (action === "checkout" && input.expectedSubscriptionRevision === null)
        ? "checkout"
        : action === "checkout" || action === "update"
          ? "upgrade"
          : action;
    const command = await appSubscriptionAuthorityRepository.prepareCommand({
      scopeId: scope.scopeId,
      actorUserId: identity.actorUserId,
      kind,
      targetPlanRevisionId: planId,
      quantity,
      idempotencyKey: input.idempotencyKey,
      expectedSubscriptionRevision: input.expectedSubscriptionRevision,
      requestDigest: settlementDigest({ identity, ...input }),
      payload: input.payload,
      ...(action === "checkout" || action === "portal"
        ? { registeredBillingReturn: true as const }
        : {}),
      clientRegistrationId: identity.clientRegistrationId,
    });
    if ((command.status === "PREPARED" || command.status === "OUTCOME_UNKNOWN") && planId) {
      const read = await appBillingQueries.snapshot(identity);
      if (
        action === "trial" ||
        (action === "checkout" && command.subscription_id === null && read.trial === null)
      )
        await appSubscriptionAuthorityRepository.claimTrial({
          scopeId: scope.scopeId,
          commandId: command.id,
          planRevisionId: planId,
        });
    }
    return this.run({
      scopeId: scope.scopeId,
      commandId: command.id,
      actorUserId: identity.actorUserId,
    });
  }

  async checkout(
    identity: BuyerBillingIdentity,
    input: {
      idempotencyKey: string;
      expectedSubscriptionRevision: number | null;
      planRevisionId: string;
      quantity: number;
      billingConsent: "accepted";
    },
  ) {
    const url = billingReturnUrl(identity);
    return this.prepare(identity, {
      ...input,
      payload: {
        version: 1,
        domain: "buyer",
        action: "checkout",
        planRevisionId: input.planRevisionId,
        quantity: input.quantity,
        billingConsent: input.billingConsent,
        successUrl: url,
        cancelUrl: url,
      },
    });
  }

  async quote(
    identity: BuyerBillingIdentity,
    input: {
      planRevisionId: string;
      quantity: number;
      expectedSubscriptionRevision: number | null;
    },
  ): Promise<AppBillingUpdateQuote> {
    const read = await appBillingQueries.snapshot(identity);
    if (
      read.kind !== "subscription" ||
      read.mutationRevision === null ||
      read.mutationRevision !== input.expectedSubscriptionRevision ||
      read.pendingCommand
    )
      appBillingConflict("Refresh the current subscription before reviewing a change");
    const target = await appSubscriptionAuthorityRepository.getPlan({
      appId: identity.appId,
      planRevisionId: input.planRevisionId,
    });
    if (
      target.merchant_id !== read.scope.merchantId ||
      target.product_family_key !== identity.productFamilyKey
    )
      appBillingConflict("Selected plan is not in this subscription's catalog");
    const provider = await this.resolveProvider(read.scope.merchantId, identity.livemode);
    const preview = await provider.previewSubscriptionUpdate(read.scope, {
      subscriptionId: read.subscription.stripe_subscription_id,
      customerId: read.subscription.stripe_customer_id,
      currentPlan: appBillingProviderPlan(read.plan),
      targetPlan: appBillingProviderPlan(target),
      quantity: input.quantity,
      minimumSeats: read.seats.length,
      prorationDate: Math.floor(read.now.getTime() / 1000),
    });
    const saved = await appBillingUpdateQuotesRepository.save({
      scopeId: read.scope.scopeId,
      actorUserId: identity.actorUserId,
      subscriptionId: read.subscription.id,
      subscriptionRevision: read.subscription.lifecycle_revision,
      planRevisionId: target.id,
      quantity: input.quantity,
      preview: preview.value,
    });
    return {
      id: saved.id,
      appId: identity.appId,
      billingAccountId: identity.billingAccountId,
      productFamilyKey: identity.productFamilyKey,
      planRevisionId: target.id,
      quantity: input.quantity,
      subscriptionRevision: String(saved.subscription_revision),
      dueNowCents: preview.value.dueNowCents,
      currency: preview.value.nextInvoice.currency,
      nextInvoiceAmountCents: preview.value.nextInvoice.amountDueCents,
      recurringAmountCents: (preview.value.recurringInvoice ?? preview.value.nextInvoice)
        .amountDueCents,
      trialEndsAt:
        preview.value.trialEnd === null
          ? null
          : new Date(preview.value.trialEnd * 1000).toISOString(),
      expiresAt: saved.expires_at.toISOString(),
    };
  }

  async run(
    input: {
      scopeId: string;
      commandId: string;
    } & AppBillingCommandActor,
  ): Promise<AppBillingOperation> {
    const claim = await appBillingCommandRuntimeRepository.claim(input);
    if (claim) {
      try {
        await this.dispatch(claim);
      } catch (error) {
        // error-policy:J1 persist ambiguous provider outcome for reconciliation; never report purchase success.
        const code =
          error instanceof ElizaError ? error.code : "APP_BILLING_PROVIDER_OUTCOME_UNKNOWN";
        await appBillingCommandRuntimeRepository.releaseForReconciliation(claim.lease, code);
        logger.warn("[GenericBillingRuntime] Provider outcome requires reconciliation", {
          commandId: claim.command.id,
          code,
          error,
          cause: error instanceof Error ? error.cause : undefined,
        });
      } finally {
        await appBillingCommandRuntimeRepository.releaseLease(claim.lease);
      }
    }
    const read = await appBillingCommandRuntimeRepository.read(input);
    return appBillingOperationDto(read.scope, read.command);
  }

  private async customer(claim: Claimed, provider: Provider): Promise<string | null> {
    const owner = await appBillingCommandRuntimeRepository.customerCreationOwner({
      scopeId: claim.scope.scopeId,
      commandId: claim.command.id,
    });
    if (owner.customerId) return owner.customerId;
    if (owner.ownerCommandId !== claim.command.id) return null;
    const intent = intentFor(claim, "customer");
    let customerId: string | null = null;
    if (!claim.firstDispatch) {
      const found = await provider.discoverCreatedCustomer(claim.scope, intent);
      if (found.value.status === "found") customerId = found.value.object.customerId;
    }
    if (customerId === null && retryWindowOpen(claim))
      customerId = (await provider.createCustomer(claim.scope, intent)).value.customerId;
    if (customerId === null) return null;
    await appSubscriptionAuthorityRepository.bindCustomer({
      scopeId: claim.scope.scopeId,
      commandId: claim.command.id,
      customerId,
      lease: claim.lease,
    });
    return customerId;
  }

  private async finalize(
    claim: Claimed,
    provider: Provider,
    subscription: BillingProviderObservation<BillingProviderSubscription>,
    planId: string,
  ) {
    if (subscription.value.pendingUpdate) return;
    const plan = await appSubscriptionAuthorityRepository.getHistoricalPlan({
      appId: claim.scope.appId,
      planRevisionId: planId,
    });
    if (!claim.command.provider_result)
      await appBillingCommandRuntimeRepository.recordProgress(claim.lease, {
        kind: "completed",
        subscriptionId: subscription.value.subscriptionId,
        subscriptionRevision: null,
      });
    const [current] = await dbWrite
      .select({ revision: billingSubscriptions.lifecycle_revision })
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.billing_scope_id, claim.scope.scopeId),
          eq(billingSubscriptions.stripe_subscription_id, subscription.value.subscriptionId),
        ),
      );
    // Capture the CAS revision before retrieving provider state; a losing writer must retrieve again.
    const fresh = await provider.retrieveSubscription(claim.scope, {
      subscriptionId: subscription.value.subscriptionId,
      customerId: subscription.value.customerId,
      plan: appBillingProviderPlan(plan),
    });
    if (fresh.value.pendingUpdate) return;
    const invoice = fresh.value.latestInvoiceId
      ? await provider.retrieveInvoice(claim.scope, {
          invoiceId: fresh.value.latestInvoiceId,
          subscriptionId: fresh.value.subscriptionId,
          customerId: fresh.value.customerId,
          plan: appBillingProviderPlan(plan),
        })
      : null;
    return appSubscriptionFinalizer.applyObservation({
      scopeId: claim.scope.scopeId,
      planRevisionId: planId,
      expectedSubscriptionRevision: current?.revision ?? null,
      ...(current && current.revision !== claim.command.expected_subscription_revision
        ? { commandReconciliation: true as const }
        : {}),
      // A fresh read is attached to the same durable command after its ownership resolver succeeds.
      subscription: { ...fresh, inputDigest: claim.command.request_digest },
      invoice,
      command: {
        id: claim.command.id,
        stateRevision: claim.lease.stateRevision,
        executionGeneration: claim.lease.executionGeneration,
        leaseToken: claim.lease.token,
        ...(claim.deletionAuthority ? { deletionAuthority: claim.deletionAuthority } : {}),
      },
      event: null,
    });
  }

  private async dispatch(claim: Claimed): Promise<void> {
    const payload = claim.command.request_payload;
    if (!payload || payload.domain !== "buyer")
      appBillingConflict("Billing command has no purchaser intent");
    if (claim.deletionAuthority && ["portal", "expire_checkout"].includes(payload.action)) return;
    const provider = await this.resolveProvider(claim.scope.merchantId, claim.scope.livemode);
    const customerId = await this.customer(claim, provider);
    if (customerId === null) return;
    const plan = claim.plan ? appBillingProviderPlan(claim.plan) : null;
    if (payload.action === "trial") {
      if (!plan || !claim.trial || claim.trial.command_id !== claim.command.id)
        appBillingConflict("Trial requires its immutable plan and original claim");
      const input = {
        customerId,
        plan,
        quantity: payload.quantity,
        trialClaim: {
          startsAt: claim.trial.starts_at.getTime() / 1000,
          endsAt: claim.trial.ends_at.getTime() / 1000,
        },
      };
      const intent = intentFor(claim, "trial");
      const bound = claim.command.provider_result;
      if (bound?.kind === "completed" && bound.subscriptionId) {
        await this.finalize(
          claim,
          provider,
          await provider.retrieveSubscription(claim.scope, {
            subscriptionId: bound.subscriptionId,
            customerId,
            plan,
          }),
          plan.planRevisionId,
        );
        return;
      }
      if (!claim.firstDispatch) {
        const recovered = await provider.discoverCreatedSubscription(claim.scope, input, intent);
        if (recovered.value.status === "found") {
          await this.finalize(
            claim,
            provider,
            { ...recovered, value: recovered.value.object },
            plan.planRevisionId,
          );
          return;
        }
      }
      if (!retryWindowOpen(claim)) return;
      await this.finalize(
        claim,
        provider,
        await provider.startTrial(claim.scope, input, intent),
        plan.planRevisionId,
      );
      return;
    }
    if (payload.action === "cancel") {
      if (!plan || !claim.subscription)
        appBillingConflict("Cancellation requires the scoped subscription");
      if (claim.deletionAuthority) {
        const observed = await provider.retrieveSubscription(claim.scope, {
          subscriptionId: claim.subscription.stripe_subscription_id,
          customerId,
          plan,
        });
        if (
          observed.value.status === "canceled" ||
          (payload.timing === "period_end" && observed.value.cancelAtPeriodEnd)
        )
          await this.finalize(claim, provider, observed, plan.planRevisionId);
        return;
      }
      const observed = await provider.cancelSubscription(
        claim.scope,
        {
          subscriptionId: claim.subscription.stripe_subscription_id,
          customerId,
          plan,
          atPeriodEnd: payload.timing === "period_end",
        },
        intentFor(claim, "cancel"),
      );
      await this.finalize(claim, provider, observed, plan.planRevisionId);
      return;
    }
    if (payload.action === "portal") {
      if (!plan || !claim.subscription)
        appBillingConflict("Portal requires an existing app subscription");
      const read = await appBillingQueries.snapshot({
        appId: claim.scope.appId,
        billingAccountId: claim.scope.billingAccountId,
        productFamilyKey: claim.scope.productFamilyKey,
        actorUserId: claim.command.requested_by_user_id,
        livemode: claim.scope.livemode,
      });
      const observed = await provider.createPortal(
        claim.scope,
        {
          customerId,
          returnUrl: payload.returnUrl,
          subscriptionId: claim.subscription.stripe_subscription_id,
          currentPlan: plan,
          availablePlans: [plan],
          minimumSeats: read.kind === "subscription" ? read.seats.length : 0,
        },
        intentFor(claim, "portal"),
      );
      await appBillingCommandRuntimeRepository.recordResult(claim.lease, {
        kind: "portal",
        url: observed.value.url,
        expiresAt: null,
      });
      return;
    }
    await this.dispatchCheckoutOrUpdate(claim, provider, customerId);
  }

  private async dispatchCheckoutOrUpdate(
    claim: Claimed,
    provider: Provider,
    customerId: string,
  ): Promise<void> {
    const payload = claim.command.request_payload;
    if (!payload || payload.domain !== "buyer")
      appBillingConflict("Billing command has no purchaser intent");
    if (payload.action === "expire_checkout") {
      const original = await appBillingCommandRuntimeRepository.read({
        scopeId: claim.scope.scopeId,
        commandId: payload.checkoutCommandId,
        actorUserId: claim.command.requested_by_user_id,
      });
      const result = original.command.provider_result;
      if (result?.kind !== "checkout")
        appBillingConflict("Checkout must be reconciled before it can be expired");
      if (result.mode === "setup") {
        if (!result.subscriptionId || !original.command.target_plan_revision_id)
          appBillingConflict("Setup checkout lost its original subscription");
        const plan = await appSubscriptionAuthorityRepository.getHistoricalPlan({
          appId: claim.scope.appId,
          planRevisionId: original.command.target_plan_revision_id,
        });
        const expired = await provider.expireCheckout(
          claim.scope,
          {
            mode: "setup",
            sessionId: result.checkoutSessionId,
            customerId,
            subscriptionId: result.subscriptionId,
            plan: appBillingProviderPlan(plan),
          },
          intentFor(claim, "expire"),
        );
        if (expired.value.status !== "expired")
          appBillingConflict("Completed checkout must be reconciled before another change");
      } else {
        const expired = await provider.expireCheckout(
          claim.scope,
          { sessionId: result.checkoutSessionId, customerId },
          intentFor(claim, "expire"),
        );
        if (expired.value.status !== "expired")
          appBillingConflict("Completed checkout must be reconciled before another change");
      }
      await appBillingCommandRuntimeRepository.expireCheckoutCommand(
        claim.lease,
        original.command.id,
        result.checkoutSessionId,
      );
      return;
    }
    if (!claim.plan) appBillingConflict("Purchase command lost its immutable plan");
    const plan = appBillingProviderPlan(claim.plan);
    if (payload.action === "update") {
      if (!claim.subscription || !claim.subscription.plan_revision_id)
        appBillingConflict("Plan update lost its current subscription");
      const oldPlan = await appSubscriptionAuthorityRepository.getHistoricalPlan({
        appId: claim.scope.appId,
        planRevisionId: claim.subscription.plan_revision_id,
      });
      const listed = await provider.listSubscriptions(claim.scope, {
        customerId,
        plans: [appBillingProviderPlan(oldPlan), plan],
      });
      const current = listed.value.find(
        (row) => row.subscriptionId === claim.subscription?.stripe_subscription_id,
      );
      if (!current) appBillingConflict("Current provider subscription is unavailable");
      const quote = await appBillingUpdateQuotesRepository.getForCommand(claim.lease);
      if (quote.consumed_by_command_id !== claim.command.id)
        appBillingConflict("Reviewed quote was consumed by another purchase");
      const result = claim.command.provider_result;
      if (result && result.kind !== "payment" && result.kind !== "completed")
        appBillingConflict("Update has an incompatible stored result");
      const payment = result?.kind === "payment" ? result : null;
      const inspectPayment = () => {
        if (claim.command.provider_started_at === null)
          appBillingConflict("Update has no original dispatch time");
        return provider.inspectUpdatePayment(claim.scope, {
          subscriptionId: current.subscriptionId,
          customerId,
          currentPlan: appBillingProviderPlan(oldPlan),
          targetPlan: plan,
          quantity: payload.quantity,
          invoiceId: payment?.invoiceId ?? null,
          dispatchedAt: Math.floor(claim.command.provider_started_at.getTime() / 1000),
          reviewedPreview: quote.provider_preview,
        });
      };
      if (current.pendingUpdate || payment) {
        if (claim.firstDispatch)
          appBillingConflict("A prior pending update must be reconciled before another change");
        const inspected = await inspectPayment();
        if (inspected.applied) {
          await this.finalize(claim, provider, inspected.subscription, plan.planRevisionId);
        } else if (inspected.action) {
          await appBillingCommandRuntimeRepository.recordResult(claim.lease, inspected.action);
        } else if (payment && inspected.invoice?.value.status === "void") {
          // A second read after the terminal invoice observation protects delayed subscription application.
          const fresh = await inspectPayment();
          if (fresh.applied)
            await this.finalize(claim, provider, fresh.subscription, plan.planRevisionId);
          else if (fresh.invoice)
            await failExpiredAppBillingPayment({
              lease: claim.lease,
              payment,
              subscription: fresh.subscription,
              invoice: fresh.invoice,
              targetPriceId: plan.priceId,
              targetQuantity: payload.quantity,
            });
        }
        return;
      }
      if (current.priceId === plan.priceId && current.quantity === payload.quantity) {
        await this.finalize(
          claim,
          provider,
          { ...listed, value: current, digest: settlementDigest(current) },
          plan.planRevisionId,
        );
        return;
      }
      if (!retryWindowOpen(claim)) return;
      const read = await appBillingQueries.snapshot({
        appId: claim.scope.appId,
        billingAccountId: claim.scope.billingAccountId,
        productFamilyKey: claim.scope.productFamilyKey,
        actorUserId: claim.command.requested_by_user_id,
        livemode: claim.scope.livemode,
      });
      if (
        read.kind !== "subscription" ||
        read.subscription.lifecycle_revision !== claim.command.expected_subscription_revision
      )
        appBillingConflict("Subscription changed after confirmation; reconcile before dispatch");
      const updated = await provider.updateSubscription(
        claim.scope,
        {
          subscriptionId: current.subscriptionId,
          customerId,
          currentPlan: appBillingProviderPlan(oldPlan),
          targetPlan: plan,
          quantity: payload.quantity,
          minimumSeats: read.seats.length,
          prorationDate: quote.provider_preview.prorationDate,
          reviewedPreview: quote.provider_preview,
        },
        intentFor(claim, "update"),
      );
      if (updated.value.pendingUpdate) {
        const inspected = await inspectPayment();
        if (inspected.applied)
          await this.finalize(claim, provider, inspected.subscription, plan.planRevisionId);
        else if (inspected.action)
          await appBillingCommandRuntimeRepository.recordResult(claim.lease, inspected.action);
        return;
      }
      await this.finalize(claim, provider, updated, plan.planRevisionId);
      return;
    }
    if (payload.action !== "checkout") appBillingConflict("Unsupported purchaser operation");
    const existing = claim.command.provider_result;
    if (claim.subscription) {
      if (
        claim.subscription.plan_revision_id !== plan.planRevisionId ||
        claim.subscription.quantity !== payload.quantity
      )
        appBillingConflict("Review the plan or seat change before adding a payment method");
      const request = {
        subscriptionId: claim.subscription.stripe_subscription_id,
        customerId,
        plan,
        successUrl: payload.successUrl,
        cancelUrl: payload.cancelUrl,
      };
      if (existing?.kind === "checkout") {
        let resume = existing.resume;
        if (!resume) {
          const read = await provider.readPaymentMethodCheckout(claim.scope, {
            ...request,
            sessionId: existing.checkoutSessionId,
          });
          if (read.value.status === "expired") {
            await appBillingCommandRuntimeRepository.expireCheckoutCommand(
              claim.lease,
              claim.command.id,
              existing.checkoutSessionId,
            );
            return;
          }
          if (read.value.status !== "complete") return;
          // Deletion recovery observes only an already-recorded resume invoice.
          if (claim.deletionAuthority || claim.scope.salesFenced) return;
          const originalRevision = claim.command.expected_subscription_revision;
          if (originalRevision === null)
            appBillingConflict("Setup recovery lost its original subscription revision");
          const [original] = await dbWrite
            .select({ status: billingSubscriptionRevisions.status })
            .from(billingSubscriptionRevisions)
            .where(
              and(
                eq(billingSubscriptionRevisions.subscription_id, claim.subscription.id),
                eq(billingSubscriptionRevisions.billing_scope_id, claim.scope.scopeId),
                eq(billingSubscriptionRevisions.revision, originalRevision),
              ),
            );
          if (!original) appBillingConflict("Setup recovery cannot read its original subscription");
          const current = await provider.retrieveSubscription(claim.scope, request);
          // A webhook may already have advanced the live row. Only the immutable original
          // revision can distinguish normal active-account setup from ambiguous legacy resume.
          const recoveringResume =
            current.value.pendingUpdate ||
            (original.status === "paused" && current.value.status !== "paused") ||
            (original.status !== "active" && ["active", "past_due"].includes(current.value.status));
          if (!recoveringResume && !retryWindowOpen(claim)) return;
          const applied = recoveringResume
            ? current
            : await provider.applyPaymentMethodCheckout(
                claim.scope,
                { ...request, sessionId: existing.checkoutSessionId },
                intentFor(claim, "attach-payment"),
              );
          if (
            !recoveringResume &&
            applied.value.status !== "paused" &&
            !applied.value.pendingUpdate
          ) {
            await this.finalize(claim, provider, applied, plan.planRevisionId);
            return;
          }
          const legacyPending = recoveringResume;
          const originalDispatch = claim.command.provider_started_at;
          if (legacyPending && originalDispatch === null)
            appBillingConflict("Legacy resume recovery lost its original dispatch time");
          const notBefore = legacyPending && originalDispatch ? originalDispatch : claim.now;
          resume = {
            notBefore: notBefore.toISOString(),
            previousInvoiceId: legacyPending ? null : applied.value.latestInvoiceId,
            invoiceId: null,
            action: null,
          };
          await appBillingCommandRuntimeRepository.recordProgress(claim.lease, {
            ...existing,
            resume,
          });
        }
        const mayWrite =
          !claim.deletionAuthority &&
          !claim.scope.salesFenced &&
          claim.now.getTime() - new Date(resume.notBefore).getTime() < 23 * 60 * 60 * 1000;
        if (resume.invoiceId === null) {
          if (!mayWrite) return;
          // Only replay the original resume endpoint/key. Current latest_invoice is not payment authority.
          let resumed: BillingProviderObservation<BillingProviderSubscription>;
          try {
            resumed = await provider.replayPausedSubscriptionResume(
              claim.scope,
              request,
              intentFor(claim, "resume"),
            );
          } catch (error) {
            // error-policy:J2 Preserve ambiguous legacy resume failure without adopting the latest invoice.
            throw new ElizaError("The original subscription resume invoice remains unresolved", {
              code: "APP_BILLING_RESUME_REPLAY_UNRESOLVED",
              cause: error,
              context: {
                commandId: claim.command.id,
                notBefore: resume.notBefore,
                previousInvoiceId: resume.previousInvoiceId,
                recoveryConstraint:
                  "Only the original resume key is replayed within its retained window; unrelated invoice payment is forbidden",
              },
            });
          }
          if (resumed.value.latestInvoiceId === null)
            appBillingConflict("Subscription resume returned no invoice to retain");
          resume = { ...resume, invoiceId: resumed.value.latestInvoiceId };
          await appBillingCommandRuntimeRepository.recordProgress(claim.lease, {
            ...existing,
            resume,
          });
        }
        const invoiceId = resume.invoiceId;
        if (invoiceId === null) appBillingConflict("Resume payment lost its recorded invoice");
        const paymentInput = {
          ...request,
          sessionId: existing.checkoutSessionId,
          quantity: payload.quantity,
          invoiceId,
          previousInvoiceId: resume.previousInvoiceId,
          dispatchedAt: Math.floor(new Date(resume.notBefore).getTime() / 1000),
        };
        let inspected = await provider.inspectPaymentMethodResume(claim.scope, paymentInput);
        if (resume.action === null && inspected.action) {
          resume = { ...resume, action: inspected.action };
          await appBillingCommandRuntimeRepository.recordProgress(claim.lease, {
            ...existing,
            resume,
          });
        }
        if (inspected.payable && mayWrite && !resume.invoicePaid)
          inspected = await provider.payPaymentMethodResumeInvoice(
            claim.scope,
            paymentInput,
            intentFor(claim, "resume-pay"),
          );
        if (inspected.settled && !resume.invoicePaid) {
          resume = { ...resume, invoicePaid: true };
          await appBillingCommandRuntimeRepository.recordProgress(claim.lease, {
            ...existing,
            resume,
          });
        }
        if (inspected.applied)
          await this.finalize(claim, provider, inspected.subscription, plan.planRevisionId);
        else if (resume.action || inspected.action)
          await appBillingCommandRuntimeRepository.recordResult(claim.lease, {
            ...existing,
            resume: { ...resume, action: resume.action ?? inspected.action },
          });
        return;
      }
      const intent = intentFor(claim, "checkout");
      const discovered = claim.firstDispatch
        ? null
        : await provider.discoverCreatedPaymentMethodCheckout(claim.scope, request, intent);
      const checkout =
        discovered?.value.status === "found"
          ? discovered.value.object
          : retryWindowOpen(claim)
            ? (await provider.createPaymentMethodCheckout(claim.scope, request, intent)).value
            : null;
      if (!checkout) return;
      await appBillingCommandRuntimeRepository.recordResult(claim.lease, {
        kind: "checkout",
        mode: "setup",
        checkoutSessionId: checkout.sessionId,
        customerId,
        subscriptionId: checkout.subscriptionId,
        url: checkout.url,
        expiresAt: new Date(checkout.expiresAt * 1000).toISOString(),
      });
      return;
    }
    if (existing?.kind === "checkout") {
      const read = await provider.readCheckout(claim.scope, {
        sessionId: existing.checkoutSessionId,
        customerId,
      });
      if (read.value.status === "expired") {
        await appBillingCommandRuntimeRepository.expireCheckoutCommand(
          claim.lease,
          claim.command.id,
          existing.checkoutSessionId,
        );
        return;
      }
      if (read.value.status !== "complete" || !read.value.subscriptionId) return;
      await appBillingCommandRuntimeRepository.recordProgress(claim.lease, {
        ...existing,
        subscriptionId: read.value.subscriptionId,
      });
      const observed = await provider.retrieveSubscription(claim.scope, {
        subscriptionId: read.value.subscriptionId,
        customerId,
        plan,
      });
      await this.finalize(claim, provider, observed, plan.planRevisionId);
      return;
    }
    const originalTrial = claim.trial?.command_id === claim.command.id ? claim.trial : null;
    const request = {
      customerId,
      plan,
      quantity: payload.quantity,
      successUrl: payload.successUrl,
      cancelUrl: payload.cancelUrl,
      trial: originalTrial !== null,
      ...(originalTrial
        ? {
            trialClaim: {
              startsAt: originalTrial.starts_at.getTime() / 1000,
              endsAt: originalTrial.ends_at.getTime() / 1000,
            },
          }
        : {}),
    };
    const intent = intentFor(claim, "checkout");
    const found = claim.firstDispatch
      ? null
      : await provider.discoverCreatedCheckout(claim.scope, request, intent);
    const checkout =
      found?.value.status === "found"
        ? found.value.object
        : retryWindowOpen(claim)
          ? (await provider.createCheckout(claim.scope, request, intent)).value
          : null;
    if (!checkout) return;
    await appBillingCommandRuntimeRepository.recordResult(claim.lease, {
      kind: "checkout",
      mode: "subscription",
      checkoutSessionId: checkout.sessionId,
      customerId,
      subscriptionId: checkout.subscriptionId,
      url: checkout.url,
      expiresAt: new Date(checkout.expiresAt * 1000).toISOString(),
    });
  }
}

export const genericBillingRuntime = new GenericBillingRuntime();
