/**
 * Allocation and freezing of the `preferred_username` claim.
 *
 * The SSO contract requires this value to be stable, unique and lowercase-safe,
 * and no such column exists: `users.nickname` and `users.name` are both
 * nullable and non-unique. The relying party turns the claim into a permanent
 * account name and links future logins on it, so a value that changes orphans
 * an account and a value that collides can link a user into someone else's.
 *
 * This module takes the first candidate the naming policy
 * (`./username-policy.ts`) offers, freezes it in `oidc_user_profiles.username`
 * behind a unique index, and never rewrites it.
 */

import { type OidcUserProfile, oidcRepository } from "../../db/repositories/oidc";
import { deriveUsernameCandidates, type UsernameSeed, usernameWithSuffix } from "./username-policy";

export { deriveUsernameCandidates, normalizeUsernameCandidate } from "./username-policy";
export type { UsernameSeed };

const SUFFIX_ATTEMPTS = 12;

/**
 * Return the user's frozen username, allocating it on first use.
 *
 * Allocation is `INSERT … ON CONFLICT DO NOTHING` against two unique
 * constraints at once (`user_id` and `username`), so a concurrent allocation
 * for the same user resolves by re-reading the winner's row and a collision on
 * a candidate name simply moves to the next candidate. No transaction, no
 * read-then-write race.
 */
export async function resolveOidcUsername(seed: UsernameSeed): Promise<string> {
  const existing = await oidcRepository.findProfile(seed.id);
  if (existing) return existing.username;

  for (const candidate of deriveUsernameCandidates(seed)) {
    const allocated = await tryAllocate(seed.id, candidate);
    if (allocated) return allocated.username;

    for (let suffix = 2; suffix < 2 + SUFFIX_ATTEMPTS; suffix += 1) {
      const withTag = await tryAllocate(seed.id, usernameWithSuffix(candidate, suffix));
      if (withTag) return withTag.username;
    }
  }

  // Every candidate is taken, which in practice means a concurrent request
  // already wrote this user's row against the primary.
  const settled = await oidcRepository.findProfileForWrite(seed.id);
  if (settled) return settled.username;

  throw new Error(`OIDC username allocation exhausted every candidate for user ${seed.id}`);
}

async function tryAllocate(userId: string, username: string): Promise<OidcUserProfile | undefined> {
  const inserted = await oidcRepository.allocateUsername(userId, username);
  if (inserted) return inserted;
  // DO NOTHING fired: either this user already has a name (a concurrent
  // request won) or the candidate belongs to somebody else. Only the first is
  // a success, and re-reading the user's own row distinguishes them.
  return await oidcRepository.findProfileForWrite(userId);
}
