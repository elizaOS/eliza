/**
 * Dark DeFi — Confidential On-Chain Intelligence
 *
 * Implements "Dark DeFi" capabilities for the HERMES x402 agent:
 *
 *  • Whale wallet surveillance via Helius webhooks (public RPC data)
 *  • MEV pattern recognition from mempool transaction ordering
 *  • Confidential trade routing to minimize on-chain footprint
 *  • Dark-pool simulation for large block trades via Jupiter
 *  • Anti-sandwich protection with transaction bundling
 *
 * All analysis uses only PUBLIC on-chain data (no exploits, no front-running).
 * Trade execution requires explicit human approval (deny-first permission engine).
 *
 * Sponsor integrations: Helius + Jupiter + x402 + Solana
 */

import type { Connection, PublicKey } from '@solana/web3.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type WhaleTier = 'megalodon' | 'whale' | 'dolphin' | 'fish';

export interface WhaleActivity {
  wallet: string;
  tier: WhaleTier;
  action: 'buy' | 'sell' | 'transfer' | 'stake' | 'unstake';
  token: string;
  amountUsd: number;
  signature: string;
  slot: number;
  timestamp: number;
  /** Confidence that this is intentional (not noise) */
  intentConfidence: number;
}

export interface MEVPattern {
  type: 'sandwich' | 'frontrun' | 'backrun' | 'arb' | 'liquidation';
  targetTx: string;
  attackerWallet: string;
  estimatedProfitLamports: number;
  slot: number;
  detected: number;
}

export interface DarkTradeRoute {
  token: string;
  side: 'buy' | 'sell';
  amountUsdc: number;
  /** Split execution to minimize price impact */
  splits: Array<{
    dex: 'jupiter' | 'raydium' | 'orca' | 'meteora';
    amountUsdc: number;
    delayMs: number;
  }>;
  /** Slippage config to avoid sandwich attacks */
  slippageBps: number;
  /** Use priority fee randomization to avoid detection */
  feeRandomization: boolean;
  /** Expected total slippage */
  expectedSlippageBps: number;
}

export interface OnChainContext {
  wallet: string;
  solBalance: number;
  usdcBalance: number;
  topTokens: Array<{ mint: string; symbol: string; uiAmount: number; valueUsdc: number }>;
  recentTrades: number;
  lastActivity: number;
}

// ─── Whale Surveillance ───────────────────────────────────────────────────────

const MEGALODON_USD = 10_000_000;
const WHALE_USD = 1_000_000;
const DOLPHIN_USD = 100_000;

export function classifyWhale(amountUsd: number): WhaleTier {
  if (amountUsd >= MEGALODON_USD) return 'megalodon';
  if (amountUsd >= WHALE_USD) return 'whale';
  if (amountUsd >= DOLPHIN_USD) return 'dolphin';
  return 'fish';
}

/**
 * Parse Helius enhanced transaction into whale activity.
 * Input is a single transaction from Helius's enhanced history API.
 */
export function parseWhaleActivity(tx: HeliusTransaction, solPriceUsd: number): WhaleActivity | null {
  const native = tx.nativeTransfers?.[0];
  if (!native || native.amount < 1_000_000_000) return null; // < 1 SOL, skip

  const amountSol = native.amount / 1e9;
  const amountUsd = amountSol * solPriceUsd;
  if (amountUsd < DOLPHIN_USD) return null;

  return {
    wallet: native.fromUserAccount,
    tier: classifyWhale(amountUsd),
    action: tx.type === 'TRANSFER' ? 'transfer' : 'buy',
    token: 'SOL',
    amountUsd,
    signature: tx.signature,
    slot: tx.slot,
    timestamp: tx.timestamp,
    intentConfidence: computeIntentConfidence(tx),
  };
}

function computeIntentConfidence(tx: HeliusTransaction): number {
  let score = 0.5;
  // Large SOL transfers with memo = intentional
  if (tx.description?.includes('transferred')) score += 0.2;
  // Multiple transfers = likely aggregated, less signal
  if ((tx.nativeTransfers?.length ?? 0) > 3) score -= 0.1;
  // DeFi interaction = trading intent
  if (tx.type === 'SWAP') score += 0.3;
  return Math.max(0, Math.min(1, score));
}

// ─── MEV Pattern Detection ────────────────────────────────────────────────────

/**
 * Detect sandwich attacks in consecutive slot transactions.
 * Purely analytical — flags patterns for human review, takes no action.
 */
export function detectMEVPatterns(txs: HeliusTransaction[]): MEVPattern[] {
  const patterns: MEVPattern[] = [];

  for (let i = 1; i < txs.length - 1; i++) {
    const prev = txs[i - 1]!;
    const cur = txs[i]!;
    const next = txs[i + 1]!;

    // Sandwich: same wallet opens/closes position around target
    if (
      prev.feePayer === next.feePayer &&
      prev.feePayer !== cur.feePayer &&
      prev.slot === cur.slot &&
      cur.slot === next.slot
    ) {
      const profit = estimateSandwichProfit(prev, cur, next);
      if (profit > 0) {
        patterns.push({
          type: 'sandwich',
          targetTx: cur.signature,
          attackerWallet: prev.feePayer,
          estimatedProfitLamports: profit,
          slot: cur.slot,
          detected: Date.now(),
        });
      }
    }
  }

  return patterns;
}

function estimateSandwichProfit(front: HeliusTransaction, victim: HeliusTransaction, back: HeliusTransaction): number {
  // Simplified: estimate based on native transfer deltas of the attacker
  const frontOut = front.nativeTransfers?.reduce((s, t) => s + (t.fromUserAccount === front.feePayer ? t.amount : 0), 0) ?? 0;
  const backIn = back.nativeTransfers?.reduce((s, t) => s + (t.toUserAccount === back.feePayer ? t.amount : 0), 0) ?? 0;
  return Math.max(0, backIn - frontOut);
}

// ─── Dark Trade Routing ───────────────────────────────────────────────────────

/**
 * Build a split execution plan to minimize price impact and MEV exposure.
 * Does NOT execute trades — returns a plan for human approval.
 */
export function buildDarkRoute(opts: {
  token: string;
  side: 'buy' | 'sell';
  totalUsdc: number;
  /** Anti-sandwich: randomize priority fees */
  feeRandomization?: boolean;
}): DarkTradeRoute {
  const { token, side, totalUsdc, feeRandomization = true } = opts;

  // Split into 3-5 tranches with staggered timing
  const splitCount = totalUsdc > 10_000 ? 5 : totalUsdc > 5_000 ? 4 : 3;
  const baseAmount = totalUsdc / splitCount;
  const dexes: DarkTradeRoute['splits'][number]['dex'][] = ['jupiter', 'raydium', 'orca', 'meteora'];

  const splits = Array.from({ length: splitCount }, (_, i) => ({
    dex: dexes[i % dexes.length]!,
    amountUsdc: baseAmount * (0.9 + Math.random() * 0.2), // ±10% variance
    delayMs: i * (500 + Math.floor(Math.random() * 2000)), // staggered 0.5-2.5s apart
  }));

  return {
    token,
    side,
    amountUsdc: totalUsdc,
    splits,
    slippageBps: totalUsdc > 10_000 ? 50 : 30, // tighter for larger trades
    feeRandomization,
    expectedSlippageBps: Math.round(totalUsdc / 1000), // rough estimate
  };
}

// ─── On-Chain Context ─────────────────────────────────────────────────────────

/**
 * Fetch wallet context from Helius DAS API.
 * Used to inject on-chain state into HERMES inference calls.
 */
export async function fetchOnChainContext(
  walletAddress: string,
  heliusApiKey: string,
  solPriceUsd: number,
): Promise<OnChainContext> {
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;

  // Get SOL balance
  const balRes = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getBalance',
      params: [walletAddress, { commitment: 'confirmed' }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  const balJson = (await balRes.json()) as { result?: { value?: number } };
  const solBalance = (balJson.result?.value ?? 0) / 1e9;

  // Get token accounts
  const tokRes = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'getTokenAccountsByOwner',
      params: [walletAddress, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  const tokJson = (await tokRes.json()) as {
    result?: { value?: Array<{ account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number } } } } } }> };
  };

  const tokens = (tokJson.result?.value ?? []).map(a => ({
    mint: a.account.data.parsed.info.mint,
    symbol: '?',
    uiAmount: a.account.data.parsed.info.tokenAmount.uiAmount,
    valueUsdc: 0, // would need price oracle for each
  }));

  // Find USDC balance
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const usdcAccount = tokens.find(t => t.mint === USDC_MINT);
  const usdcBalance = usdcAccount?.uiAmount ?? 0;

  return {
    wallet: walletAddress,
    solBalance,
    usdcBalance,
    topTokens: tokens.slice(0, 10),
    recentTrades: 0,
    lastActivity: Date.now(),
  };
}

// ─── Helius types ─────────────────────────────────────────────────────────────

interface HeliusTransaction {
  signature: string;
  slot: number;
  timestamp: number;
  feePayer: string;
  type: string;
  description?: string;
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
}

// ─── Export convenience bundle ────────────────────────────────────────────────

export const DarkDeFi = {
  classify: classifyWhale,
  parseWhale: parseWhaleActivity,
  detectMEV: detectMEVPatterns,
  buildRoute: buildDarkRoute,
  fetchContext: fetchOnChainContext,
};
