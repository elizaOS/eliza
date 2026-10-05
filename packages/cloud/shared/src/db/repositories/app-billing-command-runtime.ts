/**
 * Leases the existing subscription command journal for app provider dispatch
 * and recovery. Provider calls never run in a transaction, and an expired lease
 * grants reconciliation authority without authorizing a new logical purchase.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { BuyerBillingCommandResult } from "../../lib/services/generic-billing-command-types";
import { settlementDigest } from "../../lib/services/settlement-digest";
import { dbWrite, writeTransaction } from "../helpers";
import { accountDeletionRequests } from "../schemas/account-deletion-requests";
import {
  appBillingCustomers,
  appBillingPlanRevisions,
  appBillingScopes,
  appSubscriptionTrials,
} from "../schemas/app-billing";
import { billingSubscriptions } from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import { billingSubscriptionCommands } from "../schemas/subscription-billing-operations";
import { users } from "../schemas/users";
import {
  type AppBillingCommandActor,
  type AppBillingDeletionRecoveryAuthority,
  requireAppBillingDeletionRecovery,
  requireAppBillingPreparedDeletionSupersession,
} from "./app-billing-deletion-authority";
import { readAppBillingMembership } from "./app-billing-queries";
import {
  appBillingConflict,
  lockAppBillingScope,
  requireAppBillingAdministrator,
} from "./app-subscription-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export interface AppCommandLease {
  scopeId: string;
  commandId: string;
  token: string;
  stateRevision: number;
  executionGeneration: number;
  deletionAuthority?: AppBillingDeletionRecoveryAuthority;
}

export class AppBillingCommandRuntimeRepository {
  /** Cancels only unstarted original purchaser intent. Invoke standalone: sorted owners precede scope/account, user, command, request and phase locks. A PREPARED command has no provider execution lease to acquire. */
  async supersedePreparedForDeletion(input: {
    scopeId: string;
    commandId: string;
    expectedStateRevision: number;
    authority: AppBillingDeletionRecoveryAuthority;
  }) {
    return writeTransaction(async (tx) => {
      const [observed] = await tx
        .select({
          userId: accountDeletionRequests.user_id,
          organizationId: accountDeletionRequests.organization_id,
        })
        .from(accountDeletionRequests)
        .where(eq(accountDeletionRequests.id, input.authority.requestId));
      const [observedScope] = await tx
        .select({ organizationId: appBillingScopes.organization_id })
        .from(appBillingScopes)
        .where(eq(appBillingScopes.id, input.scopeId));
      if (!observed?.userId || !observed.organizationId || !observedScope)
        appBillingConflict("Prepared deletion command subject or scope is unavailable");
      const ownerIds = [...new Set([observed.organizationId, observedScope.organizationId])].sort();
      const owners = await tx
        .select({
          id: organizations.id,
          state: organizations.account_lifecycle_state,
          requestId: organizations.account_deletion_request_id,
          revision: organizations.account_lifecycle_revision,
        })
        .from(organizations)
        .where(inArray(organizations.id, ownerIds))
        .orderBy(asc(organizations.id))
        .for("update");
      if (owners.length !== ownerIds.length)
        appBillingConflict("Prepared deletion owner is unavailable");
      const scope = await lockAppBillingScope(tx, input.scopeId, true);
      if (scope.organizationId !== observedScope.organizationId)
        appBillingConflict("Prepared deletion scope owner changed");
      const [user] = await tx
        .select({
          id: users.id,
          state: users.account_lifecycle_state,
          requestId: users.account_deletion_request_id,
          revision: users.account_lifecycle_revision,
        })
        .from(users)
        .where(eq(users.id, observed.userId))
        .for("update");
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
        command.app_id !== scope.appId ||
        command.organization_id !== scope.organizationId ||
        command.merchant_id !== scope.merchantId ||
        command.livemode !== scope.livemode ||
        command.merchant_key !== scope.merchantKey
      )
        appBillingConflict("Prepared deletion command lost its original scope");
      const request = await requireAppBillingPreparedDeletionSupersession(
        tx,
        input.authority,
        command,
      );
      const owner = owners.find((row) => row.id === observed.organizationId);
      if (
        request.userId !== observed.userId ||
        request.organizationId !== observed.organizationId ||
        user?.state !== "deletion_irreversible" ||
        user.requestId !== input.authority.requestId ||
        user.revision !== request.revision ||
        owner?.state !== "deletion_irreversible" ||
        owner.requestId !== input.authority.requestId ||
        owner.revision !== request.revision
      )
        appBillingConflict("Prepared deletion requires the irreversible canonical purchaser");
      if (
        command.state_revision !== input.expectedStateRevision ||
        command.lease_token !== null ||
        command.lease_expires_at !== null ||
        command.attempt_count !== 0 ||
        command.completed_at !== null ||
        command.applied_at !== null ||
        command.result_subscription_id !== null
      )
        appBillingConflict("Prepared deletion command revision or execution lease changed");
      const now = await readPostLockDatabaseNow(tx);
      const [superseded] = await tx
        .update(billingSubscriptionCommands)
        .set({
          status: "SUPERSEDED",
          state_revision: command.state_revision + 1,
          error_code: "APP_BILLING_PURCHASER_DELETED",
          completed_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(billingSubscriptionCommands.id, command.id),
            eq(billingSubscriptionCommands.state_revision, input.expectedStateRevision),
            eq(billingSubscriptionCommands.status, "PREPARED"),
            eq(billingSubscriptionCommands.execution_generation, 0),
            isNull(billingSubscriptionCommands.lease_token),
            isNull(billingSubscriptionCommands.lease_expires_at),
            isNull(billingSubscriptionCommands.provider_started_at),
            isNull(billingSubscriptionCommands.provider_response_digest),
            isNull(billingSubscriptionCommands.provider_result),
          ),
        )
        .returning();
      if (!superseded) appBillingConflict("Prepared deletion command lost its atomic supersession");
      return superseded;
    });
  }

  async releaseLease(lease: AppCommandLease) {
    await dbWrite
      .update(billingSubscriptionCommands)
      .set({ lease_token: null, lease_expires_at: null })
      .where(
        and(
          eq(billingSubscriptionCommands.id, lease.commandId),
          eq(billingSubscriptionCommands.billing_scope_id, lease.scopeId),
          eq(billingSubscriptionCommands.lease_token, lease.token),
          eq(billingSubscriptionCommands.state_revision, lease.stateRevision),
          eq(billingSubscriptionCommands.execution_generation, lease.executionGeneration),
        ),
      );
  }

  async expireCheckoutCommand(
    lease: AppCommandLease,
    checkoutCommandId: string,
    checkoutSessionId: string,
  ) {
    return writeTransaction(async (tx) => {
      await lockAppBillingScope(tx, lease.scopeId, true);
      const [leased] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.id, lease.commandId),
            eq(billingSubscriptionCommands.billing_scope_id, lease.scopeId),
          ),
        )
        .for("update");
      const [checkout] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.id, checkoutCommandId),
            eq(billingSubscriptionCommands.billing_scope_id, lease.scopeId),
          ),
        )
        .for("update");
      const now = await readPostLockDatabaseNow(tx);
      if (
        !leased ||
        leased.lease_token !== lease.token ||
        leased.state_revision !== lease.stateRevision ||
        leased.execution_generation !== lease.executionGeneration ||
        !leased.lease_expires_at ||
        leased.lease_expires_at <= now ||
        !checkout ||
        checkout.provider_result?.kind !== "checkout" ||
        checkout.provider_result.checkoutSessionId !== checkoutSessionId ||
        !["OUTCOME_UNKNOWN", "SUCCEEDED", "FAILED"].includes(checkout.status)
      )
        appBillingConflict("Checkout expiry lost the original session or command lease");
      if (lease.deletionAuthority)
        await requireAppBillingDeletionRecovery(tx, lease.deletionAuthority, leased);
      if (checkout.status !== "FAILED")
        await tx
          .update(billingSubscriptionCommands)
          .set({
            status: "FAILED",
            error_code: "APP_BILLING_CHECKOUT_EXPIRED",
            completed_at: now,
            lease_token: null,
            lease_expires_at: null,
            updated_at: now,
            state_revision: checkout.state_revision + 1,
          })
          .where(eq(billingSubscriptionCommands.id, checkout.id));
      if (lease.commandId !== checkout.id) {
        const result: BuyerBillingCommandResult = { kind: "expired_checkout", checkoutSessionId };
        await tx
          .update(billingSubscriptionCommands)
          .set({
            status: "SUCCEEDED",
            provider_result: result,
            provider_response_digest: settlementDigest(result),
            completed_at: now,
            lease_token: null,
            lease_expires_at: null,
            updated_at: now,
            state_revision: leased.state_revision + 1,
          })
          .where(eq(billingSubscriptionCommands.id, leased.id));
      }
    });
  }

  async originalActor(input: { scopeId: string; commandId: string }) {
    const [command] = await dbWrite
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.id, input.commandId),
          eq(billingSubscriptionCommands.billing_scope_id, input.scopeId),
        ),
      );
    if (!command || command.request_payload?.domain !== "buyer")
      appBillingConflict("Original app purchase command is unavailable");
    return command;
  }

  async recordProgress(lease: AppCommandLease, result: BuyerBillingCommandResult) {
    return writeTransaction(async (tx) => {
      await lockAppBillingScope(tx, lease.scopeId, true);
      const [command] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.id, lease.commandId),
            eq(billingSubscriptionCommands.billing_scope_id, lease.scopeId),
          ),
        )
        .for("update");
      const now = await readPostLockDatabaseNow(tx);
      if (
        !command ||
        command.lease_token !== lease.token ||
        command.state_revision !== lease.stateRevision ||
        command.execution_generation !== lease.executionGeneration ||
        !command.lease_expires_at ||
        command.lease_expires_at <= now
      )
        appBillingConflict("Provider progress lost its current execution lease");
      if (lease.deletionAuthority)
        await requireAppBillingDeletionRecovery(tx, lease.deletionAuthority, command);
      await tx
        .update(billingSubscriptionCommands)
        .set({ provider_result: result, updated_at: now })
        .where(eq(billingSubscriptionCommands.id, command.id));
    });
  }

  async read(input: { scopeId: string; commandId: string } & AppBillingCommandActor) {
    return writeTransaction(async (tx) => {
      const scope = await lockAppBillingScope(tx, input.scopeId, true);
      if (!input.deletionAuthority)
        await requireAppBillingAdministrator(tx, scope, input.actorUserId);
      const [command] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.id, input.commandId),
            eq(billingSubscriptionCommands.billing_scope_id, input.scopeId),
          ),
        );
      if (
        !command ||
        command.app_id !== scope.appId ||
        command.livemode !== scope.livemode ||
        command.request_payload?.domain !== "buyer"
      )
        appBillingConflict("App billing operation is unavailable in this account and environment");
      if (input.deletionAuthority)
        await requireAppBillingDeletionRecovery(tx, input.deletionAuthority, command);
      return { scope, command, now: await readPostLockDatabaseNow(tx) };
    });
  }

  async claim(input: { scopeId: string; commandId: string } & AppBillingCommandActor) {
    return writeTransaction(async (tx) => {
      const scope = await lockAppBillingScope(tx, input.scopeId, true);
      const administrator = input.deletionAuthority
        ? { newWorkAllowed: false }
        : await requireAppBillingAdministrator(tx, scope, input.actorUserId);
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
        command.app_id !== scope.appId ||
        command.livemode !== scope.livemode ||
        (command.request_payload?.domain !== "buyer" &&
          !(command.kind === "import" && command.request_payload?.domain === "operator"))
      )
        appBillingConflict("App billing command lost its scoped intent");
      if (input.deletionAuthority)
        await requireAppBillingDeletionRecovery(tx, input.deletionAuthority, command);
      const now = await readPostLockDatabaseNow(tx);
      if (!["PREPARED", "OUTCOME_UNKNOWN", "SUCCEEDED"].includes(command.status)) return null;
      if (command.status === "SUCCEEDED" && ["portal", "expire_checkout"].includes(command.kind))
        return null;
      if (command.lease_expires_at && command.lease_expires_at > now) return null;
      if (
        scope.salesFenced &&
        command.status === "PREPARED" &&
        !["cancel", "portal", "expire_checkout", "import"].includes(command.kind)
      )
        appBillingConflict("App sales authority was fenced before provider dispatch");
      const firstDispatch = command.status === "PREPARED";
      if (firstDispatch && !administrator.newWorkAllowed)
        appBillingConflict("The purchaser account was fenced before provider dispatch");
      // Existing provider observations remain recoverable, but a fenced actor cannot authorize a retry write.
      scope.salesFenced ||= !administrator.newWorkAllowed;
      const [claimed] = await tx
        .update(billingSubscriptionCommands)
        .set({
          status: firstDispatch ? "OUTCOME_UNKNOWN" : command.status,
          state_revision: command.state_revision + 1,
          execution_generation: command.execution_generation + 1,
          attempt_count: command.attempt_count + 1,
          lease_token: randomUUID(),
          lease_expires_at: new Date(now.getTime() + 180_000),
          provider_started_at: command.provider_started_at ?? now,
          updated_at: now,
        })
        .where(eq(billingSubscriptionCommands.id, command.id))
        .returning();
      if (!claimed?.lease_token) appBillingConflict("Billing execution lease was not persisted");
      const [subscription] = command.subscription_id
        ? await tx
            .select()
            .from(billingSubscriptions)
            .where(
              and(
                eq(billingSubscriptions.id, command.subscription_id),
                eq(billingSubscriptions.billing_scope_id, scope.scopeId),
              ),
            )
        : [];
      const planId = command.target_plan_revision_id ?? subscription?.plan_revision_id;
      const [plan] = planId
        ? await tx
            .select()
            .from(appBillingPlanRevisions)
            .where(
              and(
                eq(appBillingPlanRevisions.id, planId),
                eq(appBillingPlanRevisions.app_id, scope.appId),
                eq(appBillingPlanRevisions.merchant_id, scope.merchantId),
                eq(appBillingPlanRevisions.product_family_key, scope.productFamilyKey),
              ),
            )
        : [];
      const [trial] = await tx
        .select()
        .from(appSubscriptionTrials)
        .where(eq(appSubscriptionTrials.billing_scope_id, scope.scopeId));
      return {
        scope,
        deletionAuthority: input.deletionAuthority ?? null,
        command: claimed,
        subscription: subscription ?? null,
        plan: plan ?? null,
        trial: trial ?? null,
        firstDispatch,
        now,
        lease: {
          scopeId: scope.scopeId,
          commandId: command.id,
          token: claimed.lease_token,
          stateRevision: claimed.state_revision,
          executionGeneration: claimed.execution_generation,
          ...(input.deletionAuthority ? { deletionAuthority: input.deletionAuthority } : {}),
        } satisfies AppCommandLease,
      };
    });
  }

  async recordResult(lease: AppCommandLease, result: BuyerBillingCommandResult) {
    return writeTransaction(async (tx) => {
      await lockAppBillingScope(tx, lease.scopeId, true);
      const [command] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.id, lease.commandId),
            eq(billingSubscriptionCommands.billing_scope_id, lease.scopeId),
          ),
        )
        .for("update");
      const now = await readPostLockDatabaseNow(tx);
      if (
        !command ||
        command.lease_token !== lease.token ||
        command.state_revision !== lease.stateRevision ||
        command.execution_generation !== lease.executionGeneration ||
        !command.lease_expires_at ||
        command.lease_expires_at <= now ||
        !["OUTCOME_UNKNOWN", "SUCCEEDED"].includes(command.status)
      )
        appBillingConflict("Provider result lost its current execution lease");
      if (lease.deletionAuthority)
        await requireAppBillingDeletionRecovery(tx, lease.deletionAuthority, command);
      const [saved] = await tx
        .update(billingSubscriptionCommands)
        .set({
          status: "SUCCEEDED",
          provider_result: result,
          provider_response_digest: settlementDigest(result),
          completed_at: now,
          error_code: null,
          lease_token: null,
          lease_expires_at: null,
          state_revision: command.state_revision + 1,
          updated_at: now,
        })
        .where(eq(billingSubscriptionCommands.id, command.id))
        .returning();
      if (!saved) appBillingConflict("Provider result was not persisted");
      return saved;
    });
  }

  async releaseForReconciliation(lease: AppCommandLease, errorCode: string) {
    return writeTransaction(async (tx) => {
      await lockAppBillingScope(tx, lease.scopeId, true);
      const now = await readPostLockDatabaseNow(tx);
      // The original result may be unknown. Retain its intent and original start time.
      return tx
        .update(billingSubscriptionCommands)
        .set({
          lease_token: null,
          lease_expires_at: null,
          updated_at: now,
          error_code: errorCode,
        })
        .where(
          and(
            eq(billingSubscriptionCommands.id, lease.commandId),
            eq(billingSubscriptionCommands.billing_scope_id, lease.scopeId),
            eq(billingSubscriptionCommands.status, "OUTCOME_UNKNOWN"),
            eq(billingSubscriptionCommands.state_revision, lease.stateRevision),
            eq(billingSubscriptionCommands.execution_generation, lease.executionGeneration),
            eq(billingSubscriptionCommands.lease_token, lease.token),
          ),
        )
        .returning({ id: billingSubscriptionCommands.id });
    });
  }

  async customerCreationOwner(input: { scopeId: string; commandId: string }) {
    return writeTransaction(async (tx) => {
      const scope = await lockAppBillingScope(tx, input.scopeId, true);
      const [binding] = await tx
        .select()
        .from(appBillingCustomers)
        .where(
          and(
            eq(appBillingCustomers.billing_account_id, scope.billingAccountId),
            eq(appBillingCustomers.merchant_id, scope.merchantId),
          ),
        );
      if (binding)
        return {
          scope,
          customerId: binding.stripe_customer_id,
          ownerCommandId: binding.command_id,
        };
      const [owner] = await tx
        .select({ id: billingSubscriptionCommands.id })
        .from(billingSubscriptionCommands)
        .innerJoin(
          appBillingScopes,
          eq(appBillingScopes.id, billingSubscriptionCommands.billing_scope_id),
        )
        .where(
          and(
            eq(appBillingScopes.app_id, scope.appId),
            eq(appBillingScopes.billing_account_id, scope.billingAccountId),
            eq(appBillingScopes.merchant_id, scope.merchantId),
            eq(billingSubscriptionCommands.kind, "checkout"),
            inArray(billingSubscriptionCommands.status, [
              "PREPARED",
              "OUTCOME_UNKNOWN",
              "SUCCEEDED",
              "APPLIED",
            ]),
          ),
        )
        .orderBy(asc(billingSubscriptionCommands.created_at), asc(billingSubscriptionCommands.id))
        .limit(1);
      if (!owner) appBillingConflict("Customer creation has no original durable command");
      return { scope, customerId: null, ownerCommandId: owner.id };
    });
  }

  async resolveOperationScope(input: {
    appId: string;
    billingAccountId: string;
    actorUserId: string;
    commandId: string;
    livemode: boolean;
  }) {
    return writeTransaction(async (tx) => {
      const [row] = await tx
        .select({ scopeId: appBillingScopes.id })
        .from(billingSubscriptionCommands)
        .innerJoin(
          appBillingScopes,
          eq(appBillingScopes.id, billingSubscriptionCommands.billing_scope_id),
        )
        .where(
          and(
            eq(billingSubscriptionCommands.id, input.commandId),
            eq(appBillingScopes.app_id, input.appId),
            eq(appBillingScopes.billing_account_id, input.billingAccountId),
            eq(appBillingScopes.livemode, input.livemode),
          ),
        );
      if (!row) appBillingConflict("App operation is unavailable in this billing account");
      await lockAppBillingScope(tx, row.scopeId, true);
      await readAppBillingMembership(tx, input);
      return row.scopeId;
    });
  }

  async pending(scopeId: string) {
    return dbWrite
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.billing_scope_id, scopeId),
          inArray(billingSubscriptionCommands.status, ["PREPARED", "OUTCOME_UNKNOWN", "SUCCEEDED"]),
          isNull(billingSubscriptionCommands.applied_at),
        ),
      )
      .orderBy(asc(billingSubscriptionCommands.created_at));
  }
}

export const appBillingCommandRuntimeRepository = new AppBillingCommandRuntimeRepository();
