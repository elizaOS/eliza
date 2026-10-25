/** Reads app billing obligations for the canonical deletion saga. This snapshot distinguishes shared purchaser accounts from developer-owned resources; mutations must recheck ownership under the deletion lease. */
import { and, eq, or, sql } from "drizzle-orm";
import { dbWrite } from "../helpers";
import {
  appBillingAccounts,
  appBillingCustomers,
  appBillingScopes,
  billingMerchants,
} from "../schemas/app-billing";

export interface AppBillingDeletionObligation {
  scopeId: string;
  appId: string;
  billingAccountId: string;
  merchantId: string;
  providerAccountKey: string;
  livemode: boolean;
  customerId: string | null;
  departingAdministrator: boolean;
  disposition: "developer_owned" | "shared_purchaser" | "purchaser_without_successor";
}

export async function readAppBillingDeletionObligations(input: {
  userId: string;
  organizationId: string;
  requestId?: string;
}): Promise<AppBillingDeletionObligation[]> {
  const memberOfAccount = sql<boolean>`EXISTS (
    SELECT 1 FROM app_billing_members member
    WHERE member.billing_account_id = ${appBillingAccounts.id}
      AND member.app_id = ${appBillingAccounts.app_id}
      AND member.user_id = ${input.userId} AND member.revoked_at IS NULL
      AND (member.livemode IS NULL OR member.livemode = ${appBillingScopes.livemode})
  )`;
  const originalPurchaser = sql<boolean>`EXISTS (
    SELECT 1 FROM billing_subscription_commands command
    WHERE command.billing_scope_id = ${appBillingScopes.id}
      AND command.app_id = ${appBillingScopes.app_id}
      AND command.organization_id = ${appBillingScopes.organization_id}
      AND command.merchant_id = ${appBillingScopes.merchant_id}
      AND command.livemode = ${appBillingScopes.livemode}
      AND command.requested_by_user_id = ${input.userId}
      AND command.request_payload->>'domain' = 'buyer'
  )`;
  const retainedRequestScope = input.requestId
    ? sql<boolean>`EXISTS (
        SELECT 1 FROM account_deletion_requests request
        WHERE request.id = ${input.requestId} AND request.user_id = ${input.userId}
          AND request.organization_id = ${input.organizationId}
          AND request.status = 'processing' AND request.irreversible_at IS NOT NULL
          AND (
            EXISTS (SELECT 1 FROM app_billing_deletion_dispositions disposition
              WHERE disposition.request_id = request.id
                AND disposition.scope_id = ${appBillingScopes.id}
                AND disposition.request_digest = request.request_digest
                AND disposition.lifecycle_revision = request.lifecycle_revision
                AND disposition.merchant_id = ${appBillingScopes.merchant_id}
                AND disposition.livemode = ${appBillingScopes.livemode})
            OR EXISTS (SELECT 1 FROM billing_subscription_commands cleanup
              WHERE cleanup.billing_scope_id = ${appBillingScopes.id}
                AND cleanup.app_id = ${appBillingScopes.app_id}
                AND cleanup.organization_id = ${appBillingScopes.organization_id}
                AND cleanup.merchant_id = ${appBillingScopes.merchant_id}
                AND cleanup.livemode = ${appBillingScopes.livemode}
                AND cleanup.requested_by_user_id = request.user_id
                AND cleanup.request_payload->>'domain' = 'account_deletion'
                AND cleanup.request_payload->>'requestId' = request.id::text
                AND cleanup.request_payload->>'requestDigest' = request.request_digest
                AND cleanup.request_payload->>'lifecycleRevision' = request.lifecycle_revision::text)
          )
      )`
    : sql<boolean>`false`;
  const departingAdministrator = sql<boolean>`EXISTS (
    SELECT 1 FROM app_billing_members member
    WHERE member.billing_account_id = ${appBillingAccounts.id}
      AND member.app_id = ${appBillingAccounts.app_id}
      AND member.user_id = ${input.userId}
      AND member.role = 'administrator' AND member.revoked_at IS NULL
      AND (member.livemode IS NULL OR member.livemode = ${appBillingScopes.livemode})
  )`;
  const otherAdministrator = sql<boolean>`EXISTS (
    SELECT 1 FROM app_billing_members member
    JOIN users administrator ON administrator.id = member.user_id
    WHERE member.billing_account_id = ${appBillingAccounts.id}
      AND member.app_id = ${appBillingAccounts.app_id}
      AND member.user_id <> ${input.userId}
      AND member.role = 'administrator' AND member.revoked_at IS NULL
      AND (member.livemode IS NULL OR member.livemode = ${appBillingScopes.livemode})
      AND administrator.is_active = true AND administrator.deleted_at IS NULL
      AND administrator.account_lifecycle_state = 'active'
      AND administrator.auth_fenced_at IS NULL
      AND (administrator.expires_at IS NULL OR
        (isfinite(administrator.expires_at) AND
          (administrator.expires_at AT TIME ZONE 'UTC') > clock_timestamp()))
  )`;
  const rows = await dbWrite
    .select({
      scopeId: appBillingScopes.id,
      appId: appBillingScopes.app_id,
      billingAccountId: appBillingAccounts.id,
      merchantId: billingMerchants.id,
      providerAccountKey: billingMerchants.provider_account_key,
      livemode: appBillingScopes.livemode,
      customerId: appBillingCustomers.stripe_customer_id,
      organizationId: appBillingScopes.organization_id,
      otherAdministrator,
      departingAdministrator,
    })
    .from(appBillingScopes)
    .innerJoin(
      appBillingAccounts,
      and(
        eq(appBillingAccounts.id, appBillingScopes.billing_account_id),
        eq(appBillingAccounts.app_id, appBillingScopes.app_id),
      ),
    )
    .innerJoin(
      billingMerchants,
      and(
        eq(billingMerchants.id, appBillingScopes.merchant_id),
        eq(billingMerchants.organization_id, appBillingScopes.organization_id),
        eq(billingMerchants.livemode, appBillingScopes.livemode),
      ),
    )
    .leftJoin(
      appBillingCustomers,
      and(
        eq(appBillingCustomers.billing_account_id, appBillingAccounts.id),
        eq(appBillingCustomers.merchant_id, billingMerchants.id),
      ),
    )
    .where(
      or(
        eq(appBillingScopes.organization_id, input.organizationId),
        sql<boolean>`EXISTS (SELECT 1 FROM billing_identity_subjects identity
          WHERE identity.live_user_id = ${input.userId}
            AND identity.eligibility_principal_id = ${appBillingAccounts.eligibility_principal_id})`,
        memberOfAccount,
        originalPurchaser,
        retainedRequestScope,
      ),
    )
    .orderBy(appBillingScopes.id);
  return rows.map(({ organizationId, otherAdministrator, ...row }) => ({
    ...row,
    disposition:
      organizationId === input.organizationId
        ? "developer_owned"
        : otherAdministrator
          ? "shared_purchaser"
          : "purchaser_without_successor",
  }));
}
