/** Account-lifecycle fencing for Personal Shared participant consent. */
import { ElizaError } from "@elizaos/core/edge";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import {
  personalSharedGroupBindings,
  personalSharedGroupJoinChallenges,
  personalSharedGroupParticipants,
} from "../schemas/personal-shared-groups";
import { users } from "../schemas/users";

/**
 * Revokes every consent authority tied to one user inside the caller's user
 * mutation transaction. User-associated consent paths all take the durable
 * account lock before binding -> challenge -> participant authority, so an
 * account mutation cannot miss a concurrent confirmation and later resurrect
 * it. A live uncommitted provider lease fails closed and leaves the entire
 * account mutation retryable.
 */
export async function revokePersonalSharedGroupConsentForUser(
  tx: DbTransaction,
  linkedUserId: string,
  now: Date,
): Promise<{ revokedBindings: number; consumedChallenges: number }> {
  const [linkedUser] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, linkedUserId))
    .limit(1)
    .for("update");
  if (!linkedUser) return { revokedBindings: 0, consumedChallenges: 0 };

  const participantBindings = await tx
    .select({ id: personalSharedGroupParticipants.binding_id })
    .from(personalSharedGroupParticipants)
    .where(eq(personalSharedGroupParticipants.linked_user_id, linkedUserId));
  const challengeBindings = await tx
    .select({ id: personalSharedGroupJoinChallenges.binding_id })
    .from(personalSharedGroupJoinChallenges)
    .where(
      and(
        eq(personalSharedGroupJoinChallenges.linked_user_id, linkedUserId),
        isNull(personalSharedGroupJoinChallenges.consumed_at),
      ),
    );
  const candidateBindingIds = [
    ...new Set([...participantBindings, ...challengeBindings].map(({ id }) => id)),
  ].sort();

  const bindings =
    candidateBindingIds.length === 0
      ? []
      : await tx
          .select({
            id: personalSharedGroupBindings.id,
            leaseCommittedAt: personalSharedGroupBindings.delivery_lease_committed_at,
            leaseExpiresAt: personalSharedGroupBindings.delivery_lease_expires_at,
          })
          .from(personalSharedGroupBindings)
          .where(inArray(personalSharedGroupBindings.id, candidateBindingIds))
          .orderBy(personalSharedGroupBindings.id)
          .for("update");

  const challenges = await tx
    .select({ id: personalSharedGroupJoinChallenges.id })
    .from(personalSharedGroupJoinChallenges)
    .where(
      and(
        eq(personalSharedGroupJoinChallenges.linked_user_id, linkedUserId),
        isNull(personalSharedGroupJoinChallenges.consumed_at),
      ),
    )
    .orderBy(personalSharedGroupJoinChallenges.id)
    .for("update");

  if (
    bindings.some(
      (binding) =>
        binding.leaseCommittedAt === null &&
        binding.leaseExpiresAt !== null &&
        binding.leaseExpiresAt > now,
    )
  ) {
    throw new ElizaError("A live group delivery reservation is still pending", {
      code: "PERSONAL_SHARED_GROUP_DELIVERY_PENDING",
      severity: "fatal",
    });
  }

  const bindingIds = bindings.map((binding) => binding.id);
  if (bindingIds.length > 0) {
    await tx
      .update(personalSharedGroupBindings)
      .set({
        authority_version: sql`${personalSharedGroupBindings.authority_version} + 1`,
        consent_version: sql`${personalSharedGroupBindings.consent_version} + 1`,
        updated_at: now,
      })
      .where(inArray(personalSharedGroupBindings.id, bindingIds));
    await tx
      .update(personalSharedGroupParticipants)
      .set({
        linked_user_id: null,
        consented_at: null,
        consent_provenance: null,
        revoked_at: now,
      })
      .where(eq(personalSharedGroupParticipants.linked_user_id, linkedUserId));
  }

  if (challenges.length > 0) {
    await tx
      .update(personalSharedGroupJoinChallenges)
      .set({ consumed_at: now })
      .where(
        inArray(
          personalSharedGroupJoinChallenges.id,
          challenges.map(({ id }) => id),
        ),
      );
  }

  return {
    revokedBindings: bindingIds.length,
    consumedChallenges: challenges.length,
  };
}
