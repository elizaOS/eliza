/** Cancels only server-selected subscriptions in canonically closed scopes. Current deletion and execution leases fence every dispatch and atomic canceled projection; unresolved commands anywhere in the scope prevent provider cancellation. */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DeletionCancellationCommandPayload } from "../../lib/services/generic-billing-command-types";
import type {
  BillingProviderObservation,
  BillingProviderSubscription,
} from "../../lib/services/generic-billing-provider-types";
import { settlementDigest } from "../../lib/services/settlement-digest";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import { accountDeletionPhaseReceipts } from "../schemas/account-deletion-phase-receipts";
import { accountDeletionRequests } from "../schemas/account-deletion-requests";
import { appBillingScopes, billingMerchants } from "../schemas/app-billing";
import { appBillingDeletionDispositions } from "../schemas/app-billing-deletion-dispositions";
import { billingSubscriptions } from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import { billingSubscriptionCommands } from "../schemas/subscription-billing-operations";
import { users } from "../schemas/users";
import type { AppCommandLease } from "./app-billing-command-runtime";
import { appBillingConflict, lockAppBillingScope } from "./app-subscription-authority";
import { appSubscriptionFinalizer } from "./app-subscription-finalizer";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export interface DeletionCancellationAuthority {
  kind: "account_deletion_subscription_cancellation";
  requestId: string;
  requestDigest: string;
  lifecycleRevision: number;
  phaseReceiptId: string;
  phaseGeneration: number;
}
export interface DeletionCancellationClaim {
  scopeId: string;
  authority: DeletionCancellationAuthority;
  payload: DeletionCancellationCommandPayload;
  lease: AppCommandLease;
}

async function lockScope(
  tx: DbTransaction,
  scopeId: string,
  authority: DeletionCancellationAuthority,
) {
  const [subject] = await tx
    .select({
      id: accountDeletionRequests.id,
      user_id: accountDeletionRequests.user_id,
      organization_id: accountDeletionRequests.organization_id,
      status: accountDeletionRequests.status,
      irreversible_at: accountDeletionRequests.irreversible_at,
      request_digest: accountDeletionRequests.request_digest,
      lifecycle_revision: accountDeletionRequests.lifecycle_revision,
    })
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.id, authority.requestId));
  const [observedScope] = await tx
    .select()
    .from(appBillingScopes)
    .where(eq(appBillingScopes.id, scopeId));
  if (!subject?.user_id || !subject.organization_id || !observedScope)
    appBillingConflict("Cancellation subject or scope is unavailable");
  const ownerIds = [...new Set([subject.organization_id, observedScope.organization_id])].sort();
  const owners = await tx
    .select({
      id: organizations.id,
      account_lifecycle_state: organizations.account_lifecycle_state,
      account_deletion_request_id: organizations.account_deletion_request_id,
      account_lifecycle_revision: organizations.account_lifecycle_revision,
    })
    .from(organizations)
    .where(inArray(organizations.id, ownerIds))
    .orderBy(asc(organizations.id))
    .for("update");
  const scope = await lockAppBillingScope(tx, scopeId, true);
  const [principal] = await tx
    .select({
      account_lifecycle_state: users.account_lifecycle_state,
      account_deletion_request_id: users.account_deletion_request_id,
      account_lifecycle_revision: users.account_lifecycle_revision,
    })
    .from(users)
    .where(eq(users.id, subject.user_id))
    .for("update");
  const subscriptions = await tx
    .select()
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.billing_scope_id, scopeId))
    .orderBy(asc(billingSubscriptions.id))
    .for("update");
  const commands = await tx
    .select()
    .from(billingSubscriptionCommands)
    .where(eq(billingSubscriptionCommands.billing_scope_id, scopeId))
    .orderBy(asc(billingSubscriptionCommands.id))
    .for("update");
  const [request] = await tx
    .select({
      id: accountDeletionRequests.id,
      user_id: accountDeletionRequests.user_id,
      organization_id: accountDeletionRequests.organization_id,
      status: accountDeletionRequests.status,
      irreversible_at: accountDeletionRequests.irreversible_at,
      request_digest: accountDeletionRequests.request_digest,
      lifecycle_revision: accountDeletionRequests.lifecycle_revision,
    })
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.id, authority.requestId))
    .for("share");
  const [phase] = await tx
    .select({
      id: accountDeletionPhaseReceipts.id,
      phase: accountDeletionPhaseReceipts.phase,
      status: accountDeletionPhaseReceipts.status,
      lease_generation: accountDeletionPhaseReceipts.lease_generation,
      lease_expires_at: accountDeletionPhaseReceipts.lease_expires_at,
    })
    .from(accountDeletionPhaseReceipts)
    .where(
      and(
        eq(accountDeletionPhaseReceipts.id, authority.phaseReceiptId),
        eq(accountDeletionPhaseReceipts.request_id, authority.requestId),
      ),
    )
    .for("share");
  const [decision] = await tx
    .select()
    .from(appBillingDeletionDispositions)
    .where(
      and(
        eq(appBillingDeletionDispositions.request_id, authority.requestId),
        eq(appBillingDeletionDispositions.scope_id, scopeId),
      ),
    );
  const owner = owners.find((row) => row.id === subject.organization_id);
  const now = await readPostLockDatabaseNow(tx);
  if (
    authority.kind !== "account_deletion_subscription_cancellation" ||
    !request ||
    !phase ||
    !decision ||
    request.user_id !== subject.user_id ||
    request.organization_id !== subject.organization_id ||
    request.status !== "processing" ||
    !request.irreversible_at ||
    request.request_digest !== authority.requestDigest ||
    request.lifecycle_revision !== authority.lifecycleRevision ||
    phase.phase !== "stripe" ||
    phase.lease_generation !== authority.phaseGeneration ||
    !phase.lease_expires_at ||
    !Number.isFinite(phase.lease_expires_at.getTime()) ||
    phase.lease_expires_at <= now ||
    !["leased", "calling", "reconciling"].includes(phase.status) ||
    principal?.account_lifecycle_state !== "deletion_irreversible" ||
    principal.account_deletion_request_id !== request.id ||
    principal.account_lifecycle_revision !== request.lifecycle_revision ||
    owner?.account_lifecycle_state !== "deletion_irreversible" ||
    owner.account_deletion_request_id !== request.id ||
    owner.account_lifecycle_revision !== request.lifecycle_revision ||
    decision.request_digest !== request.request_digest ||
    decision.lifecycle_revision !== request.lifecycle_revision ||
    decision.phase_receipt_id !== phase.id ||
    decision.phase_generation !== phase.lease_generation ||
    decision.merchant_id !== scope.merchantId ||
    decision.provider_account_key !== scope.merchantKey ||
    decision.livemode !== scope.livemode
  )
    appBillingConflict(
      "Cancellation requires the current canonical deletion disposition and lease",
    );
  if (decision.disposition === "close" && !observedScope.fenced_at)
    appBillingConflict("Closing cancellation scope lost its permanent sales fence");
  const [merchant] = await tx
    .select()
    .from(billingMerchants)
    .where(eq(billingMerchants.id, scope.merchantId));
  if (!merchant?.stripe_account_id)
    appBillingConflict("Cancellation merchant account is unavailable");
  return { scope, request, commands, subscriptions, decision, merchant, now };
}

function unresolved(command: typeof billingSubscriptionCommands.$inferSelect) {
  if (
    command.status === "APPLIED" ||
    command.status === "FAILED" ||
    command.status === "SUPERSEDED"
  )
    return false;
  // Portal, Checkout expiry and customer deletion complete without another subscription projection.
  const payload = command.request_payload;
  return !(
    command.status === "SUCCEEDED" &&
    ((payload?.domain === "account_deletion" && payload.action === "expire_checkout") ||
      (payload?.domain === "account_deletion" &&
        payload.action === "delete_customer" &&
        command.kind === "delete_customer" &&
        command.provider_result?.kind === "deleted_customer" &&
        command.provider_result.customerBindingId === payload.customerBindingId) ||
      (payload?.domain === "buyer" &&
        ((command.kind === "portal" &&
          payload.action === "portal" &&
          command.provider_result?.kind === "portal") ||
          (command.kind === "expire_checkout" &&
            payload.action === "expire_checkout" &&
            command.provider_result?.kind === "expired_checkout"))))
  );
}

async function lockedClaim(tx: DbTransaction, claim: DeletionCancellationClaim) {
  const locked = await lockScope(tx, claim.scopeId, claim.authority);
  const command = locked.commands.find((row) => row.id === claim.lease.commandId);
  const payload = command?.request_payload;
  const subscription = locked.subscriptions.find(
    (row) => row.id === claim.payload.localSubscriptionId,
  );
  if (
    locked.decision.disposition !== "close" ||
    !command ||
    payload?.domain !== "account_deletion" ||
    payload.action !== "cancel" ||
    command.kind !== "cancel" ||
    settlementDigest(payload) !== command.request_digest ||
    settlementDigest(claim.payload) !== command.request_digest ||
    payload.requestId !== claim.authority.requestId ||
    payload.requestDigest !== claim.authority.requestDigest ||
    payload.lifecycleRevision !== claim.authority.lifecycleRevision ||
    payload.phaseReceiptId !== claim.authority.phaseReceiptId ||
    command.status !== "OUTCOME_UNKNOWN" ||
    command.lease_token !== claim.lease.token ||
    command.state_revision !== claim.lease.stateRevision ||
    command.execution_generation !== claim.lease.executionGeneration ||
    !command.lease_expires_at ||
    command.lease_expires_at <= locked.now ||
    !subscription ||
    subscription.stripe_subscription_id !== payload.subscriptionId ||
    subscription.stripe_customer_id !== payload.customerId ||
    subscription.plan_revision_id !== payload.planRevisionId ||
    payload.customerId !== locked.scope.stripeCustomerId ||
    payload.providerAccountId !== locked.merchant.stripe_account_id ||
    locked.commands.some((row) => row.id !== command.id && unresolved(row))
  )
    appBillingConflict(
      "Cancellation lost its exact selection, current execution lease or resolved scope",
    );
  return { ...locked, command, subscription, payload };
}

export const appBillingDeletionCancellationRepository = {
  async claim(
    scopeId: string,
    authority: DeletionCancellationAuthority,
  ): Promise<
    | { kind: "complete" | "pending" | "retained" }
    | { kind: "claimed"; claim: DeletionCancellationClaim }
  > {
    return writeTransaction(async (tx) => {
      const locked = await lockScope(tx, scopeId, authority);
      if (locked.decision.disposition === "retain_shared") return { kind: "retained" };
      const candidates = locked.subscriptions.filter((row) => row.status !== "canceled");
      const existing = locked.commands.find(
        (row) =>
          row.request_payload?.domain === "account_deletion" &&
          row.request_payload.action === "cancel" &&
          row.request_payload.requestId === authority.requestId &&
          unresolved(row),
      );
      // A customer deletion can remain ambiguous after every subscription is canceled.
      // Let the customer journal reconcile that outcome; it must not block its own retry here.
      if (
        candidates.length === 0 &&
        locked.commands.every(
          (row) =>
            !unresolved(row) ||
            (row.kind === "delete_customer" &&
              (row.status === "PREPARED" || row.status === "OUTCOME_UNKNOWN") &&
              row.request_payload?.domain === "account_deletion" &&
              row.request_payload.action === "delete_customer" &&
              row.request_payload.billingAccountId === locked.scope.billingAccountId &&
              row.request_payload.customerId === locked.scope.stripeCustomerId),
        )
      )
        return { kind: "complete" };
      if (locked.commands.some((row) => row.id !== existing?.id && unresolved(row)))
        return { kind: "pending" };
      const subscription = existing
        ? locked.subscriptions.find((row) => row.id === existing.subscription_id)
        : candidates[0];
      if (!subscription) {
        if (existing) appBillingConflict("Cancellation selected subscription disappeared");
        return { kind: "complete" };
      }
      if (
        !subscription.stripe_subscription_id ||
        !subscription.stripe_customer_id ||
        !subscription.plan_revision_id ||
        subscription.stripe_customer_id !== locked.scope.stripeCustomerId
      )
        appBillingConflict(
          "Cancellation requires an exact canonical provider subscription binding",
        );
      const payload: DeletionCancellationCommandPayload =
        existing?.request_payload?.domain === "account_deletion" &&
        existing.request_payload.action === "cancel"
          ? existing.request_payload
          : {
              version: 1,
              domain: "account_deletion",
              action: "cancel",
              requestId: authority.requestId,
              requestDigest: authority.requestDigest,
              lifecycleRevision: authority.lifecycleRevision,
              phaseReceiptId: authority.phaseReceiptId,
              initiatingPhaseGeneration: authority.phaseGeneration,
              customerId: subscription.stripe_customer_id,
              subscriptionId: subscription.stripe_subscription_id,
              localSubscriptionId: subscription.id,
              planRevisionId: subscription.plan_revision_id,
              providerAccountId: locked.merchant.stripe_account_id!,
              timing: "immediate",
            };
      const key = `deletion-cancel:${authority.requestId}:${subscription.id}`;
      let command = existing;
      if (!command)
        [command] = await tx
          .insert(billingSubscriptionCommands)
          .values({
            app_id: locked.scope.appId,
            livemode: locked.scope.livemode,
            merchant_id: locked.scope.merchantId,
            organization_id: locked.scope.organizationId,
            billing_scope_id: scopeId,
            merchant_key: locked.scope.merchantKey,
            requested_by_user_id: locked.request.user_id!,
            subscription_id: subscription.id,
            kind: "cancel",
            target_quantity: subscription.quantity,
            target_plan_revision_id: subscription.plan_revision_id,
            expected_subscription_revision: subscription.lifecycle_revision,
            idempotency_key: key,
            provider_idempotency_key: `app-${key}`,
            request_digest: settlementDigest(payload),
            request_payload: payload,
          })
          .returning();
      if (!command) appBillingConflict("Cancellation command was not persisted");
      if (command.lease_expires_at && command.lease_expires_at > locked.now)
        return { kind: "pending" };
      const token = randomUUID();
      const [claimed] = await tx
        .update(billingSubscriptionCommands)
        .set({
          status: "OUTCOME_UNKNOWN",
          state_revision: command.state_revision + 1,
          execution_generation: command.execution_generation + 1,
          attempt_count: command.attempt_count + 1,
          lease_token: token,
          lease_expires_at: new Date(locked.now.getTime() + 180_000),
          provider_started_at: command.provider_started_at ?? locked.now,
          updated_at: locked.now,
        })
        .where(eq(billingSubscriptionCommands.id, command.id))
        .returning();
      if (!claimed) appBillingConflict("Cancellation execution lease was not persisted");
      const claim: DeletionCancellationClaim = {
        scopeId,
        authority,
        payload,
        lease: {
          scopeId,
          commandId: command.id,
          token,
          stateRevision: claimed.state_revision,
          executionGeneration: claimed.execution_generation,
        },
      };
      await lockedClaim(tx, claim);
      return { kind: "claimed", claim };
    });
  },
  async validateDispatch(claim: DeletionCancellationClaim) {
    return writeTransaction(async (tx) => (await lockedClaim(tx, claim)).scope);
  },
  async complete(
    claim: DeletionCancellationClaim,
    observation: BillingProviderObservation<BillingProviderSubscription>,
  ) {
    return writeTransaction(async (tx) => {
      const locked = await lockedClaim(tx, claim);
      if (
        observation.value.status !== "canceled" ||
        observation.value.pendingUpdate ||
        observation.value.subscriptionId !== claim.payload.subscriptionId ||
        observation.value.customerId !== claim.payload.customerId ||
        observation.providerAccountId !== claim.payload.providerAccountId ||
        observation.merchantId !== locked.scope.merchantId ||
        observation.livemode !== locked.scope.livemode
      )
        appBillingConflict("Cancellation requires exact terminal canceled provider evidence");
      const applied = await appSubscriptionFinalizer.applyObservation(
        {
          scopeId: claim.scopeId,
          planRevisionId: claim.payload.planRevisionId,
          expectedSubscriptionRevision: locked.subscription.lifecycle_revision,
          subscription: observation,
          invoice: null,
          command: null,
          event: null,
        },
        tx,
      );
      await lockedClaim(tx, claim);
      const now = await readPostLockDatabaseNow(tx);
      if (!locked.command.lease_expires_at || locked.command.lease_expires_at <= now)
        appBillingConflict("Cancellation lease expired during projection");
      await tx
        .update(billingSubscriptionCommands)
        .set({
          status: "APPLIED",
          state_revision: locked.command.state_revision + 1,
          provider_result: {
            kind: "completed",
            subscriptionId: applied.subscription.id,
            subscriptionRevision: applied.subscription.lifecycle_revision,
          },
          provider_response_digest: observation.digest,
          result_subscription_id: applied.subscription.id,
          result_subscription_revision: applied.subscription.lifecycle_revision,
          completed_at: now,
          applied_at: now,
          updated_at: now,
          lease_token: null,
          lease_expires_at: null,
        })
        .where(eq(billingSubscriptionCommands.id, locked.command.id));
      return applied;
    });
  },
  async release(claim: DeletionCancellationClaim) {
    await writeTransaction(async (tx) => {
      await tx
        .update(billingSubscriptionCommands)
        .set({ lease_token: null, lease_expires_at: null })
        .where(
          and(
            eq(billingSubscriptionCommands.id, claim.lease.commandId),
            eq(billingSubscriptionCommands.lease_token, claim.lease.token),
            eq(billingSubscriptionCommands.state_revision, claim.lease.stateRevision),
            eq(billingSubscriptionCommands.execution_generation, claim.lease.executionGeneration),
          ),
        );
    });
  },
};
