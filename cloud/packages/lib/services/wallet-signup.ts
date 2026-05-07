/**
 * Shared wallet-based signup: find or create user + org by wallet address.
 * Used by SIWE verify, wallet header auth, and x402 topup so slug, credits, and race
 * handling are consistent. WHY one path: avoids drift between SIWE/topup/wallet-auth.
 */

import { getAddress } from "viem";
import type { Organization } from "@/db/repositories/organizations";
import { organizationsRepository } from "@/db/repositories/organizations";
import type { UserWithOrganization } from "@/db/repositories/users";
import { usersRepository } from "@/db/repositories/users";
import { creditsService } from "@/lib/services/credits";
import { organizationsService } from "@/lib/services/organizations";
import { usersService } from "@/lib/services/users";

const INITIAL_FREE_CREDITS = ((): number => {
  const v = process.env.INITIAL_FREE_CREDITS;
  if (v === undefined || v === "") return 5;
  const n = Number.parseFloat(v);
  return Number.isNaN(n) || n < 0 ? 5 : n;
})();

export interface FindOrCreateWalletOptions {
  /** When true (default), grant INITIAL_FREE_CREDITS to new orgs. Set false for x402 topup so payment-only flows don't double-grant. */
  grantInitialCredits?: boolean;
}

/**
 * Find user by wallet, or create org + user and return.
 * Address can be any case; stored and slug use lowercase.
 * Used by SIWE, wallet header auth, and x402 topup (with grantInitialCredits: false).
 */
export async function findOrCreateUserByWalletAddress(
  walletAddress: string,
  options?: FindOrCreateWalletOptions,
): Promise<{ user: UserWithOrganization; isNewAccount: boolean }> {
  const address = getAddress(walletAddress);
  const normalized = address.toLowerCase();
  const grantInitialCredits = options?.grantInitialCredits !== false;

  const existing = await usersService.getByWalletAddressWithOrganization(address);
  if (existing) {
    return { user: existing, isNewAccount: false };
  }

  /* WHY slug wallet-${normalized}: consistent with topup and SIWE; lowercase for unique indexing. */
  const slug = `wallet-${normalized}`;
  let org: Organization | null = (await organizationsRepository.findBySlug(slug)) ?? null;
  if (!org) {
    try {
      org = await organizationsService.create({
        name: `Wallet ${address.slice(0, 6)}...${address.slice(-4)}`,
        slug,
        credit_balance: "0.00",
      });

      // Important: Only grant initial credits if we successfully created the org
      // This ensures only one credit grant happens even with concurrent requests
      if (grantInitialCredits && INITIAL_FREE_CREDITS > 0) {
        try {
          await creditsService.addCredits({
            organizationId: org.id,
            amount: INITIAL_FREE_CREDITS,
            description: "Wallet sign-up bonus",
            metadata: { type: "wallet_signup" },
          });
        } catch (err) {
          // Log but don't fail if credit grant fails - org is still usable
          console.error("Failed to grant initial credits:", err);
        }
      }
    } catch (e) {
      // Note: Handle race condition where two concurrent requests try to create the same org
      const isUniqueViolation =
        e instanceof Error && (e.message.includes("unique") || e.message.includes("duplicate"));
      if (!isUniqueViolation) throw e;

      // Important: For race conditions, retry finding the org that won the race
      org = (await organizationsRepository.findBySlug(slug)) ?? null;
      if (!org) {
        // If we still can't find it, something else went wrong
        throw new Error("Organization creation failed and could not find existing org");
      }
      // Note: Skip initial credits for raced org - first creator already granted them
    }
  }

  try {
    const created = await usersRepository.create({
      steward_user_id: `wallet:evm:${normalized}`,
      wallet_address: normalized,
      wallet_chain_type: "evm",
      wallet_verified: true,
      organization_id: org.id,
    });
    const user: UserWithOrganization = { ...created, organization: org };
    return { user, isNewAccount: true };
  } catch (e) {
    /* WHY handle unique violation: two concurrent signups for same wallet; second should see the first's user. */
    const isUniqueViolation =
      e instanceof Error && (e.message.includes("unique") || e.message.includes("duplicate"));
    if (!isUniqueViolation) throw e;
    const raced = await usersService.getByWalletAddressWithOrganization(address);
    if (!raced) throw e;
    return { user: raced, isNewAccount: false };
  }
}
