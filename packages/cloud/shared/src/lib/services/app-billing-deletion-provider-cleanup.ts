/** Reconciles canonically closed app scopes before their shared customer is removed. This service performs provider cleanup only; the saga must independently validate receipts before completing its Stripe phase. */
import { and, asc, eq } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { closeAppBillingCustomer } from "../../db/repositories/app-billing-customer-closures";
import { retainSharedAppBillingCustomer } from "../../db/repositories/app-billing-customer-retention";
import type { AppBillingDeletionRecoveryAuthority } from "../../db/repositories/app-billing-deletion-authority";
import { appBillingCustomers, appBillingScopes } from "../../db/schemas/app-billing";
import { appBillingDeletionDispositions } from "../../db/schemas/app-billing-deletion-dispositions";
import { logger } from "../utils/logger";
import { cancelClosedScopeSubscriptionForDeletion } from "./app-billing-deletion-cancellation";
import { deleteClosedAppBillingCustomer } from "./app-billing-deletion-customer";
import { getAppBillingProvider } from "./generic-billing-provider-runtime";

export async function reconcileClosedAppBillingProviders(
  authority: AppBillingDeletionRecoveryAuthority,
  resolveProvider = getAppBillingProvider,
): Promise<"complete" | "pending"> {
  const closed = await dbWrite
    .select({ scope: appBillingScopes })
    .from(appBillingDeletionDispositions)
    .innerJoin(appBillingScopes, eq(appBillingScopes.id, appBillingDeletionDispositions.scope_id))
    .where(
      and(
        eq(appBillingDeletionDispositions.request_id, authority.requestId),
        eq(appBillingDeletionDispositions.disposition, "close"),
      ),
    )
    .orderBy(asc(appBillingScopes.id));
  let pending = false;
  for (const { scope } of closed) {
    const result = await cancelClosedScopeSubscriptionForDeletion(
      scope.id,
      { ...authority, kind: "account_deletion_subscription_cancellation" },
      resolveProvider,
    );
    if (result !== "complete") pending = true;
  }
  if (pending) return "pending";
  const bindings = new Set<string>();
  for (const { scope } of closed) {
    const rows = await dbWrite
      .select({ id: appBillingCustomers.id })
      .from(appBillingCustomers)
      .where(
        and(
          eq(appBillingCustomers.billing_account_id, scope.billing_account_id),
          eq(appBillingCustomers.merchant_id, scope.merchant_id),
        ),
      );
    for (const row of rows) bindings.add(row.id);
  }
  for (const customerBindingId of [...bindings].sort()) {
    try {
      // This read chooses a path; its database guard revalidates all sharing decisions under locks.
      const [retained] = await dbWrite
        .select({ scopeId: appBillingScopes.id })
        .from(appBillingCustomers)
        .innerJoin(
          appBillingScopes,
          and(
            eq(appBillingScopes.billing_account_id, appBillingCustomers.billing_account_id),
            eq(appBillingScopes.merchant_id, appBillingCustomers.merchant_id),
          ),
        )
        .innerJoin(
          appBillingDeletionDispositions,
          eq(appBillingDeletionDispositions.scope_id, appBillingScopes.id),
        )
        .where(
          and(
            eq(appBillingCustomers.id, customerBindingId),
            eq(appBillingDeletionDispositions.request_id, authority.requestId),
            eq(appBillingDeletionDispositions.disposition, "retain_shared"),
          ),
        )
        .limit(1);
      if (retained) {
        await retainSharedAppBillingCustomer({ customerBindingId, authority });
        continue;
      }
      await closeAppBillingCustomer({ customerBindingId, authority });
      if (
        (await deleteClosedAppBillingCustomer(customerBindingId, authority, resolveProvider)) !==
        "complete"
      )
        pending = true;
    } catch (error) {
      // error-policy:J1 Canonical closure or provider failure remains an explicit pending recovery.
      logger.warn("[AppBillingDeletionCleanup] Customer cleanup remains unresolved", {
        customerBindingId,
        error,
      });
      pending = true;
    }
  }
  return pending ? "pending" : "complete";
}
