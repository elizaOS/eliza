/** Reads an immutable purchased binding only through its completed checkout and subscription identity; historical subscriptions retain current catalog validation. */
import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { assertOrganizationSubscription } from "../../lib/services/organization-subscription-source";
import { renewalUnavailable } from "../../lib/services/stripe-paid-renewal-validation";
import {
  checkoutContractEnvironment,
  readCheckoutContract,
} from "../../lib/services/subscription-checkout-contract";
import { proveReviewedPaidPlanBinding } from "../../lib/services/subscription-reviewed-plan-binding";
import { proveScheduledPaidPlanBinding } from "../../lib/services/subscription-scheduled-plan-binding";
import type { Database, DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import {
  type BillingSubscription,
  billingSubscriptionRevisions,
} from "../schemas/billing-subscriptions";
import { organizationPlanChangeQuotes } from "../schemas/organization-plan-change-quotes";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";
import { subscriptionAllowanceTransactions } from "../schemas/subscription-allowance-transactions";
import { billingSubscriptionCommands } from "../schemas/subscription-billing-operations";

async function findPurchasedSubscriptionContract(
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
    contract.catalogVersion !== source.catalog_version ||
    contract.params.customer !== source.stripe_customer_id ||
    source.provider !== "stripe" ||
    contract.expectedLivemode !== (source.provider_environment === "live")
  )
    renewalUnavailable("purchased_binding_identity_mismatch");
  return contract;
}

/** Retains original account authority while resolving current paid prices from immutable applied changes.
 * The caller must recheck the captured source under its publication transaction after provider I/O.
 */
export async function findSubscriptionRenewalBinding(
  source: BillingSubscription,
  configuredEnvironment: NodeJS.ProcessEnv,
  database: Database | DbTransaction = dbWrite,
) {
  assertOrganizationSubscription(source);
  if (!Number.isSafeInteger(source.lifecycle_revision) || source.lifecycle_revision < 1)
    renewalUnavailable("invalid_source_revision");
  const contract = await findPurchasedSubscriptionContract(source, database);
  const candidates = await database
    .select()
    .from(billingSubscriptionCommands)
    .where(
      and(
        eq(billingSubscriptionCommands.organization_id, source.organization_id),
        eq(billingSubscriptionCommands.subscription_id, source.id),
        inArray(billingSubscriptionCommands.kind, ["upgrade", "downgrade"]),
        eq(billingSubscriptionCommands.status, "APPLIED"),
        eq(billingSubscriptionCommands.target_plan_key, source.plan_key),
        isNull(billingSubscriptionCommands.app_id),
        isNull(billingSubscriptionCommands.billing_scope_id),
        lte(billingSubscriptionCommands.result_subscription_revision, source.lifecycle_revision),
      ),
    )
    .orderBy(desc(billingSubscriptionCommands.result_subscription_revision))
    .limit(2);
  const selected = candidates[0];
  if (selected) {
    if (
      selected.expected_subscription_revision === null ||
      selected.result_subscription_revision === null ||
      (candidates[1] &&
        candidates[1].result_subscription_revision === selected.result_subscription_revision)
    )
      renewalUnavailable("reviewed_paid_plan_binding_ambiguous");
    const [quote] = await database
      .select()
      .from(organizationPlanChangeQuotes)
      .where(
        and(
          eq(organizationPlanChangeQuotes.consumed_by_command_id, selected.id),
          eq(organizationPlanChangeQuotes.organization_id, source.organization_id),
        ),
      );
    if (!quote) renewalUnavailable("reviewed_paid_plan_quote_missing");
    const revisions = await database
      .select()
      .from(billingSubscriptionRevisions)
      .where(
        and(
          eq(billingSubscriptionRevisions.organization_id, source.organization_id),
          eq(billingSubscriptionRevisions.subscription_id, source.id),
          gte(billingSubscriptionRevisions.revision, selected.expected_subscription_revision),
          lte(billingSubscriptionRevisions.revision, source.lifecycle_revision),
        ),
      )
      .orderBy(asc(billingSubscriptionRevisions.revision));
    let binding: ReturnType<typeof proveReviewedPaidPlanBinding>;
    if (selected.kind === "downgrade") {
      const paid = revisions.find(
        (row) =>
          row.revision > selected.result_subscription_revision! &&
          row.plan_key === source.plan_key &&
          row.pending_plan_key === null,
      );
      if (!paid) renewalUnavailable("scheduled_target_not_paid");
      const funding = await database
        .select({ period: subscriptionAllowancePeriods, grant: subscriptionAllowanceTransactions })
        .from(subscriptionAllowancePeriods)
        .innerJoin(
          subscriptionAllowanceTransactions,
          and(
            eq(
              subscriptionAllowanceTransactions.allowance_period_id,
              subscriptionAllowancePeriods.id,
            ),
            eq(
              subscriptionAllowanceTransactions.organization_id,
              subscriptionAllowancePeriods.organization_id,
            ),
            eq(subscriptionAllowanceTransactions.kind, "grant"),
          ),
        )
        .where(
          and(
            eq(subscriptionAllowancePeriods.organization_id, source.organization_id),
            eq(subscriptionAllowancePeriods.subscription_id, source.id),
            eq(subscriptionAllowancePeriods.subscription_revision, paid.revision),
          ),
        );
      if (funding.length !== 1) renewalUnavailable("scheduled_target_paid_grant_missing");
      binding = proveScheduledPaidPlanBinding({
        source,
        command: selected,
        quote,
        revisions,
        ...funding[0]!,
      });
    } else binding = proveReviewedPaidPlanBinding({ source, command: selected, quote, revisions });
    return {
      contract,
      environment: {
        ...configuredEnvironment,
        ...(source.plan_key === "plus_monthly"
          ? {
              STRIPE_PLUS_MONTHLY_PRICE_ID: binding.targetPriceId,
              STRIPE_PLUS_PRODUCT_ID: binding.targetProductId,
            }
          : {
              STRIPE_PRO_MONTHLY_PRICE_ID: binding.targetPriceId,
              STRIPE_PRO_PRODUCT_ID: binding.targetProductId,
            }),
      },
    };
  }
  if (contract && contract.planKey !== source.plan_key)
    renewalUnavailable("purchased_binding_plan_change_unverified");
  return {
    contract,
    environment: contract
      ? checkoutContractEnvironment(contract, configuredEnvironment)
      : configuredEnvironment,
  };
}
