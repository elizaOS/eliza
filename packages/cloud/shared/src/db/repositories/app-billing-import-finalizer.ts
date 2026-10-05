/** Atomically adopts reviewed external billing history into the existing lifecycle and noncash ledger under the original command lease. */
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import type { OperatorBillingCommandResult } from "../../lib/services/generic-billing-command-types";
import type { verifyAppBillingImportProvider } from "../../lib/services/generic-billing-import-provider";
import { settlementDigest } from "../../lib/services/settlement-digest";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import {
  appBillingCustomers,
  appSubscriptionTrials,
  billingMerchants,
} from "../schemas/app-billing";
import { subscriptionAllowancePeriods } from "../schemas/subscription-allowance-periods";
import { subscriptionAllowanceTransactions } from "../schemas/subscription-allowance-transactions";
import { billingSubscriptionCommands } from "../schemas/subscription-billing-operations";
import { users } from "../schemas/users";
import type { AppCommandLease } from "./app-billing-command-runtime";
import {
  appBillingConflict,
  lockAppBillingScope,
  requireAppBillingAdministrator,
} from "./app-subscription-authority";
import { appSubscriptionFinalizer } from "./app-subscription-finalizer";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export async function requireImportPrincipal(tx: DbTransaction, userId: string, now: Date) {
  const [principal] = await tx
    .select({
      active: users.is_active,
      deleted: users.deleted_at,
      anonymous: users.is_anonymous,
      state: users.account_lifecycle_state,
      fenced: users.auth_fenced_at,
      expires: users.expires_at,
    })
    .from(users)
    .where(eq(users.id, userId))
    .for("update");
  if (
    !principal?.active ||
    principal.deleted ||
    principal.anonymous ||
    principal.state !== "active" ||
    principal.fenced ||
    (principal.expires && principal.expires <= now)
  )
    appBillingConflict("Import requires an active nonanonymous canonical principal");
}

export async function finalizeAppBillingImport(input: {
  lease: AppCommandLease;
  merchantRevision: number;
  verified: Awaited<ReturnType<typeof verifyAppBillingImportProvider>>;
}) {
  return writeTransaction(async (tx) => {
    const scope = await lockAppBillingScope(tx, input.lease.scopeId, true);
    const [command] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.id, input.lease.commandId),
          eq(billingSubscriptionCommands.billing_scope_id, scope.scopeId),
        ),
      )
      .for("update");
    const now = await readPostLockDatabaseNow(tx);
    if (
      !command ||
      command.kind !== "import" ||
      command.request_payload?.domain !== "operator" ||
      command.status !== "OUTCOME_UNKNOWN" ||
      command.lease_token !== input.lease.token ||
      command.state_revision !== input.lease.stateRevision ||
      command.execution_generation !== input.lease.executionGeneration ||
      !command.lease_expires_at ||
      command.lease_expires_at <= now
    )
      appBillingConflict("Historical import lost its durable execution lease");
    const manifest = command.request_payload.manifest;
    await requireAppBillingAdministrator(tx, scope, manifest.principalUserId);
    await requireImportPrincipal(tx, manifest.principalUserId, now);
    const [merchant] = await tx
      .select()
      .from(billingMerchants)
      .where(eq(billingMerchants.id, scope.merchantId))
      .for("share");
    if (
      !merchant ||
      merchant.connection_revision !== input.merchantRevision ||
      input.verified.merchant.merchantId !== merchant.id ||
      input.verified.merchant.livemode !== scope.livemode ||
      input.verified.merchant.providerAccountId !== merchant.stripe_account_id
    )
      appBillingConflict("Historical import merchant changed during verification");
    const [priorTrial] = await tx
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
    let trialId: string | null = priorTrial?.id ?? null;
    if (manifest.trial) {
      const starts = new Date(manifest.trial.startsAt),
        ends = new Date(manifest.trial.endsAt);
      if (starts > now) appBillingConflict("Imported trial cannot start in the future");
      if (
        priorTrial &&
        (priorTrial.starts_at.getTime() !== starts.getTime() ||
          priorTrial.ends_at.getTime() !== ends.getTime() ||
          priorTrial.billing_scope_id !== scope.scopeId ||
          priorTrial.plan_revision_id !== manifest.trial.planRevisionId)
      )
        appBillingConflict("Historical trial changes an already consumed eligibility claim");
      if (!priorTrial) {
        const [trial] = await tx
          .insert(appSubscriptionTrials)
          .values({
            app_id: scope.appId,
            eligibility_principal_id: scope.eligibilityPrincipalId,
            billing_scope_id: scope.scopeId,
            livemode: scope.livemode,
            command_id: command.id,
            plan_revision_id: manifest.trial.planRevisionId,
            starts_at: starts,
            ends_at: ends,
          })
          .returning();
        if (!trial) appBillingConflict("Original trial claim was not persisted");
        trialId = trial.id;
      }
    }
    let subscriptionId: string | null = null;
    if (manifest.provider) {
      if (!input.verified.subscription)
        appBillingConflict("Historical provider observation is missing");
      const [customer] = await tx
        .select()
        .from(appBillingCustomers)
        .where(
          and(
            eq(appBillingCustomers.billing_account_id, scope.billingAccountId),
            eq(appBillingCustomers.merchant_id, scope.merchantId),
          ),
        );
      if (customer && customer.stripe_customer_id !== manifest.provider.customerId)
        appBillingConflict("Historical customer differs from the immutable app customer");
      if (!customer)
        await tx.insert(appBillingCustomers).values({
          billing_account_id: scope.billingAccountId,
          merchant_id: scope.merchantId,
          stripe_customer_id: manifest.provider.customerId,
          command_id: command.id,
        });
      const applied = await appSubscriptionFinalizer.applyObservation(
        {
          scopeId: scope.scopeId,
          planRevisionId: manifest.planRevisionId,
          expectedSubscriptionRevision: null,
          subscription: input.verified.subscription,
          invoice: input.verified.invoice,
          command: {
            id: command.id,
            stateRevision: command.state_revision,
            executionGeneration: command.execution_generation,
            leaseToken: input.lease.token,
          },
          event: null,
        },
        tx,
      );
      subscriptionId = applied.subscription.id;
      const available = manifest.allowance ? new Decimal(manifest.allowance.availableUsd) : null;
      if (applied.allowance) {
        if (available === null || available.gt(applied.allowance.granted_amount))
          appBillingConflict(
            "Imported allowance requires an explicit remaining balance within its original grant",
          );
        const consumed = new Decimal(applied.allowance.granted_amount).minus(available);
        if (consumed.gt(0)) {
          await tx
            .update(subscriptionAllowancePeriods)
            .set({ available_amount: available.toFixed(6), settled_amount: consumed.toFixed(6) })
            .where(eq(subscriptionAllowancePeriods.id, applied.allowance.id));
          await tx.insert(subscriptionAllowanceTransactions).values({
            organization_id: scope.organizationId,
            billing_scope_id: scope.scopeId,
            merchant_key: scope.merchantKey,
            allowance_period_id: applied.allowance.id,
            trial_claim_id: applied.allowance.trial_claim_id,
            sequence: 2,
            kind: "import_consumed",
            amount: consumed.toFixed(6),
            available_before: applied.allowance.granted_amount,
            available_after: available.toFixed(6),
            reserved_before: "0.000000",
            reserved_after: "0.000000",
            settled_before: "0.000000",
            settled_after: consumed.toFixed(6),
            expired_before: "0.000000",
            expired_after: "0.000000",
            clawed_back_before: "0.000000",
            clawed_back_after: "0.000000",
            idempotency_key: `import-consumed:${command.id}`,
            request_digest: command.request_digest,
            metadata: { importCommandId: command.id },
            occurred_at: now,
          });
        }
      } else if (available?.gt(0))
        appBillingConflict("Historical remaining allowance lacks a current qualifying grant");
    } else if (manifest.allowance !== null)
      appBillingConflict("Local trial history alone cannot create provider-backed allowance");
    const result: OperatorBillingCommandResult = {
      kind: "import",
      subscriptionId,
      trialClaimId: trialId,
    };
    await tx
      .update(billingSubscriptionCommands)
      .set({
        status: "APPLIED",
        provider_result: result,
        provider_response_digest:
          input.verified.subscription?.digest ?? settlementDigest(input.verified),
        result_subscription_id: subscriptionId,
        state_revision: command.state_revision + (subscriptionId ? 2 : 1),
        completed_at: now,
        applied_at: now,
        lease_token: null,
        lease_expires_at: null,
        error_code: null,
        updated_at: now,
      })
      .where(eq(billingSubscriptionCommands.id, command.id));
    return result;
  });
}
