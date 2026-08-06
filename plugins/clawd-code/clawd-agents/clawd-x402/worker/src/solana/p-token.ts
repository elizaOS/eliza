/**
 * p-token (SIMD-0266) integration for the Clawd x402 facilitator.
 *
 * p-token is treated here as a CU-optimised token-program-compatible rail for
 * SPL-style payments. It is enabled by default and can be disabled with
 * USE_P_TOKEN=0 or USE_P_TOKEN=false.
 *
 * Key facts:
 *   - Same program address post-activation (hard fork upgrade).
 *   - All existing SPL Token instructions are preserved with same opcodes.
 *   - New opcodes: 25 = batch, 26 = unwrap_lamports.
 *   - CU savings per transfer: ~15 CUs (~10%).  Burn saves ~67 CUs.
 *   - P_TOKEN_PROGRAM_ID can override the default p-token program address.
 *
 * Detection strategy:
 *   - if USE_P_TOKEN is unset, advertise and verify p-token.
 *   - if USE_P_TOKEN=0/false, stay on the canonical SPL Token program.
 *
 * Instruction layout reference (SIMD-0266):
 *   batch (opcode 25):
 *     [0]   u8   = 25
 *     [1]   u8   = n  (number of (destination_ata, amount_u64_le, decimals_u8) tuples)
 *     [2..] repeated tuples of 9 bytes each:
 *             amount : u64 LE  (8 bytes)
 *             decimals: u8     (1 byte)
 *     accounts: source_ata, mint, owner, [dest_ata_0, dest_ata_1, ...]
 *
 *   unwrap_lamports (opcode 26):
 *     [0]   u8   = 26
 *     accounts: mint, recipient, authority (mint_authority OR mint_keypair)
 */

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Env, PTokenStatus, BatchOutput } from "../types";

/** The well-known SPL Token program address. */
export const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

/**
 * P-Token (Pinocchio) program — mainnet + devnet.
 * Feature gate: ptokFjwyJtrwCa9Kgo9xoDS59V4QccBGEaRFnRPnSdP
 * Ref: https://solana.com/upgrades/p-token
 */
export const P_TOKEN_PROGRAM_ID = new PublicKey(
  "ptok6rngomXrDbWf5v5Mkmu5CEbB51hzSCPDoj9DrvF",
);

export const P_TOKEN_FEATURE_GATE = new PublicKey(
  "ptokFjwyJtrwCa9Kgo9xoDS59V4QccBGEaRFnRPnSdP",
);

/** Measured CU costs for p-token (Pinocchio). TransferChecked is 98% cheaper than SPL. */
export const P_TOKEN_CU = {
  transfer:            76,
  transferChecked:    105,
  approve:            124,
  approveChecked:     149,
  burn:              1884,
  burnChecked:       1899,
  mintTo:            2012,
  mintToChecked:     2027,
  initializeAccount: 2355,
  closeAccount:      1402,
  // legacy keys for compatibility
  TransferChecked:    105,
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
  // legacy keys for compatibility
  TransferChecked:    6200,
} as const;

// p-token instruction opcodes (new instructions only; legacy opcodes unchanged)
const P_TOKEN_OPCODE_BATCH = 25;
const P_TOKEN_OPCODE_UNWRAP_LAMPORTS = 26;

/** 5-minute TTL for the p-token detection cache (ms). */
const DETECT_TTL_MS = 5 * 60 * 1000;

let _cachedStatus: PTokenStatus | null = null;

/**
 * Detect whether p-token is the active token program on the connected cluster.
 * Result is cached for 5 minutes to avoid per-request RPC overhead.
 */
export async function detectPToken(env: Env): Promise<PTokenStatus> {
  if (_cachedStatus && Date.now() - _cachedStatus.checkedAt < DETECT_TTL_MS) {
    return _cachedStatus;
  }

  // Explicit opt-out via env var (USE_P_TOKEN=0 or USE_P_TOKEN=false)
  const optOut = (env as unknown as Record<string, string>).USE_P_TOKEN;
  const disabled = optOut === "0" || optOut === "false";

  // Use explicit override ID if set, otherwise default to the real p-token address
  const programId = env.P_TOKEN_PROGRAM_ID ?? P_TOKEN_PROGRAM_ID.toBase58();

  _cachedStatus = {
    active: !disabled,
    programId: disabled ? SPL_TOKEN_PROGRAM_ID.toBase58() : programId,
    cuSavingsPerTransfer: disabled ? 0 : SPL_TOKEN_CU.TransferChecked - P_TOKEN_CU.TransferChecked,
    checkedAt: Date.now(),
  };
  return _cachedStatus;
}

/**
 * Return the active token program PublicKey — p-token if active, SPL otherwise.
 */
export async function getTokenProgramId(env: Env): Promise<PublicKey> {
  const status = await detectPToken(env);
  return new PublicKey(status.programId);
}

/**
 * Build the data buffer for a p-token `batch` instruction (opcode 25).
 *
 * The batch instruction moves tokens from one source ATA to N destination ATAs
 * in a single instruction — far cheaper than N × transferChecked.
 *
 * accounts order expected by the caller:
 *   [source_ata, mint, owner, dest_ata_0, dest_ata_1, ..., dest_ata_n-1]
 */
export function buildBatchData(outputs: Array<{ amount: bigint; decimals: number }>): Uint8Array {
  if (outputs.length === 0 || outputs.length > 64) {
    throw new RangeError("p-token batch: 1–64 outputs required");
  }
  // 1 (opcode) + 1 (n) + n × 9 (amount u64 + decimals u8)
  const buf = new Uint8Array(2 + outputs.length * 9);
  const view = new DataView(buf.buffer);
  buf[0] = P_TOKEN_OPCODE_BATCH;
  buf[1] = outputs.length;
  let off = 2;
  for (const o of outputs) {
    view.setBigUint64(off, o.amount, true);
    off += 8;
    buf[off++] = o.decimals;
  }
  return buf;
}

/**
 * Build the data buffer for the p-token `unwrap_lamports` instruction (opcode 26).
 * Recovers stranded SOL from a token mint account.
 *
 * accounts order: [mint, recipient, authority]
 *   authority = mint_authority if set, otherwise mint_keypair.
 */
export function buildUnwrapLamportsData(): Uint8Array {
  return new Uint8Array([P_TOKEN_OPCODE_UNWRAP_LAMPORTS]);
}

/**
 * Derive ATAs for a batch payment and return the flattened account index list
 * suitable for a CompiledInstruction.
 *
 * Returns { atas, accountKeyIndexes } where accountKeyIndexes maps into a
 * message's staticAccountKeys array starting at `baseIndex`.
 */
export function deriveDestinationAtas(
  mint: PublicKey,
  outputs: BatchOutput[],
  tokenProgramId: PublicKey = SPL_TOKEN_PROGRAM_ID,
): PublicKey[] {
  return outputs.map((o) =>
    getAssociatedTokenAddressSync(mint, new PublicKey(o.payTo), true, tokenProgramId),
  );
}

/**
 * Estimate the compute units for a p-token batch transfer.
 *
 * Based on SIMD-0266 benchmarks: base overhead ~50 CU, plus ~25 CU per output
 * (vs ~131 CU × n for individual transferChecked calls).
 */
export function estimateBatchCu(outputCount: number): number {
  return 50 + outputCount * 25;
}

/**
 * CU savings summary for informational headers / receipts.
 */
export function cuSavingsSummary(batchSize: number): {
  splCu: number;
  pTokenCu: number;
  savedCu: number;
  savedPct: number;
} {
  const splCu = batchSize * SPL_TOKEN_CU.TransferChecked;
  const pTokenCu = estimateBatchCu(batchSize);
  const savedCu = splCu - pTokenCu;
  return {
    splCu,
    pTokenCu,
    savedCu,
    savedPct: Math.round((savedCu / splCu) * 100),
  };
}

export { P_TOKEN_OPCODE_BATCH, P_TOKEN_OPCODE_UNWRAP_LAMPORTS };
