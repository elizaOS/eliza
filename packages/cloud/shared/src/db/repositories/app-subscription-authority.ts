/** Resolves app billing ownership and durably prepares commands and trial eligibility before provider I/O. */
import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { validateAppBillingReturnUrl } from "../../lib/services/app-billing-return-url";
import type { BuyerBillingCommandPayload } from "../../lib/services/generic-billing-command-types";
import { settlementDigest } from "../../lib/services/settlement-digest";
import type { DbTransaction } from "../client";
import { dbWrite, writeTransaction } from "../helpers";
import {
  type AppBillingPlanRevision,
  type AppTrialClaim,
  appBillingAccounts,
  appBillingCustomers,
  appBillingMembers,
  appBillingPlanRevisions,
  appBillingScopes,
  appSubscriptionTrials,
  billingMerchants,
} from "../schemas/app-billing";
import { appClientRegistrations } from "../schemas/app-delegations";
import { apps } from "../schemas/apps";
import { billingSubscriptions } from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import {
  type BillingSubscriptionCommandKind,
  billingSubscriptionCommands,
} from "../schemas/subscription-billing-operations";
import { users } from "../schemas/users";
import type { AppCommandLease } from "./app-billing-command-runtime";
import { requireAppBillingDeletionRecovery } from "./app-billing-deletion-authority";
import { appBillingMembershipEnvironment } from "./app-billing-membership-scope";
import { consumeAppBillingQuote } from "./app-billing-update-quotes";
import { ensureBillingIdentitySubject } from "./billing-identities";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export interface ScopedBillingContext {
  scopeId: string;
  appId: string;
  billingAccountId: string;
  organizationId: string;
  merchantId: string;
  merchantKey: string;
  livemode: boolean;
  productFamilyKey: string;
  eligibilityPrincipalId: string;
  stripeCustomerId: string | null;
  /** Account, app, or developer suspension denies existing subscription access. */
  fenced: boolean;
  /** Sales additionally require an enabled merchant; existing provider obligations remain reconcilable. */
  salesFenced: boolean;
}

export interface PrepareAppSubscriptionCommand {
  payload: BuyerBillingCommandPayload;
  /** Resolve server-owned return configuration only for a newly persisted command. */
  registeredBillingReturn?: true;
  clientRegistrationId?: string | null;
  scopeId: string;
  actorUserId: string;
  kind: BillingSubscriptionCommandKind;
  targetPlanRevisionId: string | null;
  quantity: number;
  idempotencyKey: string;
  requestDigest: string;
  expectedSubscriptionRevision: number | null;
}

export function appBillingConflict(message: string): never {
  throw new ElizaError(message, { code: "APP_BILLING_AUTHORITY_CONFLICT", severity: "fatal" });
}

export async function lockAppBillingScope(
  tx: DbTransaction,
  scopeId: string,
  allowFenced = false,
): Promise<ScopedBillingContext> {
  const [scope] = await tx
    .select()
    .from(appBillingScopes)
    .where(eq(appBillingScopes.id, scopeId))
    .limit(1);
  if (!scope) appBillingConflict("App billing scope is unavailable");
  const [organization] = await tx
    .select({
      id: organizations.id,
      state: organizations.account_lifecycle_state,
      active: organizations.is_active,
      fencedAt: organizations.paid_work_fenced_at,
    })
    .from(organizations)
    .where(eq(organizations.id, scope.organization_id))
    .for("update");
  const [locked] = await tx
    .select()
    .from(appBillingScopes)
    .where(eq(appBillingScopes.id, scopeId))
    .for("update");
  const [account] = await tx
    .select()
    .from(appBillingAccounts)
    .where(
      and(
        eq(appBillingAccounts.id, scope.billing_account_id),
        eq(appBillingAccounts.app_id, scope.app_id),
      ),
    )
    .for("update");
  const [app] = await tx
    .select({
      id: apps.id,
      organizationId: apps.organization_id,
      active: apps.is_active,
      approved: apps.is_approved,
      reviewStatus: apps.review_status,
    })
    .from(apps)
    .where(eq(apps.id, scope.app_id));
  const [merchant] = await tx
    .select()
    .from(billingMerchants)
    .where(eq(billingMerchants.id, scope.merchant_id));
  if (
    !organization ||
    !locked ||
    !account ||
    !app ||
    !merchant ||
    app.organizationId !== scope.organization_id ||
    merchant.organization_id !== scope.organization_id
  )
    appBillingConflict("App billing owner, account or merchant scope is inconsistent");
  const fenced =
    !app.active ||
    !app.approved ||
    app.reviewStatus !== "approved" ||
    account.deleted_at !== null ||
    locked.fenced_at !== null ||
    !organization.active ||
    organization.state !== "active" ||
    organization.fencedAt !== null;
  const salesFenced = fenced || !merchant.enabled || merchant.disconnected_at !== null;
  if (salesFenced && !allowFenced)
    appBillingConflict("New app billing operations are fenced or unavailable");
  const [customer] = await tx
    .select()
    .from(appBillingCustomers)
    .where(
      and(
        eq(appBillingCustomers.billing_account_id, account.id),
        eq(appBillingCustomers.merchant_id, merchant.id),
      ),
    );
  return {
    scopeId,
    appId: app.id,
    billingAccountId: account.id,
    organizationId: organization.id,
    merchantId: merchant.id,
    merchantKey: merchant.provider_account_key,
    livemode: merchant.livemode,
    productFamilyKey: scope.product_family_key,
    eligibilityPrincipalId: account.eligibility_principal_id,
    stripeCustomerId: customer?.stripe_customer_id ?? null,
    fenced,
    salesFenced,
  };
}

export async function requireAppBillingAdministrator(
  tx: DbTransaction,
  scope: ScopedBillingContext,
  userId: string,
): Promise<{ newWorkAllowed: boolean }> {
  const [principal] = await tx
    .select({
      id: users.id,
      active: users.is_active,
      deletedAt: users.deleted_at,
      lifecycleState: users.account_lifecycle_state,
      fencedAt: users.auth_fenced_at,
      expiresAt: users.expires_at,
    })
    .from(users)
    .where(eq(users.id, userId))
    .for("update");
  const [membership] = await tx
    .select({ id: appBillingMembers.id })
    .from(appBillingMembers)
    .where(
      and(
        eq(appBillingMembers.billing_account_id, scope.billingAccountId),
        eq(appBillingMembers.app_id, scope.appId),
        eq(appBillingMembers.user_id, userId),
        eq(appBillingMembers.role, "administrator"),
        isNull(appBillingMembers.revoked_at),
        appBillingMembershipEnvironment(scope.livemode),
      ),
    )
    .for("update");
  if (!principal?.active || principal.deletedAt || !membership)
    appBillingConflict("Current app billing administrator authority is required");
  const now = await readPostLockDatabaseNow(tx);
  return {
    newWorkAllowed:
      principal.lifecycleState === "active" &&
      principal.fencedAt === null &&
      (principal.expiresAt === null || principal.expiresAt > now),
  };
}

export async function planForScope(
  tx: DbTransaction,
  scope: ScopedBillingContext,
  planRevisionId: string,
): Promise<AppBillingPlanRevision> {
  const [plan] = await tx
    .select()
    .from(appBillingPlanRevisions)
    .where(
      and(
        eq(appBillingPlanRevisions.id, planRevisionId),
        eq(appBillingPlanRevisions.app_id, scope.appId),
        eq(appBillingPlanRevisions.merchant_id, scope.merchantId),
        eq(appBillingPlanRevisions.product_family_key, scope.productFamilyKey),
      ),
    )
    .limit(1);
  if (!plan || !plan.published_at || plan.retired_at || plan.trial_days !== 7)
    appBillingConflict("Published plan does not belong to this app billing scope");
  return plan;
}

export class AppSubscriptionAuthorityRepository {
  async createAccount(input: {
    appId: string;
    externalAccountKey: string;
    displayName: string;
    principalUserId: string;
    externalReference?: string | null;
  }) {
    return writeTransaction(async (tx) => {
      const [app] = await tx
        .select({ id: apps.id, active: apps.is_active })
        .from(apps)
        .where(eq(apps.id, input.appId));
      const [user] = await tx
        .select({
          id: users.id,
          active: users.is_active,
          deletedAt: users.deleted_at,
          anonymous: users.is_anonymous,
        })
        .from(users)
        .where(eq(users.id, input.principalUserId))
        .for("update");
      if (!app?.active || !user?.active || user.deletedAt || user.anonymous)
        appBillingConflict("App billing account requires an active app and verified principal");
      if (!input.externalAccountKey.trim() || input.externalAccountKey.length > 200)
        appBillingConflict("App billing account key is invalid");
      const identity = await ensureBillingIdentitySubject(tx, input.principalUserId);
      await tx
        .insert(appBillingAccounts)
        .values({
          app_id: input.appId,
          external_account_key: input.externalAccountKey,
          display_name: input.displayName,
          external_reference: input.externalReference ?? null,
          eligibility_principal_id: identity.eligibility_principal_id,
        })
        .onConflictDoNothing();
      const [account] = await tx
        .select()
        .from(appBillingAccounts)
        .where(
          and(
            eq(appBillingAccounts.app_id, input.appId),
            eq(appBillingAccounts.external_account_key, input.externalAccountKey),
          ),
        )
        .for("update");
      if (
        !account ||
        account.deleted_at ||
        account.eligibility_principal_id !== identity.eligibility_principal_id ||
        account.external_reference !== (input.externalReference ?? null)
      )
        appBillingConflict("App account identity conflicts with existing ownership");
      await tx
        .insert(appBillingMembers)
        .values({
          app_id: input.appId,
          billing_account_id: account.id,
          user_id: input.principalUserId,
          role: "administrator",
        })
        .onConflictDoNothing();
      return account;
    });
  }

  async resolveScope(input: {
    appId: string;
    billingAccountId: string;
    productFamilyKey: string;
    merchantId: string;
    actorUserId: string;
  }): Promise<ScopedBillingContext> {
    return writeTransaction(async (tx) => {
      const [app] = await tx
        .select({ id: apps.id, organizationId: apps.organization_id })
        .from(apps)
        .where(eq(apps.id, input.appId));
      if (!app) appBillingConflict("Registered app is unavailable");
      const [merchant] = await tx
        .select()
        .from(billingMerchants)
        .where(eq(billingMerchants.id, input.merchantId));
      if (!merchant) appBillingConflict("Registered billing merchant is unavailable");
      await tx
        .insert(appBillingScopes)
        .values({
          app_id: input.appId,
          organization_id: app.organizationId,
          billing_account_id: input.billingAccountId,
          merchant_id: input.merchantId,
          livemode: merchant.livemode,
          product_family_key: input.productFamilyKey,
        })
        .onConflictDoNothing();
      const [row] = await tx
        .select({ id: appBillingScopes.id, merchantId: appBillingScopes.merchant_id })
        .from(appBillingScopes)
        .where(
          and(
            eq(appBillingScopes.app_id, input.appId),
            eq(appBillingScopes.billing_account_id, input.billingAccountId),
            eq(appBillingScopes.product_family_key, input.productFamilyKey),
            eq(appBillingScopes.livemode, merchant.livemode),
          ),
        );
      if (!row || row.merchantId !== input.merchantId)
        appBillingConflict("App billing scope merchant is immutable");
      const scope = await lockAppBillingScope(tx, row.id);
      await requireAppBillingAdministrator(tx, scope, input.actorUserId);
      return scope;
    });
  }

  async getScope(input: {
    appId: string;
    billingAccountId: string;
    productFamilyKey: string;
    livemode: boolean;
  }): Promise<ScopedBillingContext> {
    return writeTransaction(async (tx) => {
      const [row] = await tx
        .select({ id: appBillingScopes.id })
        .from(appBillingScopes)
        .where(
          and(
            eq(appBillingScopes.app_id, input.appId),
            eq(appBillingScopes.billing_account_id, input.billingAccountId),
            eq(appBillingScopes.product_family_key, input.productFamilyKey),
            eq(appBillingScopes.livemode, input.livemode),
          ),
        );
      if (!row) appBillingConflict("App billing scope is unavailable");
      return lockAppBillingScope(tx, row.id, true);
    });
  }

  async listPublishedPlans(appId: string): Promise<AppBillingPlanRevision[]> {
    return dbWrite
      .select()
      .from(appBillingPlanRevisions)
      .where(
        and(eq(appBillingPlanRevisions.app_id, appId), isNull(appBillingPlanRevisions.retired_at)),
      )
      .then((plans) => plans.filter((plan) => plan.published_at !== null));
  }

  async getHistoricalPlan(input: {
    appId: string;
    planRevisionId: string;
  }): Promise<AppBillingPlanRevision> {
    const [plan] = await dbWrite
      .select()
      .from(appBillingPlanRevisions)
      .where(
        and(
          eq(appBillingPlanRevisions.app_id, input.appId),
          eq(appBillingPlanRevisions.id, input.planRevisionId),
        ),
      );
    if (!plan || !plan.published_at) appBillingConflict("Historical app plan is unavailable");
    return plan;
  }

  async getPlan(input: { appId: string; planRevisionId: string }): Promise<AppBillingPlanRevision> {
    const [plan] = await dbWrite
      .select()
      .from(appBillingPlanRevisions)
      .where(
        and(
          eq(appBillingPlanRevisions.app_id, input.appId),
          eq(appBillingPlanRevisions.id, input.planRevisionId),
        ),
      );
    if (!plan || !plan.published_at || plan.retired_at)
      appBillingConflict("Published app plan is unavailable");
    return plan;
  }

  async prepareCommand(input: PrepareAppSubscriptionCommand) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.idempotencyKey) ||
      !/^[0-9a-f]{64}$/.test(input.requestDigest)
    )
      appBillingConflict("Command identity is invalid");
    if (
      !Number.isSafeInteger(input.quantity) ||
      input.quantity < 1 ||
      !Number.isSafeInteger(input.expectedSubscriptionRevision ?? 0)
    )
      appBillingConflict("Command quantity or revision is invalid");
    return writeTransaction(async (tx) => {
      const scope = await lockAppBillingScope(tx, input.scopeId, true);
      const administrator = await requireAppBillingAdministrator(tx, scope, input.actorUserId);
      const [subscription] = await tx
        .select()
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.billing_scope_id, scope.scopeId),
            inArray(billingSubscriptions.status, [
              "pending",
              "incomplete",
              "trialing",
              "active",
              "grace",
              "past_due",
              "unpaid",
              "paused",
            ]),
          ),
        )
        .for("update");
      const [existing] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.billing_scope_id, scope.scopeId),
            eq(billingSubscriptionCommands.idempotency_key, input.idempotencyKey),
          ),
        )
        .for("update");
      if (existing) {
        let replayPayload = input.payload;
        // Return configuration is server-owned; replay compares purchaser intent while retaining the original provider parameters.
        if (input.registeredBillingReturn) {
          const original = existing.request_payload;
          if (
            original?.domain === "buyer" &&
            original.action === "checkout" &&
            replayPayload.action === "checkout"
          )
            replayPayload = {
              ...replayPayload,
              successUrl: original.successUrl,
              cancelUrl: original.cancelUrl,
            };
          else if (
            original?.domain === "buyer" &&
            original.action === "portal" &&
            replayPayload.action === "portal"
          )
            replayPayload = { ...replayPayload, returnUrl: original.returnUrl };
        }
        if (
          existing.request_digest !== input.requestDigest ||
          existing.requested_by_user_id !== input.actorUserId ||
          existing.kind !== input.kind ||
          existing.target_plan_revision_id !== input.targetPlanRevisionId ||
          existing.target_quantity !== input.quantity ||
          (input.payload !== undefined &&
            settlementDigest(existing.request_payload) !== settlementDigest(replayPayload)) ||
          (input.clientRegistrationId !== undefined &&
            existing.client_registration_id !== input.clientRegistrationId)
        )
          appBillingConflict("Command replay changes immutable intent");
        return existing;
      }
      try {
        if (!administrator.newWorkAllowed)
          appBillingConflict("The purchaser account cannot start new billing work");
        const plan = input.targetPlanRevisionId
          ? await planForScope(tx, scope, input.targetPlanRevisionId)
          : null;
        if (
          plan &&
          (input.quantity < plan.minimum_quantity || input.quantity > plan.maximum_quantity)
        )
          appBillingConflict("Quantity is outside this plan's supported seat range");
        if (scope.salesFenced && !["cancel", "portal", "expire_checkout"].includes(input.kind))
          appBillingConflict("New app billing operations are fenced");
        if (
          (!["portal", "expire_checkout"].includes(input.kind) &&
            (input.kind === "checkout") !== !subscription) ||
          (input.kind === "checkout" && (!plan || input.expectedSubscriptionRevision !== null)) ||
          (subscription && subscription.lifecycle_revision !== input.expectedSubscriptionRevision)
        )
          appBillingConflict("Command does not match current subscription revision");
        let payload = input.payload;
        if (
          input.registeredBillingReturn &&
          input.clientRegistrationId !== null &&
          input.clientRegistrationId !== undefined
        ) {
          const [registration] = await tx
            .select({
              client: appClientRegistrations,
              app: { allowed_origins: apps.allowed_origins, app_url: apps.app_url },
            })
            .from(appClientRegistrations)
            .innerJoin(apps, eq(apps.id, appClientRegistrations.app_id))
            .where(
              and(
                eq(appClientRegistrations.id, input.clientRegistrationId),
                eq(appClientRegistrations.app_id, scope.appId),
                eq(appClientRegistrations.owner_organization_id, scope.organizationId),
                eq(appClientRegistrations.billing_environment, scope.livemode ? "live" : "test"),
                eq(appClientRegistrations.is_active, true),
                eq(apps.is_active, true),
                eq(apps.is_approved, true),
              ),
            )
            .for("share");
          if (!registration)
            appBillingConflict(
              "Billing return registration is unavailable for this app and environment",
            );
          if (registration.client.billing_return_url !== null) {
            const destination = validateAppBillingReturnUrl(
              registration.client.billing_return_url,
              new Set(
                [...registration.app.allowed_origins, registration.app.app_url].map(
                  (value) => new URL(value).origin,
                ),
              ),
            );
            if (payload.action === "checkout")
              payload = { ...payload, successUrl: destination, cancelUrl: destination };
            else if (payload.action === "portal") payload = { ...payload, returnUrl: destination };
            else appBillingConflict("This billing command does not accept a return destination");
          }
        }
        const id = randomUUID();
        const [command] = await tx
          .insert(billingSubscriptionCommands)
          .values({
            id,
            app_id: scope.appId,
            livemode: scope.livemode,
            merchant_id: scope.merchantId,
            request_payload: payload,
            client_registration_id: input.clientRegistrationId ?? null,
            organization_id: scope.organizationId,
            billing_scope_id: scope.scopeId,
            merchant_key: scope.merchantKey,
            subscription_id: subscription?.id ?? null,
            requested_by_user_id: input.actorUserId,
            kind: input.kind,
            target_plan_key: plan?.plan_key ?? null,
            target_plan_revision_id: plan?.id ?? null,
            target_quantity: input.quantity,
            expected_subscription_revision: input.expectedSubscriptionRevision,
            idempotency_key: input.idempotencyKey,
            provider_idempotency_key: `app-subscription:${id}`,
            request_digest: input.requestDigest,
          })
          .returning();
        if (!command) appBillingConflict("Command persistence returned no record");
        if (input.payload.action === "update") {
          if (!subscription || !plan)
            appBillingConflict("Update quote requires a current subscription");
          await consumeAppBillingQuote(tx, {
            quoteId: input.payload.quoteId,
            scopeId: scope.scopeId,
            actorUserId: input.actorUserId,
            commandId: command.id,
            subscriptionId: subscription.id,
            subscriptionRevision: subscription.lifecycle_revision,
            planRevisionId: plan.id,
            quantity: input.quantity,
          });
        }
        return command;
      } catch (error) {
        // error-policy:J2 no prior command exists and this transaction rolls back before provider dispatch.
        if (error instanceof ElizaError && error.code === "APP_BILLING_AUTHORITY_CONFLICT")
          throw new ElizaError(error.message, {
            code: "APP_BILLING_COMMAND_NOT_APPLIED",
            cause: error,
            context: { scopeId: scope.scopeId, idempotencyKey: input.idempotencyKey },
          });
        throw error;
      }
    });
  }

  async beginCommand(input: {
    scopeId: string;
    commandId: string;
    actorUserId: string;
    expectedStateRevision: number;
    expectedExecutionGeneration: number;
  }) {
    return writeTransaction(async (tx) => {
      const scope = await lockAppBillingScope(tx, input.scopeId, true);
      const administrator = await requireAppBillingAdministrator(tx, scope, input.actorUserId);
      if (!administrator.newWorkAllowed)
        appBillingConflict("The purchaser account was fenced before provider dispatch");
      const [command] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.id, input.commandId),
            eq(billingSubscriptionCommands.billing_scope_id, input.scopeId),
          ),
        )
        .for("update");
      if (
        !command ||
        command.requested_by_user_id !== input.actorUserId ||
        command.status !== "PREPARED" ||
        command.state_revision !== input.expectedStateRevision ||
        command.execution_generation !== input.expectedExecutionGeneration
      )
        appBillingConflict("Command execution revision is stale");
      if (scope.salesFenced && command.kind !== "cancel")
        appBillingConflict("New sales are fenced");
      const now = await readPostLockDatabaseNow(tx);
      const [started] = await tx
        .update(billingSubscriptionCommands)
        .set({
          status: "OUTCOME_UNKNOWN",
          state_revision: command.state_revision + 1,
          execution_generation: command.execution_generation + 1,
          attempt_count: command.attempt_count + 1,
          provider_started_at: now,
          updated_at: now,
        })
        .where(eq(billingSubscriptionCommands.id, command.id))
        .returning();
      if (!started) appBillingConflict("Command execution returned no record");
      return started;
    });
  }

  async claimTrial(input: {
    scopeId: string;
    commandId: string;
    planRevisionId: string;
  }): Promise<AppTrialClaim> {
    return writeTransaction(async (tx) => {
      const scope = await lockAppBillingScope(tx, input.scopeId);
      const plan = await planForScope(tx, scope, input.planRevisionId);
      const [command] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.id, input.commandId),
            eq(billingSubscriptionCommands.billing_scope_id, scope.scopeId),
          ),
        )
        .for("update");
      if (
        !command ||
        command.kind !== "checkout" ||
        command.target_plan_revision_id !== plan.id ||
        !["PREPARED", "OUTCOME_UNKNOWN"].includes(command.status)
      )
        appBillingConflict("Trial requires the original durable checkout command");
      const [existing] = await tx
        .select()
        .from(appSubscriptionTrials)
        .where(
          and(
            eq(appSubscriptionTrials.app_id, scope.appId),
            eq(appSubscriptionTrials.eligibility_principal_id, scope.eligibilityPrincipalId),
            eq(appSubscriptionTrials.livemode, scope.livemode),
          ),
        )
        .for("update");
      if (existing) {
        if (
          existing.command_id !== command.id ||
          existing.billing_scope_id !== scope.scopeId ||
          existing.plan_revision_id !== plan.id
        )
          appBillingConflict("App trial eligibility has already been consumed");
        return existing;
      }
      const now = await readPostLockDatabaseNow(tx);
      const start = new Date(Math.floor(now.getTime() / 1000) * 1000);
      const [trial] = await tx
        .insert(appSubscriptionTrials)
        .values({
          app_id: scope.appId,
          livemode: scope.livemode,
          eligibility_principal_id: scope.eligibilityPrincipalId,
          billing_scope_id: scope.scopeId,
          command_id: command.id,
          plan_revision_id: plan.id,
          starts_at: start,
          ends_at: new Date(start.getTime() + 604800000),
        })
        .returning();
      if (!trial) appBillingConflict("Trial claim persistence returned no record");
      return trial;
    });
  }

  async bindCustomer(input: {
    scopeId: string;
    commandId: string;
    customerId: string;
    lease?: AppCommandLease;
  }) {
    if (!/^cus_[A-Za-z0-9]+$/.test(input.customerId))
      appBillingConflict("Provider customer identifier is invalid");
    return writeTransaction(async (tx) => {
      const scope = await lockAppBillingScope(tx, input.scopeId, input.lease !== undefined);
      const [command] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.id, input.commandId),
            eq(billingSubscriptionCommands.billing_scope_id, scope.scopeId),
          ),
        )
        .for("update");
      if (!command || command.status !== "OUTCOME_UNKNOWN")
        appBillingConflict("Customer binding requires an in-flight durable command");
      if (input.lease) {
        const lease = input.lease;
        const now = await readPostLockDatabaseNow(tx);
        if (
          lease.scopeId !== scope.scopeId ||
          lease.commandId !== command.id ||
          command.lease_token !== lease.token ||
          command.state_revision !== lease.stateRevision ||
          command.execution_generation !== lease.executionGeneration ||
          command.lease_expires_at === null ||
          command.lease_expires_at <= now
        )
          appBillingConflict("Customer binding lost its current execution lease");
        if (lease.deletionAuthority)
          await requireAppBillingDeletionRecovery(tx, lease.deletionAuthority, command);
      }
      await tx
        .insert(appBillingCustomers)
        .values({
          billing_account_id: scope.billingAccountId,
          merchant_id: scope.merchantId,
          stripe_customer_id: input.customerId,
          command_id: command.id,
        })
        .onConflictDoNothing();
      const [binding] = await tx
        .select()
        .from(appBillingCustomers)
        .where(
          and(
            eq(appBillingCustomers.billing_account_id, scope.billingAccountId),
            eq(appBillingCustomers.merchant_id, scope.merchantId),
          ),
        );
      if (!binding || binding.stripe_customer_id !== input.customerId)
        appBillingConflict("Provider customer binding conflicts with immutable ownership");
      return binding;
    });
  }
}

export const appSubscriptionAuthorityRepository = new AppSubscriptionAuthorityRepository();
