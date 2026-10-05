/** Freezes customer identity only after every sharing scope has a canonical close decision. Every call, including another request's replay, revalidates its current deletion lease; retained scopes require separate canonical decisions and never inherit closure from a sibling. */
import { ElizaError } from "@elizaos/core";
import { eq, sql } from "drizzle-orm";
import { writeTransaction } from "../helpers";
import { appBillingAccounts, appBillingCustomers, billingMerchants } from "../schemas/app-billing";
import { appBillingCustomerClosures } from "../schemas/app-billing-customer-closures";
import type { AppBillingDeletionRecoveryAuthority } from "./app-billing-deletion-authority";
import { appBillingConflict } from "./app-subscription-authority";

export async function closeAppBillingCustomer(input: {
  customerBindingId: string;
  authority: AppBillingDeletionRecoveryAuthority;
}) {
  if (input.authority.kind !== "account_deletion")
    appBillingConflict("Canonical deletion authority is required");
  try {
    return await writeTransaction(async (tx) => {
      const auth = input.authority;
      await tx.execute(
        sql`SELECT require_app_billing_customer_closure(${input.customerBindingId}::uuid,${auth.requestId}::uuid,${auth.requestDigest},${auth.lifecycleRevision}::bigint,${auth.phaseReceiptId}::uuid,${auth.phaseGeneration}::bigint)`,
      );
      const [source] = await tx
        .select({
          binding: appBillingCustomers,
          merchant: billingMerchants,
          appId: appBillingAccounts.app_id,
        })
        .from(appBillingCustomers)
        .innerJoin(billingMerchants, eq(billingMerchants.id, appBillingCustomers.merchant_id))
        .innerJoin(
          appBillingAccounts,
          eq(appBillingAccounts.id, appBillingCustomers.billing_account_id),
        )
        .where(eq(appBillingCustomers.id, input.customerBindingId));
      if (!source?.merchant.stripe_account_id)
        appBillingConflict("Customer closure lost its original merchant");
      await tx
        .insert(appBillingCustomerClosures)
        .values({
          customer_binding_id: source.binding.id,
          billing_account_id: source.binding.billing_account_id,
          app_id: source.appId,
          merchant_id: source.merchant.id,
          provider_account_key: source.merchant.provider_account_key,
          stripe_account_id: source.merchant.stripe_account_id,
          livemode: source.merchant.livemode,
          stripe_customer_id: source.binding.stripe_customer_id,
          initiating_request_id: auth.requestId,
          request_digest: auth.requestDigest,
          lifecycle_revision: auth.lifecycleRevision,
          phase_receipt_id: auth.phaseReceiptId,
          phase_generation: auth.phaseGeneration,
        })
        .onConflictDoNothing({ target: appBillingCustomerClosures.customer_binding_id });
      const [closure] = await tx
        .select()
        .from(appBillingCustomerClosures)
        .where(eq(appBillingCustomerClosures.customer_binding_id, input.customerBindingId));
      if (!closure) appBillingConflict("Customer closure identity was not persisted");
      return closure;
    });
  } catch (error) {
    // error-policy:J2 Preserve the database guard failure while exposing a typed closure boundary.
    throw new ElizaError("Customer closure requires current canonical decisions and lease", {
      code: "APP_BILLING_CUSTOMER_CLOSURE_REJECTED",
      cause: error,
      context: { customerBindingId: input.customerBindingId },
    });
  }
}
