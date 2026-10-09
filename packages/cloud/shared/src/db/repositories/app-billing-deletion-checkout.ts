/** Resolves original-purchaser Checkout cleanup through the existing command journal. Scope/owner locks serialize dispatch intent and terminal evidence; current canonical phase authority is required even when replaying a retained cleanup command. */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DeletionCheckoutCommandPayload } from "../../lib/services/generic-billing-command-types";
import type {
  BillingProviderCheckout,
  BillingProviderObservation,
  BillingProviderPaymentMethodCheckout,
} from "../../lib/services/generic-billing-provider-types";
import { settlementDigest } from "../../lib/services/settlement-digest";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import { accountDeletionRequests } from "../schemas/account-deletion-requests";
import { appBillingMembers, billingMerchants } from "../schemas/app-billing";
import { appBillingDeletionDispositions } from "../schemas/app-billing-deletion-dispositions";
import { billingSubscriptionRevisions } from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import {
  type BillingSubscriptionCommand,
  billingSubscriptionCommands,
} from "../schemas/subscription-billing-operations";
import { users } from "../schemas/users";
import type { AppCommandLease } from "./app-billing-command-runtime";
import { requireAppBillingDeletionRecovery } from "./app-billing-deletion-authority";
import { appBillingConflict, lockAppBillingScope } from "./app-subscription-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export interface DeletionCheckoutAuthority {
  kind: "account_deletion_checkout_expiry";
  requestId: string;
  requestDigest: string;
  lifecycleRevision: number;
  phaseReceiptId: string;
  phaseGeneration: number;
}

async function lockSource(
  tx: DbTransaction,
  sourceCommandId: string,
  authority: DeletionCheckoutAuthority,
) {
  if (authority.kind !== "account_deletion_checkout_expiry")
    appBillingConflict("Checkout cleanup requires execution authority");
  const [request] = await tx
    .select({
      user_id: accountDeletionRequests.user_id,
      organization_id: accountDeletionRequests.organization_id,
    })
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.id, authority.requestId));
  const [observed] = await tx
    .select()
    .from(billingSubscriptionCommands)
    .where(eq(billingSubscriptionCommands.id, sourceCommandId));
  if (!request?.user_id || !request.organization_id || !observed?.billing_scope_id)
    appBillingConflict("Checkout cleanup source is unavailable");
  const ownerIds = [...new Set([request.organization_id, observed.organization_id])].sort();
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
  const scope = await lockAppBillingScope(tx, observed.billing_scope_id, true);
  const observedMembers = await tx
    .select()
    .from(appBillingMembers)
    .where(
      and(
        eq(appBillingMembers.billing_account_id, scope.billingAccountId),
        isNull(appBillingMembers.revoked_at),
      ),
    );
  const userIds = [
    ...new Set([request.user_id, ...observedMembers.map((member) => member.user_id)]),
  ].sort();
  const principals = await tx
    .select({
      id: users.id,
      is_active: users.is_active,
      deleted_at: users.deleted_at,
      account_lifecycle_state: users.account_lifecycle_state,
      account_deletion_request_id: users.account_deletion_request_id,
      account_lifecycle_revision: users.account_lifecycle_revision,
      auth_fenced_at: users.auth_fenced_at,
      expires_at: users.expires_at,
    })
    .from(users)
    .where(inArray(users.id, userIds))
    .orderBy(asc(users.id))
    .for("update");
  const members = await tx
    .select()
    .from(appBillingMembers)
    .where(
      and(
        eq(appBillingMembers.billing_account_id, scope.billingAccountId),
        isNull(appBillingMembers.revoked_at),
      ),
    )
    .orderBy(asc(appBillingMembers.id))
    .for("update");
  if (members.some((member) => !userIds.includes(member.user_id)))
    appBillingConflict("Cleanup membership changed; retry with current principals");
  const user = principals.find((principal) => principal.id === request.user_id);
  const [source] = await tx
    .select()
    .from(billingSubscriptionCommands)
    .where(eq(billingSubscriptionCommands.id, sourceCommandId))
    .for("update");
  const owner = owners.find((row) => row.id === request.organization_id);
  if (
    !source ||
    source.billing_scope_id !== scope.scopeId ||
    source.app_id !== scope.appId ||
    source.organization_id !== scope.organizationId ||
    source.merchant_id !== scope.merchantId ||
    source.livemode !== scope.livemode ||
    source.merchant_key !== scope.merchantKey ||
    source.requested_by_user_id !== request.user_id ||
    source.request_payload?.domain !== "buyer" ||
    source.request_payload.action !== "checkout" ||
    source.provider_result?.kind !== "checkout" ||
    source.provider_started_at === null ||
    !["OUTCOME_UNKNOWN", "SUCCEEDED", "APPLIED", "FAILED"].includes(source.status)
  )
    appBillingConflict("Cleanup requires the original purchaser's bound Checkout");
  if (
    user?.account_lifecycle_state !== "deletion_irreversible" ||
    user.account_deletion_request_id !== authority.requestId ||
    user.account_lifecycle_revision !== authority.lifecycleRevision ||
    owner?.account_lifecycle_state !== "deletion_irreversible" ||
    owner.account_deletion_request_id !== authority.requestId ||
    owner.account_lifecycle_revision !== authority.lifecycleRevision
  )
    appBillingConflict("Cleanup requires the irreversible canonical purchaser");
  return { source, scope, principals, members, requestOrganizationId: request.organization_id };
}

async function authorize(
  tx: DbTransaction,
  source: BillingSubscriptionCommand,
  authority: DeletionCheckoutAuthority,
  requestOrganizationId: string,
) {
  const [request] = await tx
    .select({
      userId: accountDeletionRequests.user_id,
      organizationId: accountDeletionRequests.organization_id,
    })
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.id, authority.requestId))
    .for("share");
  if (
    request?.userId !== source.requested_by_user_id ||
    request.organizationId !== requestOrganizationId
  )
    appBillingConflict("Checkout cleanup requires the same locked original purchaser");
  // Reuse the observation validator only for the original buyer row; the distinct caller type never enters purchaser execution.
  await requireAppBillingDeletionRecovery(tx, { ...authority, kind: "account_deletion" }, source);
}

function payloadFor(
  source: BillingSubscriptionCommand,
  authority: DeletionCheckoutAuthority,
): DeletionCheckoutCommandPayload {
  const result = source.provider_result;
  if (result?.kind !== "checkout") appBillingConflict("Cleanup has no original Checkout handle");
  return {
    version: 1,
    domain: "account_deletion",
    action: "expire_checkout",
    sourceCommandId: source.id,
    requestId: authority.requestId,
    requestDigest: authority.requestDigest,
    lifecycleRevision: authority.lifecycleRevision,
    phaseReceiptId: authority.phaseReceiptId,
    initiatingPhaseGeneration: authority.phaseGeneration,
    checkoutSessionId: result.checkoutSessionId,
    customerId: result.customerId,
    subscriptionId: result.subscriptionId,
    mode: result.mode,
    planRevisionId: source.target_plan_revision_id,
  };
}

function assertPayload(
  command: BillingSubscriptionCommand,
  source: BillingSubscriptionCommand,
  authority: DeletionCheckoutAuthority,
) {
  const payload = command.request_payload;
  if (
    payload?.domain !== "account_deletion" ||
    payload.action !== "expire_checkout" ||
    command.kind !== "expire_checkout"
  )
    appBillingConflict("Cleanup journal has no expiration intent");
  const expected = payloadFor(source, authority);
  if (
    settlementDigest({
      ...expected,
      // Subscription Checkout acquires this handle only after completion; cleanup retains its original null.
      subscriptionId:
        payload.mode === "subscription" && payload.subscriptionId === null
          ? null
          : expected.subscriptionId,
      initiatingPhaseGeneration: payload.initiatingPhaseGeneration,
    }) !== command.request_digest ||
    settlementDigest(payload) !== command.request_digest ||
    command.billing_scope_id !== source.billing_scope_id ||
    command.requested_by_user_id !== source.requested_by_user_id
  )
    appBillingConflict("Checkout cleanup changed its original intent");
  return payload;
}

export type DeletionCheckoutClaim = {
  sourceCommandId: string;
  authority: DeletionCheckoutAuthority;
  lease: AppCommandLease;
  payload: DeletionCheckoutCommandPayload;
};

async function lockedClaim(tx: DbTransaction, claim: DeletionCheckoutClaim) {
  const locked = await lockSource(tx, claim.sourceCommandId, claim.authority);
  const [command] = await tx
    .select()
    .from(billingSubscriptionCommands)
    .where(eq(billingSubscriptionCommands.id, claim.lease.commandId))
    .for("update");
  if (!command) appBillingConflict("Checkout cleanup command disappeared");
  assertPayload(command, locked.source, claim.authority);
  await authorize(tx, locked.source, claim.authority, locked.requestOrganizationId);
  const now = await readPostLockDatabaseNow(tx);
  if (
    command.status !== "OUTCOME_UNKNOWN" ||
    command.lease_token !== claim.lease.token ||
    command.state_revision !== claim.lease.stateRevision ||
    command.execution_generation !== claim.lease.executionGeneration ||
    !command.lease_expires_at ||
    !Number.isFinite(command.lease_expires_at.getTime()) ||
    command.lease_expires_at <= now
  )
    appBillingConflict("Checkout cleanup lost its execution lease");
  return { ...locked, command, now };
}

export const appBillingDeletionCheckoutRepository = {
  async claim(
    sourceCommandId: string,
    authority: DeletionCheckoutAuthority,
  ): Promise<{ kind: "complete" | "busy" } | { kind: "claimed"; claim: DeletionCheckoutClaim }> {
    return writeTransaction(async (tx) => {
      const { source, requestOrganizationId } = await lockSource(tx, sourceCommandId, authority);
      const scopeId = source.billing_scope_id;
      if (scopeId === null) appBillingConflict("Checkout cleanup lost its scope");
      const key = `deletion-expire:${source.id}`;
      let [command] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.billing_scope_id, scopeId),
            eq(billingSubscriptionCommands.idempotency_key, key),
          ),
        )
        .for("update");
      await authorize(tx, source, authority, requestOrganizationId);
      if (!command) {
        const payload = payloadFor(source, authority);
        [command] = await tx
          .insert(billingSubscriptionCommands)
          .values({
            id: randomUUID(),
            app_id: source.app_id,
            livemode: source.livemode,
            merchant_id: source.merchant_id,
            organization_id: source.organization_id,
            billing_scope_id: source.billing_scope_id,
            merchant_key: source.merchant_key,
            subscription_id: source.subscription_id,
            requested_by_user_id: source.requested_by_user_id,
            kind: "expire_checkout",
            target_quantity: source.target_quantity,
            expected_subscription_revision: source.expected_subscription_revision,
            idempotency_key: key,
            provider_idempotency_key: `app-${key}`,
            request_digest: settlementDigest(payload),
            request_payload: payload,
          })
          .returning();
      }
      if (!command) appBillingConflict("Checkout cleanup was not persisted");
      const payload = assertPayload(command, source, authority);
      if (command.status === "SUCCEEDED") {
        if (command.provider_result?.kind === "completed_checkout") {
          if (
            source.status !== "APPLIED" ||
            source.result_subscription_id !== command.provider_result.subscriptionId ||
            source.result_subscription_revision !== command.provider_result.subscriptionRevision
          )
            appBillingConflict("Completed cleanup lost its applied purchase evidence");
        } else if (
          source.status !== "FAILED" ||
          source.error_code !== "APP_BILLING_CHECKOUT_EXPIRED"
        )
          appBillingConflict("Cleanup completion lost original expiration evidence");
        const proof = await tx.execute<{ valid: boolean }>(
          sql`SELECT app_billing_checkout_cleanup_receipt_valid(c) AS valid FROM billing_subscription_commands c WHERE c.id=${command.id}::uuid`,
        );
        if (!proof.rows[0]?.valid)
          appBillingConflict("Checkout cleanup has no verifiable retained provider observation");
        return { kind: "complete" };
      }
      if (!["PREPARED", "OUTCOME_UNKNOWN"].includes(command.status))
        appBillingConflict("Checkout cleanup has an unexpected terminal state");
      const now = await readPostLockDatabaseNow(tx);
      if (command.lease_expires_at && command.lease_expires_at > now) return { kind: "busy" };
      const token = randomUUID();
      const [claimed] = await tx
        .update(billingSubscriptionCommands)
        .set({
          status: "OUTCOME_UNKNOWN",
          state_revision: command.state_revision + 1,
          execution_generation: command.execution_generation + 1,
          attempt_count: command.attempt_count + 1,
          lease_token: token,
          lease_expires_at: new Date(now.getTime() + 180_000),
          provider_started_at: command.provider_started_at ?? now,
          updated_at: now,
        })
        .where(eq(billingSubscriptionCommands.id, command.id))
        .returning();
      if (!claimed) appBillingConflict("Checkout cleanup lease was not persisted");
      return {
        kind: "claimed",
        claim: {
          sourceCommandId,
          authority,
          payload,
          lease: {
            scopeId: scopeId,
            commandId: command.id,
            token,
            stateRevision: claimed.state_revision,
            executionGeneration: claimed.execution_generation,
          },
        },
      };
    });
  },
  async validateDispatch(claim: DeletionCheckoutClaim) {
    return writeTransaction(async (tx) => (await lockedClaim(tx, claim)).scope);
  },
  async complete(
    claim: DeletionCheckoutClaim,
    observation: BillingProviderObservation<
      BillingProviderCheckout | BillingProviderPaymentMethodCheckout
    >,
  ) {
    await writeTransaction(async (tx) => {
      const { source, scope, command, now } = await lockedClaim(tx, claim);
      const [merchant] = await tx
        .select({ accountId: billingMerchants.stripe_account_id })
        .from(billingMerchants)
        .where(eq(billingMerchants.id, scope.merchantId));
      if (
        observation.value.status !== "expired" ||
        observation.value.mode !== claim.payload.mode ||
        observation.value.sessionId !== claim.payload.checkoutSessionId ||
        observation.value.customerId !== claim.payload.customerId ||
        observation.merchantId !== scope.merchantId ||
        observation.livemode !== scope.livemode ||
        !merchant?.accountId ||
        observation.providerAccountId !== merchant.accountId
      )
        appBillingConflict("Cleanup requires exact provider expiration evidence");
      if (
        source.status === "APPLIED" ||
        (source.status === "FAILED" && source.error_code !== "APP_BILLING_CHECKOUT_EXPIRED")
      )
        appBillingConflict("Completed purchase cannot be expired by cleanup");
      if (source.status !== "FAILED")
        await tx
          .update(billingSubscriptionCommands)
          .set({
            status: "FAILED",
            error_code: "APP_BILLING_CHECKOUT_EXPIRED",
            completed_at: now,
            updated_at: now,
            lease_token: null,
            lease_expires_at: null,
            state_revision: source.state_revision + 1,
          })
          .where(eq(billingSubscriptionCommands.id, source.id));
      await tx
        .update(billingSubscriptionCommands)
        .set({
          status: "SUCCEEDED",
          provider_result: {
            kind: "expired_checkout",
            checkoutEvidence: {
              commandId: command.id,
              commandRevision: command.state_revision,
              executionGeneration: command.execution_generation,
              leaseToken: claim.lease.token,
              phaseGeneration: claim.authority.phaseGeneration,
              sourceCommandId: source.id,
              sourceRevision: source.state_revision + (source.status === "FAILED" ? 0 : 1),
              observation,
            },
            checkoutSessionId: claim.payload.checkoutSessionId,
          },
          provider_response_digest: observation.digest,
          completed_at: now,
          updated_at: now,
          error_code: null,
          lease_token: null,
          lease_expires_at: null,
          state_revision: command.state_revision + 1,
        })
        .where(eq(billingSubscriptionCommands.id, command.id));
    });
  },
  async completeApplied(
    claim: DeletionCheckoutClaim,
    observation: BillingProviderObservation<
      BillingProviderCheckout | BillingProviderPaymentMethodCheckout
    >,
  ) {
    await writeTransaction(async (tx) => {
      const { source, scope, command, now, principals, members } = await lockedClaim(tx, claim);
      const [merchant] = await tx
        .select({ accountId: billingMerchants.stripe_account_id })
        .from(billingMerchants)
        .where(eq(billingMerchants.id, scope.merchantId));
      if (
        observation.value.status !== "complete" ||
        observation.value.sessionId !== claim.payload.checkoutSessionId ||
        observation.value.customerId !== claim.payload.customerId ||
        observation.value.mode !== claim.payload.mode ||
        observation.merchantId !== scope.merchantId ||
        observation.livemode !== scope.livemode ||
        !merchant?.accountId ||
        observation.providerAccountId !== merchant.accountId ||
        !observation.value.subscriptionId ||
        source.status !== "APPLIED" ||
        !source.result_subscription_id ||
        !source.applied_at ||
        !source.provider_response_digest
      )
        appBillingConflict("Completed cleanup requires exact applied purchase evidence");
      const revisions = await tx
        .select()
        .from(billingSubscriptionRevisions)
        .where(
          and(
            eq(billingSubscriptionRevisions.subscription_id, source.result_subscription_id),
            eq(billingSubscriptionRevisions.organization_id, scope.organizationId),
            eq(
              billingSubscriptionRevisions.provider_object_digest,
              source.provider_response_digest,
            ),
            ...(source.result_subscription_revision === null
              ? []
              : [eq(billingSubscriptionRevisions.revision, source.result_subscription_revision)]),
          ),
        );
      if (revisions.length !== 1)
        appBillingConflict("Applied Checkout has no unique exact revision");
      const revision = revisions[0]!;
      if (
        revision.billing_scope_id !== scope.scopeId ||
        revision.merchant_key !== scope.merchantKey ||
        revision.provider_environment !== (scope.livemode ? "live" : "test") ||
        revision.stripe_customer_id !== observation.value.customerId ||
        revision.stripe_subscription_id !== observation.value.subscriptionId
      )
        appBillingConflict("Completed Checkout differs from its applied subscription revision");
      const [decision] = await tx
        .select()
        .from(appBillingDeletionDispositions)
        .where(
          and(
            eq(appBillingDeletionDispositions.request_id, claim.authority.requestId),
            eq(appBillingDeletionDispositions.scope_id, scope.scopeId),
          ),
        )
        .for("share");
      if (
        !decision ||
        decision.phase_receipt_id !== claim.authority.phaseReceiptId ||
        decision.phase_generation !== claim.authority.phaseGeneration ||
        decision.request_digest !== claim.authority.requestDigest ||
        decision.lifecycle_revision !== claim.authority.lifecycleRevision
      )
        appBillingConflict("Completed cleanup requires the current canonical scope disposition");
      if (decision.disposition === "retain_shared") {
        const survivor = members.some((member) => {
          const principal = principals.find((candidate) => candidate.id === member.user_id);
          return (
            member.app_id === scope.appId &&
            (member.livemode === null || member.livemode === scope.livemode) &&
            member.role === "administrator" &&
            principal &&
            principal.id !== source.requested_by_user_id &&
            principal.is_active &&
            !principal.deleted_at &&
            principal.account_lifecycle_state === "active" &&
            !principal.auth_fenced_at &&
            (!principal.expires_at ||
              (Number.isFinite(principal.expires_at.getTime()) && principal.expires_at > now))
          );
        });
        const closed = await tx
          .select({ id: appBillingDeletionDispositions.scope_id })
          .from(appBillingDeletionDispositions)
          .where(
            and(
              eq(appBillingDeletionDispositions.scope_id, scope.scopeId),
              eq(appBillingDeletionDispositions.disposition, "close"),
            ),
          );
        if (!survivor || closed.length)
          appBillingConflict("Completed shared cleanup lost its eligible survivor");
      }
      if (source.result_subscription_revision === null)
        await tx
          .update(billingSubscriptionCommands)
          .set({ result_subscription_revision: revision.revision })
          .where(eq(billingSubscriptionCommands.id, source.id));
      await tx
        .update(billingSubscriptionCommands)
        .set({
          status: "SUCCEEDED",
          provider_result: {
            kind: "completed_checkout",
            checkoutEvidence: {
              commandId: command.id,
              commandRevision: command.state_revision,
              executionGeneration: command.execution_generation,
              leaseToken: claim.lease.token,
              phaseGeneration: claim.authority.phaseGeneration,
              sourceCommandId: source.id,
              sourceRevision: source.state_revision,
              observation,
            },
            checkoutSessionId: claim.payload.checkoutSessionId,
            subscriptionId: source.result_subscription_id,
            subscriptionRevision: revision.revision,
          },
          provider_response_digest: observation.digest,
          completed_at: now,
          updated_at: now,
          error_code: null,
          lease_token: null,
          lease_expires_at: null,
          state_revision: command.state_revision + 1,
        })
        .where(eq(billingSubscriptionCommands.id, command.id));
    });
  },
  async release(claim: DeletionCheckoutClaim) {
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
