/** Leases customer-wide deletion in the existing command journal. Canonical owner and scope locks precede command locks; completion retains exact provider evidence without creating a subscription revision or granting access. */
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type {
  DeletionCustomerCommandPayload,
  DeletionCustomerCommandResult,
} from "../../lib/services/generic-billing-command-types";
import {
  type BillingProviderObservation,
  GENERIC_BILLING_STRIPE_API_VERSION,
} from "../../lib/services/generic-billing-provider-types";
import { settlementDigest } from "../../lib/services/settlement-digest";
import type { DbTransaction } from "../client";
import { writeTransaction } from "../helpers";
import { accountDeletionRequests } from "../schemas/account-deletion-requests";
import { appBillingScopes } from "../schemas/app-billing";
import { appBillingCustomerClosures } from "../schemas/app-billing-customer-closures";
import { billingSubscriptionCommands } from "../schemas/subscription-billing-operations";
import type { AppCommandLease } from "./app-billing-command-runtime";
import type { AppBillingDeletionRecoveryAuthority } from "./app-billing-deletion-authority";
import { appBillingConflict } from "./app-subscription-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export interface DeletionCustomerClaim {
  customerBindingId: string;
  authority: AppBillingDeletionRecoveryAuthority;
  payload: DeletionCustomerCommandPayload;
  lease: AppCommandLease;
}

async function lockClosure(
  tx: DbTransaction,
  bindingId: string,
  auth: AppBillingDeletionRecoveryAuthority,
) {
  if (auth.kind !== "account_deletion")
    appBillingConflict("Canonical customer deletion authority is required");
  await tx.execute(
    sql`SELECT require_app_billing_customer_closure(${bindingId}::uuid,${auth.requestId}::uuid,${auth.requestDigest},${auth.lifecycleRevision}::bigint,${auth.phaseReceiptId}::uuid,${auth.phaseGeneration}::bigint)`,
  );
  const [source] = await tx
    .select({ closure: appBillingCustomerClosures, scope: appBillingScopes })
    .from(appBillingCustomerClosures)
    .innerJoin(
      appBillingScopes,
      and(
        eq(appBillingScopes.billing_account_id, appBillingCustomerClosures.billing_account_id),
        eq(appBillingScopes.merchant_id, appBillingCustomerClosures.merchant_id),
      ),
    )
    .where(eq(appBillingCustomerClosures.customer_binding_id, bindingId))
    .orderBy(asc(appBillingScopes.id))
    .limit(1);
  if (!source) appBillingConflict("Customer deletion has no retained closure identity");
  return source;
}

async function terminal(
  tx: DbTransaction,
  bindingId: string,
  auth: AppBillingDeletionRecoveryAuthority,
  lease?: AppCommandLease,
) {
  if (lease) {
    await tx.execute(
      sql`SELECT require_app_billing_customer_terminal_obligations(${bindingId}::uuid,${auth.requestId}::uuid,${auth.requestDigest},${auth.lifecycleRevision}::bigint,${auth.phaseReceiptId}::uuid,${auth.phaseGeneration}::bigint,${lease.commandId}::uuid,${lease.token}::uuid,${lease.executionGeneration}::bigint,${lease.stateRevision}::bigint)`,
    );
  } else {
    await tx.execute(
      sql`SELECT require_app_billing_customer_terminal_obligations(${bindingId}::uuid,${auth.requestId}::uuid,${auth.requestDigest},${auth.lifecycleRevision}::bigint,${auth.phaseReceiptId}::uuid,${auth.phaseGeneration}::bigint)`,
    );
  }
}

async function validate(tx: DbTransaction, claim: DeletionCustomerClaim) {
  const source = await lockClosure(tx, claim.customerBindingId, claim.authority);
  await terminal(tx, claim.customerBindingId, claim.authority, claim.lease);
  const [command] = await tx
    .select()
    .from(billingSubscriptionCommands)
    .where(eq(billingSubscriptionCommands.id, claim.lease.commandId));
  if (
    !command ||
    command.billing_scope_id !== claim.lease.scopeId ||
    command.request_digest !== settlementDigest(claim.payload) ||
    command.request_digest !== settlementDigest(command.request_payload) ||
    claim.payload.customerBindingId !== claim.customerBindingId
  )
    appBillingConflict("Customer deletion claim differs from its retained journal intent");
  return { ...source, command };
}

export const appBillingDeletionCustomerRepository = {
  async claim(
    customerBindingId: string,
    authority: AppBillingDeletionRecoveryAuthority,
  ): Promise<{ kind: "complete" | "pending" } | { kind: "claimed"; claim: DeletionCustomerClaim }> {
    return writeTransaction(async (tx) => {
      const source = await lockClosure(tx, customerBindingId, authority);
      const { closure } = source;
      const idempotencyKey = `deletion-customer:${customerBindingId}`;
      const [existing] = await tx
        .select()
        .from(billingSubscriptionCommands)
        .where(
          and(
            eq(billingSubscriptionCommands.merchant_key, closure.provider_account_key),
            eq(billingSubscriptionCommands.provider_idempotency_key, `app-${idempotencyKey}`),
          ),
        )
        .for("update");
      let command = existing;
      if (!command) {
        await terminal(tx, customerBindingId, authority);
        const [request] = await tx
          .select({ userId: accountDeletionRequests.user_id })
          .from(accountDeletionRequests)
          .where(eq(accountDeletionRequests.id, authority.requestId));
        if (!request?.userId) appBillingConflict("Customer deletion request has no canonical user");
        const payload: DeletionCustomerCommandPayload = {
          version: 1,
          domain: "account_deletion",
          action: "delete_customer",
          customerBindingId,
          requestId: authority.requestId,
          requestDigest: authority.requestDigest,
          lifecycleRevision: authority.lifecycleRevision,
          phaseReceiptId: authority.phaseReceiptId,
          initiatingPhaseGeneration: authority.phaseGeneration,
          closureRequestId: closure.initiating_request_id,
          closureRequestDigest: closure.request_digest,
          billingAccountId: closure.billing_account_id,
          customerId: closure.stripe_customer_id,
          providerAccountId: closure.stripe_account_id,
        };
        [command] = await tx
          .insert(billingSubscriptionCommands)
          .values({
            app_id: closure.app_id,
            livemode: closure.livemode,
            merchant_id: closure.merchant_id,
            organization_id: source.scope.organization_id,
            billing_scope_id: source.scope.id,
            merchant_key: closure.provider_account_key,
            requested_by_user_id: request.userId,
            kind: "delete_customer",
            idempotency_key: idempotencyKey,
            provider_idempotency_key: `app-${idempotencyKey}`,
            request_digest: settlementDigest(payload),
            request_payload: payload,
          })
          .returning();
      }
      if (
        !command ||
        command.request_payload?.domain !== "account_deletion" ||
        command.request_payload.action !== "delete_customer" ||
        command.request_payload.customerBindingId !== customerBindingId ||
        command.request_digest !== settlementDigest(command.request_payload) ||
        !command.billing_scope_id
      )
        appBillingConflict("Customer deletion command lost its original identity");
      if (command.status === "SUCCEEDED") {
        await terminal(tx, customerBindingId, authority);
        if (
          command.provider_result?.kind !== "deleted_customer" ||
          command.provider_result.customerBindingId !== customerBindingId
        )
          appBillingConflict("Customer deletion has no retained completion receipt");
        const proof = await tx.execute<{ valid: boolean }>(
          sql`SELECT app_billing_customer_deletion_receipt_valid(c) AS valid FROM billing_subscription_commands c WHERE c.id=${command.id}::uuid`,
        );
        if (!proof.rows[0]?.valid)
          appBillingConflict(
            "Customer deletion receipt does not prove its original provider binding",
          );
        return { kind: "complete" };
      }
      if (command.status !== "PREPARED" && command.status !== "OUTCOME_UNKNOWN")
        appBillingConflict("Customer deletion has an unsupported journal state");
      const now = await readPostLockDatabaseNow(tx);
      if (command.lease_token && command.lease_expires_at && command.lease_expires_at > now)
        return { kind: "pending" };
      const lease: AppCommandLease = {
        scopeId: command.billing_scope_id,
        commandId: command.id,
        token: randomUUID(),
        stateRevision: command.state_revision + 1,
        executionGeneration: command.execution_generation + 1,
      };
      await tx
        .update(billingSubscriptionCommands)
        .set({
          status: "OUTCOME_UNKNOWN",
          lease_token: lease.token,
          lease_expires_at: new Date(now.getTime() + 60_000),
          state_revision: lease.stateRevision,
          execution_generation: lease.executionGeneration,
          attempt_count: command.attempt_count + 1,
          provider_started_at: command.provider_started_at ?? now,
          error_code: null,
          updated_at: now,
        })
        .where(eq(billingSubscriptionCommands.id, command.id));
      const claim: DeletionCustomerClaim = {
        customerBindingId,
        authority,
        payload: command.request_payload,
        lease,
      };
      await validate(tx, claim);
      return { kind: "claimed", claim };
    });
  },
  async validateDispatch(claim: DeletionCustomerClaim) {
    return writeTransaction(async (tx) => {
      const { closure, command } = await validate(tx, claim);
      return {
        scopeId: claim.lease.scopeId,
        appId: closure.app_id,
        billingAccountId: closure.billing_account_id,
        merchantId: closure.merchant_id,
        livemode: closure.livemode,
        providerIdempotencyKey: command.provider_idempotency_key,
      };
    });
  },
  async complete(
    claim: DeletionCustomerClaim,
    observation: BillingProviderObservation<{ customerId: string; status: "deleted" }>,
  ) {
    return writeTransaction(async (tx) => {
      const { closure, command } = await validate(tx, claim);
      const now = await readPostLockDatabaseNow(tx);
      const observedAt = new Date(observation.observedAt);
      if (
        observation.value.status !== "deleted" ||
        observation.value.customerId !== closure.stripe_customer_id ||
        observation.merchantId !== closure.merchant_id ||
        observation.providerAccountId !== closure.stripe_account_id ||
        observation.livemode !== closure.livemode ||
        observation.apiVersion !== GENERIC_BILLING_STRIPE_API_VERSION ||
        observation.digest !== settlementDigest(observation.value) ||
        observation.inputDigest !==
          settlementDigest({
            operation: "inspectBoundCustomer",
            scope: {
              scopeId: claim.lease.scopeId,
              appId: closure.app_id,
              billingAccountId: closure.billing_account_id,
            },
            customerId: closure.stripe_customer_id,
          }) ||
        !Number.isFinite(observedAt.getTime()) ||
        !command.provider_started_at ||
        observedAt < command.provider_started_at ||
        observedAt > now
      )
        appBillingConflict(
          "Customer deletion observation does not prove its exact retained customer",
        );
      const { requestId, requestDigest, lifecycleRevision, phaseReceiptId, phaseGeneration } =
        claim.authority;
      const result: DeletionCustomerCommandResult = {
        kind: "deleted_customer",
        customerBindingId: claim.customerBindingId,
        observation,
        completionAuthority: {
          requestId,
          requestDigest,
          lifecycleRevision,
          phaseReceiptId,
          phaseGeneration,
        },
      };
      await tx
        .update(billingSubscriptionCommands)
        .set({
          status: "SUCCEEDED",
          provider_result: result,
          provider_response_digest: observation.digest,
          completed_at: now,
          state_revision: command.state_revision + 1,
          lease_token: null,
          lease_expires_at: null,
          error_code: null,
          updated_at: now,
        })
        .where(eq(billingSubscriptionCommands.id, command.id));
    });
  },
  async release(claim: DeletionCustomerClaim) {
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
