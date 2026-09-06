/** Freezes purchaser/developer scope decisions under a current canonical Stripe deletion lease. Invoke outside existing deletion transactions: organization locks precede scope/account, user/member, request, and phase locks. This foundation never certifies provider completion or authorizes physical erasure. */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { writeTransaction } from "../helpers";
import { accountDeletionPhaseReceipts } from "../schemas/account-deletion-phase-receipts";
import { accountDeletionRequests } from "../schemas/account-deletion-requests";
import { appBillingMembers, appBillingScopes } from "../schemas/app-billing";
import { appBillingDeletionDispositions } from "../schemas/app-billing-deletion-dispositions";
import { organizations } from "../schemas/organizations";
import { users } from "../schemas/users";
import type { AppBillingDeletionRecoveryAuthority } from "./app-billing-deletion-authority";
import { appBillingConflict, lockAppBillingScope } from "./app-subscription-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";

export async function decideAppBillingDeletionScope(input: {
  scopeId: string;
  authority: AppBillingDeletionRecoveryAuthority;
}) {
  return writeTransaction(async (tx) => {
    const [observed] = await tx
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
      .where(eq(accountDeletionRequests.id, input.authority.requestId));
    const [observedScope] = await tx
      .select()
      .from(appBillingScopes)
      .where(eq(appBillingScopes.id, input.scopeId));
    if (!observed?.user_id || !observed.organization_id || !observedScope)
      appBillingConflict("Deletion scope or canonical subject is unavailable");
    const ownerIds = [...new Set([observed.organization_id, observedScope.organization_id])].sort();
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
    if (owners.length !== ownerIds.length) appBillingConflict("Deletion owner is unavailable");
    const scope = await lockAppBillingScope(tx, input.scopeId, true);
    if (scope.organizationId !== observedScope.organization_id)
      appBillingConflict("Deletion scope ownership changed");
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
      ...new Set([observed.user_id, ...observedMembers.map((member) => member.user_id)]),
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
      appBillingConflict("Deletion membership changed; retry the scope decision");
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
      .where(eq(accountDeletionRequests.id, input.authority.requestId))
      .for("share");
    const [phase] = await tx
      .select({
        id: accountDeletionPhaseReceipts.id,
        phase: accountDeletionPhaseReceipts.phase,
        lease_generation: accountDeletionPhaseReceipts.lease_generation,
        lease_expires_at: accountDeletionPhaseReceipts.lease_expires_at,
        status: accountDeletionPhaseReceipts.status,
      })
      .from(accountDeletionPhaseReceipts)
      .where(
        and(
          eq(accountDeletionPhaseReceipts.id, input.authority.phaseReceiptId),
          eq(accountDeletionPhaseReceipts.request_id, input.authority.requestId),
        ),
      )
      .for("share");
    const now = await readPostLockDatabaseNow(tx);
    const deletingUser = principals.find((principal) => principal.id === observed.user_id);
    const deletingOwner = owners.find((owner) => owner.id === observed.organization_id);
    if (
      input.authority.kind !== "account_deletion" ||
      !request ||
      !phase ||
      request.user_id !== observed.user_id ||
      request.organization_id !== observed.organization_id ||
      request.status !== "processing" ||
      !request.irreversible_at ||
      request.request_digest !== input.authority.requestDigest ||
      request.lifecycle_revision !== input.authority.lifecycleRevision ||
      phase.phase !== "stripe" ||
      phase.lease_generation !== input.authority.phaseGeneration ||
      !phase.lease_expires_at ||
      !Number.isFinite(phase.lease_expires_at.getTime()) ||
      phase.lease_expires_at <= now ||
      !["leased", "calling", "reconciling"].includes(phase.status) ||
      deletingUser?.account_lifecycle_state !== "deletion_irreversible" ||
      deletingUser.account_deletion_request_id !== request.id ||
      deletingUser.account_lifecycle_revision !== request.lifecycle_revision ||
      deletingOwner?.account_lifecycle_state !== "deletion_irreversible" ||
      deletingOwner.account_deletion_request_id !== request.id ||
      deletingOwner.account_lifecycle_revision !== request.lifecycle_revision
    )
      appBillingConflict(
        "Scope disposition requires the current irreversible Stripe deletion lease",
      );
    const relevant = members.filter(
      (member) =>
        member.app_id === scope.appId &&
        (member.livemode === null || member.livemode === scope.livemode) &&
        member.role === "administrator",
    );
    const developer = request.organization_id === scope.organizationId;
    if (!developer && !relevant.some((member) => member.user_id === request.user_id))
      appBillingConflict("Deleting subject does not administer this billing scope");
    const survivor = relevant.some((member) => {
      const principal = principals.find((candidate) => candidate.id === member.user_id);
      return (
        principal &&
        principal.id !== request.user_id &&
        principal.is_active &&
        !principal.deleted_at &&
        principal.account_lifecycle_state === "active" &&
        !principal.auth_fenced_at &&
        (!principal.expires_at || principal.expires_at > now)
      );
    });
    const [closing] = await tx
      .select()
      .from(appBillingDeletionDispositions)
      .where(
        and(
          eq(appBillingDeletionDispositions.scope_id, scope.scopeId),
          eq(appBillingDeletionDispositions.disposition, "close"),
        ),
      )
      .limit(1);
    const disposition = developer || !survivor || closing ? "close" : "retain_shared";
    if (disposition === "close")
      await tx
        .update(appBillingScopes)
        .set({ fenced_at: sql`COALESCE(${appBillingScopes.fenced_at},${now})` })
        .where(eq(appBillingScopes.id, scope.scopeId));
    const [decision] = await tx
      .insert(appBillingDeletionDispositions)
      .values({
        request_id: request.id,
        scope_id: scope.scopeId,
        request_digest: input.authority.requestDigest,
        lifecycle_revision: request.lifecycle_revision,
        phase_receipt_id: phase.id,
        phase_generation: phase.lease_generation,
        merchant_id: scope.merchantId,
        provider_account_key: scope.merchantKey,
        livemode: scope.livemode,
        disposition,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [
          appBillingDeletionDispositions.request_id,
          appBillingDeletionDispositions.scope_id,
        ],
        set: { disposition, phase_generation: phase.lease_generation, updated_at: now },
      })
      .returning();
    if (!decision) appBillingConflict("Deletion disposition was not persisted");
    return decision;
  });
}
