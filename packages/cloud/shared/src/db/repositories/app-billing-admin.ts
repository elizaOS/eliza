/** Serializes owner administration through existing billing commands and immutable provider observations. */
import { randomUUID } from "node:crypto";
import type { AppBillingAdminPlan, AppBillingMerchant } from "@elizaos/cloud-sdk/app-billing-admin";
import { ElizaError } from "@elizaos/core";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type {
  AdminBillingCommandPayload,
  AdminBillingCommandResult,
} from "../../lib/services/generic-billing-command-types";
import type {
  BillingProviderObservation,
  BillingProviderPlan,
} from "../../lib/services/generic-billing-provider-types";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import { appBillingPlanRevisions, billingMerchants } from "../schemas/app-billing";
import {
  type AppBillingMerchantVerification,
  appBillingCatalogVerifications,
  appBillingMerchantVerifications,
} from "../schemas/app-billing-verifications";
import { appClientRegistrations } from "../schemas/app-delegations";
import { apps } from "../schemas/apps";
import { organizations } from "../schemas/organizations";
import { stripeConnectAccounts } from "../schemas/stripe-connect-accounts";
import {
  type BillingSubscriptionCommand,
  billingSubscriptionCommands,
} from "../schemas/subscription-billing-operations";
import { users } from "../schemas/users";
export interface AppBillingOwner {
  appId: string;
  organizationId: string;
  userId: string;
}
export function appBillingAdminFailure(message: string, code = "CONFLICT"): never {
  throw new ElizaError(message, { code: `APP_BILLING_ADMIN_${code}` });
}
export async function lockAppBillingOwner(
  tx: DbTransaction,
  owner: AppBillingOwner,
  newSales = false,
) {
  const [organization] = await tx
    .select({
      id: organizations.id,
      active: organizations.is_active,
      state: organizations.account_lifecycle_state,
      fencedAt: organizations.paid_work_fenced_at,
    })
    .from(organizations)
    .where(eq(organizations.id, owner.organizationId))
    .for("update");
  const [app] = await tx
    .select({
      id: apps.id,
      name: apps.name,
      organizationId: apps.organization_id,
      active: apps.is_active,
      approved: apps.is_approved,
      review: apps.review_status,
    })
    .from(apps)
    .where(eq(apps.id, owner.appId))
    .for("update");
  const [user] = await tx
    .select({
      organizationId: users.organization_id,
      role: users.role,
      active: users.is_active,
      anonymous: users.is_anonymous,
      deletedAt: users.deleted_at,
      expiresAt: users.expires_at,
      lifecycleState: users.account_lifecycle_state,
      fencedAt: users.auth_fenced_at,
    })
    .from(users)
    .where(eq(users.id, owner.userId))
    .for("share");
  const clock = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
  const now = new Date(clock.rows[0].now);
  if (
    !organization ||
    !app ||
    !user ||
    app.organizationId !== owner.organizationId ||
    user.organizationId !== owner.organizationId ||
    !user.active ||
    user.anonymous ||
    user.deletedAt !== null ||
    user.lifecycleState !== "active" ||
    user.fencedAt !== null ||
    (user.expiresAt !== null && user.expiresAt <= now) ||
    !["owner", "admin"].includes(user.role)
  )
    appBillingAdminFailure(
      "Current app-owner organization administration is required",
      "FORBIDDEN",
    );
  if (
    newSales &&
    (!organization.active ||
      organization.state !== "active" ||
      organization.fencedAt !== null ||
      !app.active ||
      !app.approved ||
      app.review !== "approved")
  )
    appBillingAdminFailure(
      "This app is not approved and available for new subscription sales",
      "SALES_FENCED",
    );
  return { app, organization };
}
export async function adminRegistration(tx: DbTransaction, owner: AppBillingOwner, id: string) {
  const [row] = await tx
    .select()
    .from(appClientRegistrations)
    .where(
      and(
        eq(appClientRegistrations.id, id),
        eq(appClientRegistrations.app_id, owner.appId),
        eq(appClientRegistrations.owner_organization_id, owner.organizationId),
      ),
    )
    .for("share");
  if (!row || !row.is_active)
    appBillingAdminFailure("Current app client registration is required", "FORBIDDEN");
  return row;
}
export async function adminCreatorConnection(
  tx: DbTransaction,
  owner: AppBillingOwner,
  id: string,
  expectedAccountId: string | null = null,
) {
  const [row] = await tx
    .select({ accountId: stripeConnectAccounts.stripe_connect_account_id })
    .from(stripeConnectAccounts)
    .where(and(eq(stripeConnectAccounts.id, id), eq(stripeConnectAccounts.user_id, owner.userId)))
    .for("share");
  if (!row || (expectedAccountId !== null && row.accountId !== expectedAccountId))
    appBillingAdminFailure(
      "Creator connection is no longer owned by this actor with its original provider identity",
      "FORBIDDEN",
    );
  return row.accountId;
}
export async function adminMerchant(
  tx: DbTransaction,
  owner: AppBillingOwner,
  id: string,
  livemode: boolean,
) {
  const [row] = await tx
    .select()
    .from(billingMerchants)
    .where(
      and(
        eq(billingMerchants.id, id),
        eq(billingMerchants.organization_id, owner.organizationId),
        eq(billingMerchants.livemode, livemode),
      ),
    )
    .for("update");
  if (!row)
    appBillingAdminFailure(
      "Merchant is not owned by this app organization and environment",
      "FORBIDDEN",
    );
  return row;
}
export async function adminMerchantDto(
  tx: DbTransaction,
  row: typeof billingMerchants.$inferSelect,
): Promise<AppBillingMerchant> {
  const [observed] = await tx
    .select()
    .from(appBillingMerchantVerifications)
    .where(eq(appBillingMerchantVerifications.merchant_id, row.id))
    .orderBy(
      desc(appBillingMerchantVerifications.created_at),
      desc(appBillingMerchantVerifications.id),
    )
    .limit(1);
  const value = observed?.value;
  return {
    id: row.id,
    environment: row.livemode ? "live" : "test",
    kind: row.provider_account_key === "platform" ? "platform" : "connected",
    connectionStatus:
      row.disconnected_at !== null
        ? "disabled"
        : !value
          ? "pending"
          : value.chargesEnabled &&
              value.payoutsEnabled &&
              value.cardPaymentsActive &&
              value.disabledReason === null
            ? "ready"
            : "restricted",
    enabled: row.enabled,
    capabilities: value
      ? {
          charges: value.chargesEnabled,
          payouts: value.payoutsEnabled,
          cardPayments: value.cardPaymentsActive,
        }
      : null,
    requirementsDue: value ? value.requirementsDue : null,
    verifiedAt: observed ? observed.observed_at.toISOString() : null,
    revision: String(row.connection_revision),
  };
}
export async function adminPlanDto(
  tx: DbTransaction,
  row: typeof appBillingPlanRevisions.$inferSelect,
  merchant: typeof billingMerchants.$inferSelect,
): Promise<AppBillingAdminPlan> {
  const [observed] = await tx
    .select()
    .from(appBillingCatalogVerifications)
    .where(eq(appBillingCatalogVerifications.plan_revision_id, row.id))
    .orderBy(
      desc(appBillingCatalogVerifications.created_at),
      desc(appBillingCatalogVerifications.id),
    )
    .limit(1);
  return {
    id: row.id,
    appId: row.app_id,
    productFamilyKey: row.product_family_key,
    planKey: row.plan_key,
    name: row.name,
    revision: String(row.revision),
    amountCents: row.amount_cents,
    currency: row.currency,
    interval: row.interval,
    intervalCount: row.interval_count,
    seats: { minimum: row.minimum_quantity, maximum: row.maximum_quantity },
    trial: { days: 7, paymentMethodRequired: false, allowanceUsd: row.trial_allowance_usd },
    allowanceUsd: row.paid_allowance_usd,
    featureKeys: row.entitlements.features,
    expiredAccess: row.expired_access,
    merchantId: row.merchant_id,
    environment: merchant.livemode ? "live" : "test",
    state:
      row.retired_at !== null
        ? "retired"
        : row.published_at !== null
          ? "published"
          : observed
            ? "verified"
            : "draft",
    providerVerifiedAt: observed ? observed.observed_at.toISOString() : null,
    rateLimits: {
      completionsRpm: row.entitlements.completionsRpm,
      embeddingsRpm: row.entitlements.embeddingsRpm,
      standardRpm: row.entitlements.standardRpm,
      strictRpm: row.entitlements.strictRpm,
    },
  };
}
export async function recordMerchantVerification(
  tx: DbTransaction,
  observation: BillingProviderObservation<AppBillingMerchantVerification>,
) {
  await tx.insert(appBillingMerchantVerifications).values({
    merchant_id: observation.merchantId,
    livemode: observation.livemode,
    provider_account_id: observation.providerAccountId,
    value: observation.value,
    object_digest: observation.digest,
    input_digest: observation.inputDigest,
    api_version: observation.apiVersion,
    observed_at: new Date(observation.observedAt),
  });
}
export async function recordCatalogVerification(
  tx: DbTransaction,
  observation: BillingProviderObservation<BillingProviderPlan>,
) {
  await tx.insert(appBillingCatalogVerifications).values({
    merchant_id: observation.merchantId,
    plan_revision_id: observation.value.planRevisionId,
    livemode: observation.livemode,
    provider_account_id: observation.providerAccountId,
    value: observation.value,
    object_digest: observation.digest,
    input_digest: observation.inputDigest,
    api_version: observation.apiVersion,
    observed_at: new Date(observation.observedAt),
  });
}
export class AppBillingAdminRepository {
  async prepare(
    owner: AppBillingOwner,
    input: {
      clientRegistrationId: string;
      idempotencyKey: string;
      merchantId: string | null;
      requestDigest: string;
      payload: (
        id: string,
        tx: DbTransaction,
      ) => AdminBillingCommandPayload | Promise<AdminBillingCommandPayload>;
    },
  ) {
    return writeTransaction(async (tx) => {
      await lockAppBillingOwner(tx, owner);
      const registration = await adminRegistration(tx, owner, input.clientRegistrationId);
      const livemode = registration.billing_environment === "live";
      const [prior] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.app_id, owner.appId),
            eq(billingSubscriptionCommands.livemode, livemode),
            isNull(billingSubscriptionCommands.billing_scope_id),
            eq(billingSubscriptionCommands.idempotency_key, input.idempotencyKey),
          ),
        )
        .for("update");
      if (prior) {
        if (
          prior.request_digest !== input.requestDigest ||
          prior.requested_by_user_id !== owner.userId
        )
          appBillingAdminFailure(
            "This idempotency key belongs to another immutable administration request",
          );
        return prior;
      }
      const merchant = input.merchantId
        ? await adminMerchant(tx, owner, input.merchantId, livemode)
        : null;
      const id = randomUUID();
      const payload = await input.payload(id, tx);
      const [created] = await tx
        .insert(billingSubscriptionCommands)
        .values({
          id,
          app_id: owner.appId,
          livemode,
          merchant_id: merchant?.id ?? null,
          merchant_key: merchant?.provider_account_key ?? "platform",
          client_registration_id: registration.id,
          organization_id: owner.organizationId,
          requested_by_user_id: owner.userId,
          kind: payload.action,
          idempotency_key: input.idempotencyKey,
          provider_idempotency_key: `app-admin:${id}`,
          request_digest: input.requestDigest,
          request_payload: payload,
        })
        .returning();
      if (!created) appBillingAdminFailure("Administration command was not persisted");
      return created;
    });
  }
  async claim(owner: AppBillingOwner, id: string) {
    return writeTransaction(async (tx) => {
      await lockAppBillingOwner(tx, owner);
      const [command] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.id, id),
            eq(billingSubscriptionCommands.app_id, owner.appId),
            eq(billingSubscriptionCommands.organization_id, owner.organizationId),
            isNull(billingSubscriptionCommands.billing_scope_id),
          ),
        )
        .for("update");
      if (
        !command ||
        (command.requested_by_user_id !== owner.userId &&
          !(
            command.request_payload?.domain === "admin" &&
            command.request_payload.action === "refund"
          )) ||
        command.request_payload?.domain !== "admin" ||
        command.client_registration_id === null
      )
        appBillingAdminFailure("Administration operation is not owned by this actor", "FORBIDDEN");
      await adminRegistration(tx, owner, command.client_registration_id);
      const result = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
      const now = new Date(result.rows[0].now);
      if (command.status === "SUCCEEDED") return { command, leaseToken: null, databaseNow: now };
      if (command.status !== "PREPARED" && command.status !== "OUTCOME_UNKNOWN")
        appBillingAdminFailure("Administration operation is terminal");
      if (command.lease_expires_at !== null && command.lease_expires_at > now)
        return { command, leaseToken: null, databaseNow: now };
      const leaseToken = randomUUID();
      const [claimed] = await tx
        .update(billingSubscriptionCommands)
        .set({
          status: "OUTCOME_UNKNOWN",
          lease_token: leaseToken,
          lease_expires_at: new Date(now.getTime() + 90_000),
          provider_started_at: command.provider_started_at ?? now,
          execution_generation: command.execution_generation + 1,
          attempt_count: command.attempt_count + 1,
          state_revision: command.state_revision + 1,
          updated_at: now,
        })
        .where(eq(billingSubscriptionCommands.id, id))
        .returning();
      if (!claimed) appBillingAdminFailure("Administration operation could not be leased");
      return { command: claimed, leaseToken, databaseNow: now };
    });
  }
  async finish<T>(
    owner: AppBillingOwner,
    command: BillingSubscriptionCommand,
    leaseToken: string,
    digest: string,
    apply: (tx: DbTransaction) => Promise<{ result: AdminBillingCommandResult; value: T }>,
  ): Promise<T> {
    return writeTransaction(async (tx) => {
      await lockAppBillingOwner(tx, owner);
      if (command.client_registration_id === null)
        appBillingAdminFailure("Missing administrator client registration");
      await adminRegistration(tx, owner, command.client_registration_id);
      const [current] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(eq(billingSubscriptionCommands.id, command.id))
        .for("update");
      const clock = await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
      const now = new Date(clock.rows[0].now);
      if (
        !current ||
        current.status !== "OUTCOME_UNKNOWN" ||
        current.lease_token !== leaseToken ||
        current.execution_generation !== command.execution_generation ||
        current.lease_expires_at === null ||
        current.lease_expires_at <= now
      )
        appBillingAdminFailure("Administration provider result lost its durable execution lease");
      const applied = await apply(tx);
      await tx
        .update(billingSubscriptionCommands)
        .set({
          status: "SUCCEEDED",
          provider_response_digest: digest,
          provider_result: applied.result,
          completed_at: now,
          lease_token: null,
          lease_expires_at: null,
          state_revision: current.state_revision + 1,
          updated_at: now,
        })
        .where(eq(billingSubscriptionCommands.id, current.id));
      return applied.value;
    });
  }
}
export const appBillingAdminRepository = new AppBillingAdminRepository();
