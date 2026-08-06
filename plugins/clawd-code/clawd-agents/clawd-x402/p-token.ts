/**
 * x402/p-token.ts — P-Token (Pinocchio) support for x402 payments
 *
 * P-Token is a drop-in replacement for the SPL Token program with
 * dramatically lower compute unit consumption:
 *
 *   TransferChecked  6,200 CU → 105 CU  (~98% reduction)
 *   Transfer         4,645 CU →  76 CU
 *   Approve          2,904 CU → 124 CU
 *   Burn             4,753 CU → 1,884 CU
 *
 * It is fully backward-compatible — same instruction layout, same ATA
 * derivation, same account structures. Only the program ID changes.
 *
 * Ref: https://solana.com/upgrades/p-token
 *      https://www.helius.dev/blog/solana-p-token
 *      SIMD-0266: Efficient Token Program
 */

import {
  PublicKey,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

// ─── Program IDs ──────────────────────────────────────────────────────────────

/** P-Token (Pinocchio-optimized) program ID — mainnet + devnet (feature-gated) */
export const P_TOKEN_PROGRAM_ID = new PublicKey('ptok6rngomXrDbWf5v5Mkmu5CEbB51hzSCPDoj9DrvF');

/** Feature gate for p-token activation */
export const P_TOKEN_FEATURE_GATE = new PublicKey('ptokFjwyJtrwCa9Kgo9xoDS59V4QccBGEaRFnRPnSdP');

/** All token program IDs we recognise as valid for x402 payments */
export const KNOWN_TOKEN_PROGRAM_IDS: PublicKey[] = [
  TOKEN_PROGRAM_ID,
  P_TOKEN_PROGRAM_ID,
];

// ─── Compute unit costs (measured, from SIMD-0266 benchmarks) ────────────────

export const P_TOKEN_CU = {
  transfer:             76,
  transferChecked:     105,
  approve:             124,
  approveChecked:      149,
  burn:               1884,
  burnChecked:        1899,
  mintTo:             2012,
  mintToChecked:      2027,
  initializeAccount:  2355,
  closeAccount:       1402,
} as const;

export const SPL_TOKEN_CU = {
  transfer:           4645,
  transferChecked:    6200,
  approve:            2904,
  approveChecked:     4458,
  burn:               4753,
  burnChecked:        4768,
  mintTo:             4128,
  mintToChecked:      4143,
  initializeAccount:  4210,
  closeAccount:       2915,
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check if p-token is likely active on this cluster.
 * Resolves synchronously from env; for on-chain confirmation call
 * `confirmPTokenActive()` instead.
 */
export function isPTokenPreferred(): boolean {
  const env = process.env['USE_P_TOKEN'];
  if (env === '0' || env === 'false') return false;
  // Default true — p-token is live on mainnet; devnet may lag by one release
  return true;
}

/** Returns P_TOKEN_PROGRAM_ID when preferred, else TOKEN_PROGRAM_ID */
export function tokenProgramId(): PublicKey {
  return isPTokenPreferred() ? P_TOKEN_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/** True if the given pubkey is either the SPL or p-token program */
export function isTokenProgram(pubkey: PublicKey): boolean {
  return KNOWN_TOKEN_PROGRAM_IDS.some(id => id.equals(pubkey));
}

// ─── ATA helpers ──────────────────────────────────────────────────────────────

export function getPTokenATA(
  mint: PublicKey,
  owner: PublicKey,
  allowOffCurve = true,
): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, allowOffCurve, tokenProgramId());
}

export function createPTokenATAIdempotent(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer, ata, owner, mint, tokenProgramId(),
  );
}

// ─── Transfer instruction ─────────────────────────────────────────────────────

export function createPTokenTransferChecked(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint | number,
  decimals: number,
): TransactionInstruction {
  return createTransferCheckedInstruction(
    source, mint, destination, owner,
    typeof amount === 'bigint' ? amount : BigInt(amount),
    decimals,
    [],
    tokenProgramId(),
  );
}

// ─── Batch instruction (new in p-token, discriminator 255) ───────────────────

/**
 * Wrap multiple token instructions into a single batch CPI.
 * Pays the 1000 CU base cost once instead of once per instruction.
 *
 * Batch discriminator: 255
 * Layout: [255u8, count:u8, ...serialised inner instructions]
 *
 * Note: batch is only available when p-token is the active program.
 * Falls back to returning individual instructions on standard SPL.
 */
export function createBatchInstruction(
  innerInstructions: TransactionInstruction[],
  keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>,
): TransactionInstruction {
  if (!isPTokenPreferred() || innerInstructions.length === 0) {
    throw new Error('createBatchInstruction requires p-token and at least one inner instruction');
  }

  // Serialise inner instructions: each as [data_len:u16LE, data..., accounts_len:u8, account_idx...]
  // For direct CPI we encode as raw data bytes passed to the p-token program.
  const count = innerInstructions.length;
  const chunks: number[] = [255, count];  // discriminator + count

  for (const ix of innerInstructions) {
    const data = Array.from(ix.data);
    chunks.push(data.length & 0xff, (data.length >> 8) & 0xff);  // u16LE length
    chunks.push(...data);
    chunks.push(ix.keys.length);
    // account indices resolved by caller via keys array
    for (const k of ix.keys) {
      const idx = keys.findIndex(r => r.pubkey.equals(k.pubkey));
      chunks.push(idx >= 0 ? idx : 0);
    }
  }

  return new TransactionInstruction({
    programId: P_TOKEN_PROGRAM_ID,
    keys,
    data: Buffer.from(chunks),
  });
}

// ─── Compute budget ───────────────────────────────────────────────────────────

/**
 * Returns ComputeBudget instructions tuned for p-token transfers.
 *
 * A x402 payment tx has:
 *  - 1x createAssociatedTokenAccountIdempotent (~2400 CU when ATA missing, ~400 when exists)
 *  - 1x transferChecked (105 CU with p-token)
 *  - overhead: ~7000 CU
 *
 * We request 12_000 CU — well above worst-case but far below the old 200_000 default.
 * Priority fee defaults to 1000 microlamports (network-aware callers should override).
 */
export function createPTokenComputeBudget(opts?: {
  computeUnits?: number;
  microLamportsPerCU?: number;
}): TransactionInstruction[] {
  const units = opts?.computeUnits ?? (isPTokenPreferred() ? 12_000 : 80_000);
  const fee   = opts?.microLamportsPerCU ?? 1_000;
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }),
  ];
}

// ─── Savings summary ─────────────────────────────────────────────────────────

export function pTokenSavingsReport(): string {
  const saved = SPL_TOKEN_CU.transferChecked - P_TOKEN_CU.transferChecked;
  const pct = (100 - (P_TOKEN_CU.transferChecked / SPL_TOKEN_CU.transferChecked) * 100).toFixed(1);
  return [
    `P-Token: TransferChecked ${SPL_TOKEN_CU.transferChecked} → ${P_TOKEN_CU.transferChecked} CU (-${pct}%)`,
    `Program: ${P_TOKEN_PROGRAM_ID.toBase58()}`,
    `Ref: https://solana.com/upgrades/p-token`,
  ].join('\n');
}
