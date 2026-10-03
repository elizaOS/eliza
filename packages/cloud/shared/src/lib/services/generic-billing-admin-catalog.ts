/** Verifies, publishes and retires immutable app plan revisions under current owner and merchant authority. */
import type { AppBillingPlanRevisionRequest } from "@elizaos/cloud-sdk/app-billing-admin";
import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { writeTransaction } from "../../db/helpers";
import {
  type AppBillingOwner,
  adminMerchant,
  adminPlanDto,
  adminRegistration,
  appBillingAdminFailure,
  lockAppBillingOwner,
  recordCatalogVerification,
  recordMerchantVerification,
} from "../../db/repositories/app-billing-admin";
import { appBillingPlanRevisions } from "../../db/schemas/app-billing";
import { createGenericBillingProvider } from "./generic-billing-provider";
import { appBillingProviderMerchant } from "./generic-billing-runtime-config";
import { settlementDigest } from "./settlement-digest";
export class GenericBillingCatalogAdministration {
  constructor(private readonly stripeForMode: (livemode: boolean) => Promise<Stripe>) {}
  async verifyPlan(owner: AppBillingOwner, input: AppBillingPlanRevisionRequest, publish = false) {
    const source = await writeTransaction(async (tx) => {
      await lockAppBillingOwner(tx, owner, publish);
      const registration = await adminRegistration(tx, owner, input.clientRegistrationId);
      const [plan] = await tx
        .select()
        .from(appBillingPlanRevisions)
        .where(
          and(
            eq(appBillingPlanRevisions.id, input.planRevisionId),
            eq(appBillingPlanRevisions.app_id, owner.appId),
          ),
        );
      if (!plan || plan.retired_at !== null)
        appBillingAdminFailure("Plan revision is unavailable for verification");
      const merchant = await adminMerchant(
        tx,
        owner,
        plan.merchant_id,
        registration.billing_environment === "live",
      );
      if (publish && !merchant.enabled)
        appBillingAdminFailure("Merchant is unavailable for new sales");
      return { plan, merchant };
    });
    const plan = source.plan;
    const binding = {
      planRevisionId: plan.id,
      priceId: plan.stripe_price_id,
      productId: plan.stripe_product_id,
      amountCents: plan.amount_cents,
      currency: plan.currency,
      interval: plan.interval,
      intervalCount: plan.interval_count,
      minimumQuantity: plan.minimum_quantity,
      maximumQuantity: plan.maximum_quantity,
      trialDays: 7 as const,
    };
    const provider = createGenericBillingProvider(
      await this.stripeForMode(source.merchant.livemode),
      appBillingProviderMerchant(source.merchant),
    );
    const merchantObserved = await provider.verifyMerchant();
    const observed = await provider.verifyPlan(binding);
    return writeTransaction(async (tx) => {
      await lockAppBillingOwner(tx, owner, publish);
      await adminRegistration(tx, owner, input.clientRegistrationId);
      const merchant = await adminMerchant(tx, owner, source.merchant.id, source.merchant.livemode);
      const [current] = await tx
        .select()
        .from(appBillingPlanRevisions)
        .where(eq(appBillingPlanRevisions.id, plan.id))
        .for("update");
      if (
        !current ||
        current.retired_at !== null ||
        settlementDigest(current) !== settlementDigest(plan) ||
        merchant.connection_revision !== source.merchant.connection_revision
      )
        appBillingAdminFailure("Plan or merchant changed while provider terms were verified");
      if (
        publish &&
        (!merchant.enabled ||
          !merchantObserved.value.chargesEnabled ||
          !merchantObserved.value.payoutsEnabled ||
          !merchantObserved.value.cardPaymentsActive ||
          merchantObserved.value.disabledReason !== null)
      )
        appBillingAdminFailure("Merchant is not ready to accept new subscriptions");
      await recordMerchantVerification(tx, merchantObserved);
      await recordCatalogVerification(tx, observed);
      if (publish && current.published_at === null) {
        const [published] = await tx
          .update(appBillingPlanRevisions)
          .set({ published_at: sql`clock_timestamp()` })
          .where(eq(appBillingPlanRevisions.id, current.id))
          .returning();
        if (!published) appBillingAdminFailure("Plan publication could not be persisted");
        return adminPlanDto(tx, published, merchant);
      }
      return adminPlanDto(tx, current, merchant);
    });
  }
  async retirePlan(owner: AppBillingOwner, input: AppBillingPlanRevisionRequest) {
    return writeTransaction(async (tx) => {
      await lockAppBillingOwner(tx, owner);
      const registration = await adminRegistration(tx, owner, input.clientRegistrationId);
      const [plan] = await tx
        .select()
        .from(appBillingPlanRevisions)
        .where(
          and(
            eq(appBillingPlanRevisions.id, input.planRevisionId),
            eq(appBillingPlanRevisions.app_id, owner.appId),
          ),
        )
        .for("update");
      if (!plan) appBillingAdminFailure("Plan revision is unavailable");
      const merchant = await adminMerchant(
        tx,
        owner,
        plan.merchant_id,
        registration.billing_environment === "live",
      );
      if (plan.retired_at !== null) return adminPlanDto(tx, plan, merchant);
      const [retired] = await tx
        .update(appBillingPlanRevisions)
        .set({ retired_at: sql`clock_timestamp()` })
        .where(eq(appBillingPlanRevisions.id, plan.id))
        .returning();
      if (!retired) appBillingAdminFailure("Plan retirement could not be persisted");
      return adminPlanDto(tx, retired, merchant);
    });
  }
}
