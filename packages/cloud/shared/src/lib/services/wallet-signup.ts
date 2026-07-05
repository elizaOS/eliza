/**
 * Shared wallet-based signup: find or create user + org by wallet address.
 * Used by SIWE verify, wallet header auth, and x402 topup so slug, credits, and race
 * handling are consistent. WHY one path: avoids drift between SIWE/topup/wallet-auth.
 */

import { getAddress } from "viem";
import type { Organization } from "../../db/repositories/organizations";
import { organizationsRepository } from "../../db/repositories/organizations";
import type { UserWithOrganization } from "../../db/repositories/users";
import { usersRepository } from "../../db/repositories/users";
import { getClientIp } from "../runtime/request-context";
import { logger } from "../utils/logger";
import { creditsService } from "./credits";
import { organizationsService } from "./organizations";
import {
  runWithSignupGrantIpCapDetailed,
  type SignupGrantWithheldReason,
} from "./signup-grant-guard";
import { usersService } from "./users";

export const INITIAL_FREE_CREDITS = ((): number => {
  const v = process.env.INITIAL_FREE_CREDITS;
  if (v === undefined || v.trim() === "") return 5;
  const trimmed = v.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    throw new Error(`[WalletSignup] INITIAL_FREE_CREDITS must be a non-negative decimal`);
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    throw new Error(`[WalletSignup] INITIAL_FREE_CREDITS must be finite`);
  }
  return n;
})();

export interface FindOrCreateWalletOptions {
  /** When true (default), grant INITIAL_FREE_CREDITS to new orgs. Set false for x402 topup so payment-only flows don't double-grant. */
  grantInitialCredits?: boolean;
  /** When true, fail signup if the initial free-credit grant cannot be confirmed. */
  requireInitialCredits?: boolean;
}

export interface InitialCreditGrantMetadata {
  initialCreditsGranted: boolean;
  initialFreeCreditsUsd: number;
  welcomeBonusWithheld?: boolean;
  welcomeBonusWithheldReason?: SignupGrantWithheldReason;
  welcomeBonusWithheldMessage?: string;
}

async function grantWalletSignupCredits(params: {
  organizationId: string;
  amount: number;
  chain: "evm" | "solana";
  idempotencyKey: string;
  requireInitialCredits: boolean;
}): Promise<InitialCreditGrantMetadata> {
  if (params.amount <= 0) {
    return { initialCreditsGranted: false, initialFreeCreditsUsd: 0 };
  }

  // Anti-sybil: withhold the bonus when this IP has hit the daily free-grant
  // cap. The cap check and the grant run under a per-IP advisory lock so
  // concurrent same-IP signups cannot each pass the cap before any commits.
  const signupIp = getClientIp();
  try {
    const decision = await runWithSignupGrantIpCapDetailed(signupIp, async (tx) => {
      await creditsService.addCredits({
        organizationId: params.organizationId,
        amount: params.amount,
        description: "Wallet sign-up bonus",
        stripePaymentIntentId: params.idempotencyKey,
        metadata: { type: "wallet_signup", chain: params.chain, ip_address: signupIp },
        db: tx,
      });
    });
    return {
      initialCreditsGranted: decision.granted,
      initialFreeCreditsUsd: decision.granted ? params.amount : 0,
      ...(decision.withheldReason
        ? {
            welcomeBonusWithheld: true,
            welcomeBonusWithheldReason: decision.withheldReason,
            welcomeBonusWithheldMessage: decision.withheldMessage,
          }
        : {}),
    };
  } catch (err) {
    // error-policy:J4 explicit user-facing degrade — wallet signup may continue
    // without optional welcome credits only when the caller has not required the
    // grant; metadata distinguishes the withheld bonus from a normal zero grant.
    logger.error("[WalletSignup] Failed to grant initial credits:", err);
    if (params.requireInitialCredits) {
      throw err;
    }
    return {
      initialCreditsGranted: false,
      initialFreeCreditsUsd: 0,
      welcomeBonusWithheld: true,
      welcomeBonusWithheldMessage: "Initial credit grant failed; signup continued without bonus.",
    };
  }
}

export async function grantInitialCreditsToWalletAccount(params: {
  organizationId: string;
  walletAddress: string;
  chain?: "evm";
  requireInitialCredits?: boolean;
}): Promise<{
  initialCreditsGranted: boolean;
  initialFreeCreditsUsd: number;
  welcomeBonusWithheld?: boolean;
  welcomeBonusWithheldReason?: SignupGrantWithheldReason;
  welcomeBonusWithheldMessage?: string;
}> {
  const address = getAddress(params.walletAddress);
  const normalized = address.toLowerCase();
  const grantResult =
    INITIAL_FREE_CREDITS > 0
      ? await grantWalletSignupCredits({
          organizationId: params.organizationId,
          amount: INITIAL_FREE_CREDITS,
          chain: params.chain ?? "evm",
          idempotencyKey: `wallet-signup:evm:${normalized}`,
          requireInitialCredits: params.requireInitialCredits === true,
        })
      : { initialCreditsGranted: false, initialFreeCreditsUsd: 0 };

  return grantResult;
}

/**
 * Find user by wallet, or create org + user and return.
 * Address can be any case; stored and slug use lowercase.
 * Used by SIWE, wallet header auth, and x402 topup (with grantInitialCredits: false).
 */
export async function findOrCreateUserByWalletAddress(
  walletAddress: string,
  options?: FindOrCreateWalletOptions,
): Promise<{
  user: UserWithOrganization;
  isNewAccount: boolean;
  initialCreditsGranted?: boolean;
  initialFreeCreditsUsd?: number;
  welcomeBonusWithheld?: boolean;
  welcomeBonusWithheldReason?: SignupGrantWithheldReason;
  welcomeBonusWithheldMessage?: string;
}> {
  const address = getAddress(walletAddress);
  const normalized = address.toLowerCase();
  const grantInitialCredits = options?.grantInitialCredits !== false;
  const requireInitialCredits = options?.requireInitialCredits === true;

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
    } catch (e) {
      // error-policy:J3 unique-violation race recovery — retry only the expected
      // concurrent org-create collision; all other creation failures propagate.
      const isUniqueViolation =
        e instanceof Error && (e.message.includes("unique") || e.message.includes("duplicate"));
      if (!isUniqueViolation) throw e;

      org = (await organizationsRepository.findBySlug(slug)) ?? null;
      if (!org) {
        throw new Error("Organization creation failed and could not find existing org");
      }
    }
  }
  const initialCreditGrant =
    grantInitialCredits && INITIAL_FREE_CREDITS > 0
      ? await grantWalletSignupCredits({
          organizationId: org.id,
          amount: INITIAL_FREE_CREDITS,
          chain: "evm",
          idempotencyKey: `wallet-signup:evm:${normalized}`,
          requireInitialCredits,
        })
      : { initialCreditsGranted: false, initialFreeCreditsUsd: 0 };

  try {
    const created = await usersRepository.create({
      steward_user_id: `wallet:evm:${normalized}`,
      wallet_address: normalized,
      wallet_chain_type: "evm",
      wallet_verified: true,
      organization_id: org.id,
      // The signup creates this org for the wallet — its creator manages it
      // (matches the anonymous-migration path in session.ts). Without this the
      // sole member of a fresh wallet org is a plain "member" and can never
      // invite teammates or manage the org they own.
      role: "owner",
    });
    const user: UserWithOrganization = { ...created, organization: org };
    return {
      user,
      isNewAccount: true,
      ...initialCreditGrant,
    };
  } catch (e) {
    // error-policy:J3 unique-violation race recovery — the losing concurrent
    // signup returns the winner's row; missing re-fetch rethrows the original.
    const isUniqueViolation =
      e instanceof Error && (e.message.includes("unique") || e.message.includes("duplicate"));
    if (!isUniqueViolation) throw e;
    const raced = await usersService.getByWalletAddressWithOrganization(address);
    if (!raced) throw e;
    return { user: raced, isNewAccount: false };
  }
}

/**
 * Find or create a user for a Solana wallet.
 * Solana base58 addresses are case-sensitive, so this path must not pass
 * through EVM checksum normalization or lowercase storage.
 */
export async function findOrCreateSolanaUserByWalletAddress(
  walletAddress: string,
  options?: FindOrCreateWalletOptions,
): Promise<{
  user: UserWithOrganization;
  isNewAccount: boolean;
  initialCreditsGranted?: boolean;
  initialFreeCreditsUsd?: number;
  welcomeBonusWithheld?: boolean;
  welcomeBonusWithheldReason?: SignupGrantWithheldReason;
  welcomeBonusWithheldMessage?: string;
}> {
  const address = walletAddress.trim();
  if (!address) {
    throw new Error("Wallet address is required");
  }
  const grantInitialCredits = options?.grantInitialCredits !== false;
  const requireInitialCredits = options?.requireInitialCredits === true;

  const existing = await usersRepository.findBySolanaWalletAddressWithOrganization(address);
  if (existing) {
    return { user: existing, isNewAccount: false };
  }

  const slug = `wallet-solana-${address}`;
  let org: Organization | null = (await organizationsRepository.findBySlug(slug)) ?? null;
  if (!org) {
    try {
      org = await organizationsService.create({
        name: `Solana Wallet ${address.slice(0, 6)}...${address.slice(-4)}`,
        slug,
        credit_balance: "0.00",
      });
    } catch (e) {
      // error-policy:J3 unique-violation race recovery — retry only the expected
      // concurrent org-create collision; all other creation failures propagate.
      const isUniqueViolation =
        e instanceof Error && (e.message.includes("unique") || e.message.includes("duplicate"));
      if (!isUniqueViolation) throw e;

      org = (await organizationsRepository.findBySlug(slug)) ?? null;
      if (!org) {
        throw new Error("Organization creation failed and could not find existing Solana org");
      }
    }
  }
  const initialCreditGrant =
    grantInitialCredits && INITIAL_FREE_CREDITS > 0
      ? await grantWalletSignupCredits({
          organizationId: org.id,
          amount: INITIAL_FREE_CREDITS,
          chain: "solana",
          idempotencyKey: `wallet-signup:solana:${address}`,
          requireInitialCredits,
        })
      : { initialCreditsGranted: false, initialFreeCreditsUsd: 0 };

  try {
    const created = await usersRepository.create({
      steward_user_id: `wallet:solana:${address}`,
      wallet_address: address,
      wallet_chain_type: "solana",
      wallet_verified: true,
      organization_id: org.id,
      // Creator of the fresh wallet org manages it — see the EVM path above.
      role: "owner",
    });
    const user: UserWithOrganization = { ...created, organization: org };
    return {
      user,
      isNewAccount: true,
      ...initialCreditGrant,
    };
  } catch (e) {
    // error-policy:J3 unique-violation race recovery — the losing concurrent
    // signup returns the winner's row; missing re-fetch rethrows the original.
    const isUniqueViolation =
      e instanceof Error && (e.message.includes("unique") || e.message.includes("duplicate"));
    if (!isUniqueViolation) throw e;
    const raced = await usersRepository.findBySolanaWalletAddressWithOrganization(address);
    if (!raced) throw e;
    return { user: raced, isNewAccount: false };
  }
}
