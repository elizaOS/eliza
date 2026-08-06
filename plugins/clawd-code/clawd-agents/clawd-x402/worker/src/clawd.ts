/**
 * $CLAWD holder discount.
 *
 * Callers who hold $CLAWD in the wallet that pays get a tier-based discount
 * on every agent call. The gateway checks this once per request, before
 * emitting the 402 challenge, and applies the discount to `maxAmountRequired`.
 *
 * Tiers come from env vars so they're easy to re-tune without redeploying
 * the Anchor program.
 */

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Env } from "./types";
import { getTokenAccountBalance } from "./solana/rpc";

export interface DiscountTier {
  tier: 0 | 1 | 2 | 3;
  bps: number;
}

export async function holderDiscount(env: Env, walletPubkey: string): Promise<DiscountTier> {
  if (!walletPubkey) return { tier: 0, bps: 0 };

  try {
    const mint = new PublicKey(env.CLAWD_MINT);
    const owner = new PublicKey(walletPubkey);
    const ata = getAssociatedTokenAddressSync(mint, owner, true);

    let balance: bigint;
    try {
      balance = await getTokenAccountBalance(env, ata.toBase58());
    } catch {
      // Account doesn't exist — zero balance.
      balance = 0n;
    }

    if (balance >= BigInt(env.DISCOUNT_TIER_3_BALANCE)) {
      return { tier: 3, bps: env.DISCOUNT_TIER_3_BPS };
    }
    if (balance >= BigInt(env.DISCOUNT_TIER_2_BALANCE)) {
      return { tier: 2, bps: env.DISCOUNT_TIER_2_BPS };
    }
    if (balance >= BigInt(env.DISCOUNT_TIER_1_BALANCE)) {
      return { tier: 1, bps: env.DISCOUNT_TIER_1_BPS };
    }
    return { tier: 0, bps: 0 };
  } catch {
    return { tier: 0, bps: 0 };
  }
}

/** Apply a discount (in bps) to a base-units amount. Never returns less than 1. */
export function applyDiscount(amount: bigint, discountBps: number): bigint {
  if (discountBps <= 0) return amount;
  const keep = 10000n - BigInt(Math.min(discountBps, 10000));
  const discounted = (amount * keep) / 10000n;
  return discounted > 0n ? discounted : 1n;
}
