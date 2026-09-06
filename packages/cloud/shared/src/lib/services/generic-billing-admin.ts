/** Runs app-owner merchant and catalog administration with durable intents, verified provider scope and current authorization. */
import type {
  AdoptAppBillingPlanRequest,
  AppBillingAdminOperation,
  AppBillingMerchantRequest,
  AppBillingPlanRevisionRequest,
  AppBillingRefundRequest,
  CreateAppBillingPlanRequest,
  DisconnectAppBillingMerchantRequest,
  RegisterAppBillingMerchantRequest,
} from "@elizaos/cloud-sdk/app-billing-admin";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { writeTransaction } from "../../db/helpers";
import {
  type AppBillingOwner,
  adminCreatorConnection,
  adminMerchant,
  adminMerchantDto,
  adminRegistration,
  appBillingAdminFailure,
  appBillingAdminRepository,
  lockAppBillingOwner,
  recordCatalogVerification,
  recordMerchantVerification,
} from "../../db/repositories/app-billing-admin";
import { lockAppBillingRefundSource } from "../../db/repositories/app-billing-refund-source";
import {
  appBillingPlanRevisions,
  appBillingScopes,
  billingMerchants,
} from "../../db/schemas/app-billing";
import { billingSubscriptions } from "../../db/schemas/billing-subscriptions";
import { type BillingSubscriptionCommand } from "../../db/schemas/subscription-billing-operations";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { GenericBillingCatalogAdministration } from "./generic-billing-admin-catalog";
import {
  appPlanProviderBinding,
  createGenericBillingAdminProvider,
} from "./generic-billing-admin-provider";
import { GenericBillingAdminReadService } from "./generic-billing-admin-read";
import { appBillingRefundRequestSchema } from "./generic-billing-admin-requests";
import type { AdminBillingCommandPayload } from "./generic-billing-command-types";
import { createGenericBillingProvider } from "./generic-billing-provider";
import type { DurableProviderIntent } from "./generic-billing-provider-types";
import { executeAppBillingRefund, readAppBillingRefund } from "./generic-billing-refund";
import { GenericBillingRefundReadService } from "./generic-billing-refund-read";
import {
  appBillingProviderMerchant,
  getAppBillingStripe,
  getAppBillingUiOrigin,
} from "./generic-billing-runtime-config";
import { settlementDigest } from "./settlement-digest";

export class GenericBillingAdminService {
  constructor(
    private readonly stripeForMode: (livemode: boolean) => Promise<Stripe> = getAppBillingStripe,
  ) {}
  overview(owner: AppBillingOwner) {
    return new GenericBillingAdminReadService().overview(owner);
  }
  async registerMerchant(owner: AppBillingOwner, input: RegisterAppBillingMerchantRequest) {
    const command = await appBillingAdminRepository.prepare(owner, {
      clientRegistrationId: input.clientRegistrationId,
      idempotencyKey: input.idempotencyKey,
      merchantId: null,
      requestDigest: settlementDigest({ owner, input }),
      payload: async (_id, tx) => {
        const base = {
          version: 1 as const,
          domain: "admin" as const,
          clientRegistrationId: input.clientRegistrationId,
        };
        if (input.mode === "create_connected")
          return { ...base, action: "merchant_create", country: input.country };
        if (input.mode === "adopt_creator")
          return {
            ...base,
            action: "merchant_adopt",
            creatorConnectionId: input.creatorConnectionId,
            providerAccountId: await adminCreatorConnection(tx, owner, input.creatorConnectionId),
          };
        if (getCloudAwareEnv().STRIPE_PLATFORM_BILLING_ORGANIZATION_ID !== owner.organizationId)
          appBillingAdminFailure(
            "This organization is not registered as the first-party platform merchant",
            "FORBIDDEN",
          );
        return { ...base, action: "merchant_platform" };
      },
    });
    return this.recoverOperation(owner, command.id);
  }
  async onboardMerchant(owner: AppBillingOwner, input: AppBillingMerchantRequest) {
    const url = new URL("/cloud-apps", getAppBillingUiOrigin());
    url.searchParams.set("appId", owner.appId);
    url.searchParams.set("tab", "monetize");
    const payload: AdminBillingCommandPayload = {
      version: 1,
      domain: "admin",
      clientRegistrationId: input.clientRegistrationId,
      action: "merchant_onboarding",
      merchantId: input.merchantId,
      returnUrl: url.toString(),
      refreshUrl: url.toString(),
    };
    const command = await appBillingAdminRepository.prepare(owner, {
      clientRegistrationId: input.clientRegistrationId,
      idempotencyKey: input.idempotencyKey,
      merchantId: input.merchantId,
      requestDigest: settlementDigest({ owner, payload }),
      payload: () => payload,
    });
    return this.recoverOperation(owner, command.id);
  }
  async createPlan(
    owner: AppBillingOwner,
    input: CreateAppBillingPlanRequest | AdoptAppBillingPlanRequest,
  ) {
    const command = await appBillingAdminRepository.prepare(owner, {
      clientRegistrationId: input.clientRegistrationId,
      idempotencyKey: input.idempotencyKey,
      merchantId: input.merchantId,
      requestDigest: settlementDigest({ owner, input }),
      payload: (id) => ({
        version: 1,
        domain: "admin",
        clientRegistrationId: input.clientRegistrationId,
        planRevisionId: id,
        plan: input,
        ...("priceReference" in input
          ? {
              action: "plan_adopt" as const,
              priceReference: input.priceReference,
              productReference: input.productReference,
            }
          : { action: "plan_create" as const }),
      }),
    });
    return this.recoverOperation(owner, command.id);
  }
  paidPeriods(
    owner: AppBillingOwner,
    input: Parameters<GenericBillingRefundReadService["paidPeriods"]>[1],
  ) {
    return new GenericBillingRefundReadService(this.stripeForMode).paidPeriods(owner, input);
  }
  previewRefund(
    owner: AppBillingOwner,
    input: Parameters<GenericBillingRefundReadService["preview"]>[1],
  ) {
    return new GenericBillingRefundReadService(this.stripeForMode).preview(owner, input);
  }
  async refund(owner: AppBillingOwner, request: AppBillingRefundRequest) {
    const input = appBillingRefundRequestSchema.parse(request);
    const source = await writeTransaction((tx) => lockAppBillingRefundSource(tx, owner, input));
    const command = await appBillingAdminRepository.prepare(owner, {
      clientRegistrationId: input.clientRegistrationId,
      idempotencyKey: input.idempotencyKey,
      merchantId: source.merchant.merchantId,
      requestDigest: settlementDigest({ owner, input }),
      payload: async (_id, tx) => ({
        version: 1,
        domain: "admin",
        clientRegistrationId: input.clientRegistrationId,
        action: "refund",
        source: await lockAppBillingRefundSource(tx, owner, input),
        amountCents: input.amountCents,
        accessPolicy: input.accessPolicy,
      }),
    });
    return this.recoverOperation(owner, command.id);
  }
  private completed(owner: AppBillingOwner, command: BillingSubscriptionCommand) {
    if (command.provider_result?.kind === "refund")
      return readAppBillingRefund(owner, command, this.stripeForMode);
    return new GenericBillingAdminReadService().completed(owner, command);
  }
  async recoverOperation(
    owner: AppBillingOwner,
    commandId: string,
  ): Promise<AppBillingAdminOperation> {
    const claim = await appBillingAdminRepository.claim(owner, commandId);
    const command = claim.command;
    if (command.status === "SUCCEEDED") return this.completed(owner, command);
    if (!claim.leaseToken)
      return { id: command.id, status: "outcome_unknown", retryAfterSeconds: 90 };
    const payload = command.request_payload;
    if (payload?.domain !== "admin" || command.livemode === null)
      appBillingAdminFailure("Missing app administration intent");
    if (payload.action === "refund")
      return executeAppBillingRefund(owner, claim, this.stripeForMode);
    const stripe = await this.stripeForMode(command.livemode);
    const context = {
      appId: owner.appId,
      organizationId: owner.organizationId,
      livemode: command.livemode,
    };
    const provider = createGenericBillingAdminProvider(stripe, context);
    const intent: DurableProviderIntent = {
      commandId: command.id,
      idempotencyKey: command.provider_idempotency_key,
      requestDigest: command.request_digest,
    };
    const mayRepeat =
      command.provider_started_at !== null &&
      claim.databaseNow.getTime() - command.provider_started_at.getTime() < 23 * 60 * 60 * 1000;
    if (
      payload.action === "merchant_create" ||
      payload.action === "merchant_adopt" ||
      payload.action === "merchant_platform"
    ) {
      let accountId: string;
      if (payload.action === "merchant_create") {
        const found = await provider.findCreatedMerchant(intent);
        if (found === null && !mayRepeat)
          return { id: command.id, status: "outcome_unknown", retryAfterSeconds: 90 };
        accountId = found ?? (await provider.createMerchant(intent, payload.country));
      } else if (payload.action === "merchant_adopt")
        accountId = await writeTransaction(async (tx) => {
          await lockAppBillingOwner(tx, owner);
          return adminCreatorConnection(
            tx,
            owner,
            payload.creatorConnectionId,
            payload.providerAccountId,
          );
        });
      else {
        if (getCloudAwareEnv().STRIPE_PLATFORM_BILLING_ORGANIZATION_ID !== owner.organizationId)
          appBillingAdminFailure(
            "This organization is not registered as the first-party platform merchant",
            "FORBIDDEN",
          );
        accountId = await provider.platformAccountId();
      }
      const key = payload.action === "merchant_platform" ? "platform" : accountId;
      const existing = await writeTransaction(async (tx) => {
        await lockAppBillingOwner(tx, owner);
        const [row] = await tx
          .select()
          .from(billingMerchants)
          .where(
            and(
              eq(billingMerchants.provider_account_key, key),
              eq(billingMerchants.livemode, context.livemode),
            ),
          );
        if (row && row.organization_id !== owner.organizationId)
          appBillingAdminFailure(
            "Stripe merchant is already bound to another organization",
            "FORBIDDEN",
          );
        return row ?? null;
      });
      const merchant = {
        merchantId: existing?.id ?? command.id,
        kind: key === "platform" ? ("platform" as const) : ("connected" as const),
        stripeAccountId: accountId,
        livemode: context.livemode,
      };
      const observed = await createGenericBillingProvider(stripe, merchant).verifyMerchant();
      await appBillingAdminRepository.finish(
        owner,
        command,
        claim.leaseToken,
        observed.digest,
        async (tx) => {
          if (payload.action === "merchant_adopt")
            await adminCreatorConnection(
              tx,
              owner,
              payload.creatorConnectionId,
              payload.providerAccountId,
            );
          const enabled =
            observed.value.chargesEnabled &&
            observed.value.payoutsEnabled &&
            observed.value.cardPaymentsActive &&
            observed.value.disabledReason === null;
          const [row] = existing
            ? await tx
                .update(billingMerchants)
                .set({
                  stripe_account_id: accountId,
                  enabled: existing.disconnected_at === null && enabled,
                })
                .where(
                  and(
                    eq(billingMerchants.id, existing.id),
                    eq(billingMerchants.connection_revision, existing.connection_revision),
                  ),
                )
                .returning()
            : await tx
                .insert(billingMerchants)
                .values({
                  id: merchant.merchantId,
                  organization_id: owner.organizationId,
                  provider_account_key: key,
                  stripe_account_id: accountId,
                  livemode: context.livemode,
                  enabled,
                })
                .returning();
          if (!row) appBillingAdminFailure("Merchant changed while provider identity was verified");
          await recordMerchantVerification(tx, observed);
          return { result: { kind: "merchant", merchantId: row.id }, value: row.id };
        },
      );
    } else {
      const merchantId =
        payload.action === "merchant_onboarding" ? payload.merchantId : payload.plan.merchantId;
      const stored = await writeTransaction(async (tx) => {
        await lockAppBillingOwner(tx, owner);
        return adminMerchant(tx, owner, merchantId, context.livemode);
      });
      const merchant = appBillingProviderMerchant(stored);
      if (payload.action === "merchant_onboarding") {
        if (merchant.kind !== "connected")
          appBillingAdminFailure("Platform merchants use their existing Stripe account settings");
        // Reissuing an ephemeral onboarding link cannot create another merchant or charge.
        const action = await provider.onboarding(merchant, intent, payload);
        await appBillingAdminRepository.finish(
          owner,
          command,
          claim.leaseToken,
          settlementDigest(action),
          async () => ({ result: { kind: "merchant_onboarding", ...action }, value: action }),
        );
      } else {
        let binding;
        if (payload.action === "plan_adopt")
          binding = appPlanProviderBinding(
            payload.planRevisionId,
            payload.plan,
            payload.priceReference,
            payload.productReference,
          );
        else {
          const found = await provider.findCreatedPlan(merchant, intent, payload.planRevisionId);
          if (!found && !mayRepeat)
            return { id: command.id, status: "outcome_unknown", retryAfterSeconds: 90 };
          binding = found
            ? appPlanProviderBinding(
                payload.planRevisionId,
                payload.plan,
                found.priceId,
                found.productId,
              )
            : (await provider.createPlan(merchant, intent, payload.planRevisionId, payload.plan))
                .value;
        }
        const observed = await createGenericBillingProvider(stripe, merchant).verifyPlan(binding);
        await appBillingAdminRepository.finish(
          owner,
          command,
          claim.leaseToken,
          observed.digest,
          async (tx) => {
            const current = await adminMerchant(tx, owner, merchant.merchantId, context.livemode);
            if (current.connection_revision !== stored.connection_revision)
              appBillingAdminFailure("Merchant changed while plan terms were verified");
            const [last] = await tx
              .select({ revision: appBillingPlanRevisions.revision })
              .from(appBillingPlanRevisions)
              .where(
                and(
                  eq(appBillingPlanRevisions.app_id, owner.appId),
                  eq(appBillingPlanRevisions.product_family_key, payload.plan.productFamilyKey),
                  eq(appBillingPlanRevisions.plan_key, payload.plan.planKey),
                ),
              )
              .orderBy(desc(appBillingPlanRevisions.revision))
              .limit(1);
            const plan = payload.plan;
            await tx.insert(appBillingPlanRevisions).values({
              id: payload.planRevisionId,
              app_id: owner.appId,
              merchant_id: merchant.merchantId,
              product_family_key: plan.productFamilyKey,
              plan_key: plan.planKey,
              revision: (last?.revision ?? 0) + 1,
              name: plan.name,
              amount_cents: plan.amountCents,
              currency: plan.currency,
              interval: plan.interval,
              interval_count: plan.intervalCount,
              minimum_quantity: plan.seats.minimum,
              maximum_quantity: plan.seats.maximum,
              trial_days: 7,
              trial_allowance_usd: plan.trial.allowanceUsd,
              paid_allowance_usd: plan.allowanceUsd,
              expired_access: plan.expiredAccess,
              entitlements: { features: plan.featureKeys, ...plan.rateLimits },
              stripe_price_id: binding.priceId,
              stripe_product_id: binding.productId,
            });
            await recordCatalogVerification(tx, observed);
            return {
              result: { kind: "plan", planRevisionId: payload.planRevisionId },
              value: payload.planRevisionId,
            };
          },
        );
      }
    }
    const final = await appBillingAdminRepository.claim(owner, command.id);
    return this.completed(owner, final.command);
  }
  async refreshMerchant(owner: AppBillingOwner, input: AppBillingMerchantRequest) {
    const source = await writeTransaction(async (tx) => {
      await lockAppBillingOwner(tx, owner);
      const registration = await adminRegistration(tx, owner, input.clientRegistrationId);
      return adminMerchant(
        tx,
        owner,
        input.merchantId,
        registration.billing_environment === "live",
      );
    });
    const provider = createGenericBillingProvider(
      await this.stripeForMode(source.livemode),
      appBillingProviderMerchant(source),
    );
    const observed = await provider.verifyMerchant();
    return writeTransaction(async (tx) => {
      await lockAppBillingOwner(tx, owner);
      await adminRegistration(tx, owner, input.clientRegistrationId);
      const current = await adminMerchant(tx, owner, source.id, source.livemode);
      if (current.connection_revision !== source.connection_revision)
        appBillingAdminFailure("Merchant changed during capability refresh");
      await recordMerchantVerification(tx, observed);
      const [updated] = await tx
        .update(billingMerchants)
        .set({
          enabled:
            current.disconnected_at === null &&
            observed.value.chargesEnabled &&
            observed.value.payoutsEnabled &&
            observed.value.cardPaymentsActive &&
            observed.value.disabledReason === null,
        })
        .where(eq(billingMerchants.id, current.id))
        .returning();
      if (!updated) appBillingAdminFailure("Merchant refresh could not be persisted");
      return adminMerchantDto(tx, updated);
    });
  }
  async disconnectMerchant(owner: AppBillingOwner, input: DisconnectAppBillingMerchantRequest) {
    return writeTransaction(async (tx) => {
      await lockAppBillingOwner(tx, owner);
      const registration = await adminRegistration(tx, owner, input.clientRegistrationId);
      const merchant = await adminMerchant(
        tx,
        owner,
        input.merchantId,
        registration.billing_environment === "live",
      );
      if (String(merchant.connection_revision) !== input.expectedRevision)
        appBillingAdminFailure(
          "Merchant changed; review the current connection before disabling new sales",
        );
      const [updated] = await tx
        .update(billingMerchants)
        .set({ enabled: false, disconnected_at: sql`clock_timestamp()` })
        .where(eq(billingMerchants.id, merchant.id))
        .returning();
      if (!updated) appBillingAdminFailure("Merchant disconnection could not be persisted");
      const [count] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(billingSubscriptions)
        .innerJoin(appBillingScopes, eq(appBillingScopes.id, billingSubscriptions.billing_scope_id))
        .where(
          and(
            eq(appBillingScopes.merchant_id, merchant.id),
            inArray(billingSubscriptions.status, [
              "trialing",
              "active",
              "past_due",
              "unpaid",
              "paused",
              "incomplete",
            ]),
          ),
        );
      if (!count) appBillingAdminFailure("Historical subscription count is unavailable");
      return {
        merchant: await adminMerchantDto(tx, updated),
        activeSubscriptionCount: count.count,
        existingBillingContinues: true as const,
      };
    });
  }
  verifyPlan(owner: AppBillingOwner, input: AppBillingPlanRevisionRequest, publish = false) {
    return new GenericBillingCatalogAdministration(this.stripeForMode).verifyPlan(
      owner,
      input,
      publish,
    );
  }
  retirePlan(owner: AppBillingOwner, input: AppBillingPlanRevisionRequest) {
    return new GenericBillingCatalogAdministration(this.stripeForMode).retirePlan(owner, input);
  }
}
export const genericBillingAdminService = new GenericBillingAdminService();
