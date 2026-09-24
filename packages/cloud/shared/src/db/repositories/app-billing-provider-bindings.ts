/** Resolves provider object ownership solely from durable app customer, subscription and command records. */
import { and, eq } from "drizzle-orm";
import type {
  BillingProviderBindingResolver,
  BillingProviderObjectBinding,
} from "../../lib/services/generic-billing-provider-types";
import { dbWrite } from "../helpers";
import {
  appBillingAccounts,
  appBillingCustomers,
  appBillingScopes,
  billingMerchants,
} from "../schemas/app-billing";
import { billingSubscriptions } from "../schemas/billing-subscriptions";
import { billingSubscriptionCommands } from "../schemas/subscription-billing-operations";
import { appBillingConflict } from "./app-subscription-authority";

export class AppBillingProviderBindings implements BillingProviderBindingResolver {
  async resolveBinding(
    input: Parameters<BillingProviderBindingResolver["resolveBinding"]>[0],
  ): Promise<BillingProviderObjectBinding | null> {
    const [merchant] = await dbWrite
      .select()
      .from(billingMerchants)
      .where(
        and(
          eq(billingMerchants.id, input.merchantId),
          eq(billingMerchants.livemode, input.livemode),
        ),
      );
    if (!merchant || merchant.stripe_account_id !== input.providerAccountId) return null;
    if (input.objectType === "customer") {
      const [binding] = await dbWrite
        .select({ appId: appBillingAccounts.app_id, billingAccountId: appBillingAccounts.id })
        .from(appBillingCustomers)
        .innerJoin(
          appBillingAccounts,
          eq(appBillingAccounts.id, appBillingCustomers.billing_account_id),
        )
        .where(
          and(
            eq(appBillingCustomers.merchant_id, input.merchantId),
            eq(appBillingCustomers.stripe_customer_id, input.objectId),
          ),
        );
      return binding ? { ...binding, scopeId: null } : null;
    }
    if (input.objectType === "subscription") {
      const [binding] = await dbWrite
        .select({
          scopeId: appBillingScopes.id,
          appId: appBillingScopes.app_id,
          billingAccountId: appBillingScopes.billing_account_id,
        })
        .from(billingSubscriptions)
        .innerJoin(appBillingScopes, eq(appBillingScopes.id, billingSubscriptions.billing_scope_id))
        .where(
          and(
            eq(appBillingScopes.merchant_id, input.merchantId),
            eq(appBillingScopes.livemode, input.livemode),
            eq(billingSubscriptions.stripe_subscription_id, input.objectId),
          ),
        );
      if (binding) return binding;
    }
    // A Checkout result may bind a subscription before its first lifecycle revision.
    // Only a response read from the already bound session may fill this command field.
    const commands = await dbWrite
      .select({
        result: billingSubscriptionCommands.provider_result,
        scopeId: appBillingScopes.id,
        appId: appBillingScopes.app_id,
        billingAccountId: appBillingScopes.billing_account_id,
      })
      .from(billingSubscriptionCommands)
      .innerJoin(
        appBillingScopes,
        eq(appBillingScopes.id, billingSubscriptionCommands.billing_scope_id),
      )
      .where(
        and(
          eq(appBillingScopes.merchant_id, input.merchantId),
          eq(appBillingScopes.livemode, input.livemode),
        ),
      );
    const matches = commands.filter(({ result }) => {
      if (!result) return false;
      if (input.objectType === "checkout.session")
        return result.kind === "checkout" && result.checkoutSessionId === input.objectId;
      return (
        (result.kind === "checkout" || result.kind === "completed") &&
        result.subscriptionId === input.objectId
      );
    });
    if (matches.length > 1 && matches.some((row) => row.scopeId !== matches[0]?.scopeId))
      appBillingConflict("Provider object has conflicting durable app bindings");
    const match = matches[0];
    return match
      ? { scopeId: match.scopeId, appId: match.appId, billingAccountId: match.billingAccountId }
      : null;
  }
}

export const appBillingProviderBindings = new AppBillingProviderBindings();
