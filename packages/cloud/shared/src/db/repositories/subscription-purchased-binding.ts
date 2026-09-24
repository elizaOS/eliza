/** Reads an immutable purchased binding only through its completed checkout and subscription identity; historical subscriptions retain current catalog validation. */
import { and, eq } from "drizzle-orm";
import { renewalUnavailable } from "../../lib/services/stripe-paid-renewal-validation";
import { readCheckoutContract } from "../../lib/services/subscription-checkout-contract";
import type { Database, DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import type { BillingSubscription } from "../schemas/billing-subscriptions";
import { billingSubscriptionCommands } from "../schemas/subscription-billing-operations";

export async function findPurchasedSubscriptionContract(
  source: BillingSubscription,
  database: Database | DbTransaction = dbWrite,
) {
  const [command] = await database
    .select()
    .from(billingSubscriptionCommands)
    .where(
      and(
        eq(billingSubscriptionCommands.id, source.id),
        eq(billingSubscriptionCommands.organization_id, source.organization_id),
      ),
    );
  if (!command || command.checkout_contract === null) return null;
  const contract = readCheckoutContract(command);
  if (
    command.kind !== "checkout" ||
    command.status !== "APPLIED" ||
    command.result_subscription_id !== source.id ||
    command.subscription_id !== null ||
    contract.planKey !== source.plan_key ||
    contract.catalogVersion !== source.catalog_version ||
    contract.params.customer !== source.stripe_customer_id ||
    source.provider !== "stripe" ||
    contract.expectedLivemode !== (source.provider_environment === "live")
  )
    renewalUnavailable("purchased_binding_identity_mismatch");
  return contract;
}
