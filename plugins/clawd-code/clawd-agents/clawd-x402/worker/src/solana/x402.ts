/**
 * Solana-native x402 `exact` scheme with opt-in p-token support.
 *
 * Flow:
 *   1. Server builds a PAYMENT-REQUIRED challenge.
 *   2. Client builds a transferChecked or p-token batch transaction.
 *   3. Client sends the signed transaction as PAYMENT-SIGNATURE.
 *   4. Server verifies the transaction, then settles it through RPC.
 */

import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";

import type { BatchOutput, Env, SolanaPaymentRequirement } from "../types";
import { getLatestBlockhash, sendRawTransaction, simulateTransaction } from "./rpc";
import {
  P_TOKEN_OPCODE_BATCH,
  SPL_TOKEN_PROGRAM_ID,
  cuSavingsSummary,
  deriveDestinationAtas,
  detectPToken,
} from "./p-token";

/** Build a PAYMENT-REQUIRED challenge for a given resource and price. */
export async function buildChallenge(
  env: Env,
  params: {
    resource: string;
    description: string;
    payTo: string;
    asset: string;
    amount: bigint;
    decimals: number;
    memo?: string;
    timeoutSeconds?: number;
  },
): Promise<SolanaPaymentRequirement> {
  const [{ blockhash }, pToken] = await Promise.all([
    getLatestBlockhash(env),
    detectPToken(env),
  ]);

  return {
    scheme: "exact",
    network: env.NETWORK === "solana-devnet" ? "solana-devnet" : "solana",
    resource: params.resource,
    description: params.description,
    mimeType: "application/json",
    payTo: params.payTo,
    asset: params.asset,
    maxAmountRequired: params.amount.toString(),
    maxTimeoutSeconds: params.timeoutSeconds ?? 60,
    extra: {
      decimals: params.decimals,
      recentBlockhash: blockhash,
      memo: params.memo,
      tokenProgram: pToken.active ? "p-token" : "spl",
      pTokenProgramId: pToken.active ? pToken.programId : undefined,
    },
  };
}

/** Build a p-token batch PAYMENT-REQUIRED challenge for multi-recipient payment. */
export async function buildBatchChallenge(
  env: Env,
  params: {
    resource: string;
    description: string;
    asset: string;
    decimals: number;
    outputs: BatchOutput[];
    memo?: string;
    timeoutSeconds?: number;
  },
): Promise<SolanaPaymentRequirement> {
  const [{ blockhash }, pToken] = await Promise.all([
    getLatestBlockhash(env),
    detectPToken(env),
  ]);

  const totalAmount = params.outputs.reduce((sum, output) => sum + BigInt(output.amount), 0n);
  const savings = cuSavingsSummary(params.outputs.length);

  return {
    scheme: "exact",
    network: env.NETWORK === "solana-devnet" ? "solana-devnet" : "solana",
    resource: params.resource,
    description: `${params.description} [batch x${params.outputs.length}, saves ${savings.savedPct}% CU]`,
    mimeType: "application/json",
    payTo: params.outputs[0].payTo,
    asset: params.asset,
    maxAmountRequired: totalAmount.toString(),
    maxTimeoutSeconds: params.timeoutSeconds ?? 60,
    extra: {
      decimals: params.decimals,
      recentBlockhash: blockhash,
      memo: params.memo,
      tokenProgram: pToken.active ? "p-token" : "spl",
      pTokenProgramId: pToken.active ? pToken.programId : undefined,
      batchOutputs: params.outputs,
    },
  };
}

/** Encode a `SolanaPaymentRequirement` for the PAYMENT-REQUIRED header. */
export function encodeChallenge(req: SolanaPaymentRequirement): string {
  return btoa(JSON.stringify(req));
}

export function decodeChallenge(header: string): SolanaPaymentRequirement {
  return JSON.parse(atob(header)) as SolanaPaymentRequirement;
}

/** Decode a client-submitted signed transaction from PAYMENT-SIGNATURE. */
export function decodeSignedTransaction(header: string): VersionedTransaction {
  const raw = Uint8Array.from(atob(header), (c) => c.charCodeAt(0));
  return VersionedTransaction.deserialize(raw);
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  signature?: string;
  payer?: string;
  usedPToken?: boolean;
}

/** Verify that a submitted transaction matches the payment requirement. */
export async function verifyPayment(
  env: Env,
  tx: VersionedTransaction,
  req: SolanaPaymentRequirement,
): Promise<VerifyResult> {
  try {
    if (tx.signatures.length === 0) return { valid: false, reason: "no signatures" };

    const msg = tx.message;
    const feePayer = msg.staticAccountKeys[0];
    if (!feePayer) return { valid: false, reason: "no fee payer" };

    if (msg.recentBlockhash !== req.extra.recentBlockhash) {
      return { valid: false, reason: "blockhash mismatch" };
    }

    const mint = new PublicKey(req.asset);
    const expectedAmount = BigInt(req.maxAmountRequired);
    const isBatch = req.extra.batchOutputs && req.extra.batchOutputs.length > 0;

    let usedPToken = false;
    if (isBatch) {
      if (req.extra.tokenProgram !== "p-token") {
        return { valid: false, reason: "batchOutputs require p-token" };
      }
      const tokenProgramId = tokenProgramIdFor(env, req);
      const batchResult = findBatchIx(tx, tokenProgramId, mint, req.extra.batchOutputs!, expectedAmount);
      if (!batchResult.ok) return { valid: false, reason: batchResult.reason };
      usedPToken = batchResult.usedPToken;
    } else {
      const tokenProgramId = tokenProgramIdFor(env, req);
      const payToOwner = new PublicKey(req.payTo);
      const expectedDestAta = getAssociatedTokenAddressSync(
        mint,
        payToOwner,
        true,
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const transferIx = findTransferCheckedIx(
        tx,
        tokenProgramId,
        mint,
        expectedDestAta,
        expectedAmount,
      );
      if (!transferIx.ok) return { valid: false, reason: transferIx.reason };
      usedPToken = transferIx.usedPToken;
    }

    const sim = await simulateTransaction(env, bytesToBase64(tx.serialize()));
    if (sim.err) {
      return {
        valid: false,
        reason: `simulation failed: ${JSON.stringify(sim.err)} - logs: ${sim.logs.join(" | ")}`,
      };
    }

    const sig = bs58.encode(tx.signatures[0]);
    return { valid: true, signature: sig, payer: feePayer.toBase58(), usedPToken };
  } catch (e) {
    return { valid: false, reason: `parse error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Broadcast a verified transaction. Returns the signature. */
export async function settlePayment(env: Env, tx: VersionedTransaction): Promise<string> {
  return sendRawTransaction(env, bytesToBase64(tx.serialize()));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

interface TransferCheckedResult {
  ok: true;
  destinationAta: string;
  amount: bigint;
  usedPToken: boolean;
}

interface TransferCheckedFail {
  ok: false;
  reason: string;
}

function findTransferCheckedIx(
  tx: VersionedTransaction,
  expectedTokenProgram: PublicKey,
  expectedMint: PublicKey,
  expectedDestAta: PublicKey,
  expectedAmount: bigint,
): TransferCheckedResult | TransferCheckedFail {
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  let matched: TransferCheckedResult | null = null;

  for (const ix of msg.compiledInstructions) {
    const programId = keys[ix.programIdIndex];
    if (!programId?.equals(expectedTokenProgram)) continue;

    const data = ix.data;
    if (data.length !== 10 || data[0] !== 12) continue;

    const amount = readU64LE(data, 1);
    const accountIdx = ix.accountKeyIndexes;
    if (accountIdx.length < 4) continue;

    const mintKey = keys[accountIdx[1]];
    const destKey = keys[accountIdx[2]];
    if (!mintKey || !destKey) continue;

    if (!mintKey.equals(expectedMint)) return { ok: false, reason: "mint mismatch" };
    if (!destKey.equals(expectedDestAta)) {
      return { ok: false, reason: "destination ATA mismatch" };
    }
    if (amount !== expectedAmount) {
      return { ok: false, reason: `amount mismatch: got ${amount} want ${expectedAmount}` };
    }
    if (matched) return { ok: false, reason: "multiple transferChecked instructions - ambiguous" };

    matched = {
      ok: true,
      destinationAta: destKey.toBase58(),
      amount,
      usedPToken: !expectedTokenProgram.equals(SPL_TOKEN_PROGRAM_ID),
    };
  }

  return matched ?? { ok: false, reason: "no matching transferChecked instruction found" };
}

interface BatchResult {
  ok: true;
  usedPToken: boolean;
}

interface BatchFail {
  ok: false;
  reason: string;
}

function findBatchIx(
  tx: VersionedTransaction,
  tokenProgramId: PublicKey,
  expectedMint: PublicKey,
  outputs: BatchOutput[],
  expectedTotal: bigint,
): BatchResult | BatchFail {
  if (outputs.length === 0 || outputs.length > 64) {
    return { ok: false, reason: "p-token batch output count must be 1-64" };
  }
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  const expectedAtas = deriveDestinationAtas(expectedMint, outputs, tokenProgramId);

  for (const ix of msg.compiledInstructions) {
    const programId = keys[ix.programIdIndex];
    if (!programId?.equals(tokenProgramId)) continue;

    const data = ix.data;
    if (data.length < 2 || data[0] !== P_TOKEN_OPCODE_BATCH) continue;

    const n = data[1];
    if (n === undefined) return { ok: false, reason: "batch count missing" };
    if (n !== outputs.length) {
      return { ok: false, reason: `batch count mismatch: got ${n} want ${outputs.length}` };
    }
    if (data.length < 2 + n * 9) return { ok: false, reason: "batch data too short" };

    let total = 0n;
    for (let i = 0; i < n; i++) {
      const amount = readU64LE(data, 2 + i * 9);
      total += amount;
      if (amount !== BigInt(outputs[i].amount)) {
        return { ok: false, reason: `batch amount[${i}] mismatch` };
      }
    }
    if (total !== expectedTotal) {
      return { ok: false, reason: `batch total mismatch: got ${total} want ${expectedTotal}` };
    }

    const accountIdx = ix.accountKeyIndexes;
    if (accountIdx.length < 3 + n) return { ok: false, reason: "batch accounts too few" };

    const mintKey = keys[accountIdx[1]];
    if (!mintKey?.equals(expectedMint)) return { ok: false, reason: "batch mint mismatch" };

    for (let i = 0; i < n; i++) {
      const destKey = keys[accountIdx[3 + i]];
      if (!destKey?.equals(expectedAtas[i])) {
        return { ok: false, reason: `batch dest[${i}] ATA mismatch` };
      }
    }

    return { ok: true, usedPToken: true };
  }

  return { ok: false, reason: "no matching p-token batch instruction found" };
}

function tokenProgramIdFor(env: Env, req: SolanaPaymentRequirement): PublicKey {
  if (req.extra.tokenProgram !== "p-token") return SPL_TOKEN_PROGRAM_ID;
  const programId = req.extra.pTokenProgramId ?? env.P_TOKEN_PROGRAM_ID;
  if (!programId) {
    throw new Error("p-token requested but P_TOKEN_PROGRAM_ID is not configured");
  }
  return new PublicKey(programId);
}

function readU64LE(buf: Uint8Array, offset: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

/** For the AP2 path: build and sign a transfer ourselves for custodial settlement. */
export async function operatorSignedTransfer(
  _env: Env,
  _params: {
    from: string;
    to: string;
    mint: string;
    amount: bigint;
  },
): Promise<VersionedTransaction> {
  throw new Error("operatorSignedTransfer: not implemented - wire operator keypair");
}

export { ASSOCIATED_TOKEN_PROGRAM_ID };
