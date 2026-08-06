/**
 * Solana-native x402 `exact` scheme.
 *
 * Flow:
 *   1. Server calls `buildChallenge(req)` → returns `SolanaPaymentRequirement`
 *      which goes into the PAYMENT-REQUIRED header (base64-JSON).
 *   2. Client builds an SPL transfer transaction:
 *        - instructions: [createATA (if needed), transferChecked(source→destATA, amount)]
 *        - feePayer: client wallet
 *        - recentBlockhash: exact value from challenge.extra.recentBlockhash
 *      then signs with their wallet keypair.
 *   3. Client base64-encodes the signed transaction, sends it as
 *      PAYMENT-SIGNATURE on retry.
 *   4. Server calls `verifyPayment(tx, requirement)` — returns `{ valid, reason }`.
 *      If valid, server calls `settlePayment(tx)` which broadcasts via RPC.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { isTokenProgram, getPTokenATA } from "./p-token.js";
import bs58 from "bs58";

import type { Env, SolanaPaymentRequirement } from "../types";
import { getLatestBlockhash, sendRawTransaction, simulateTransaction } from "./rpc";

/** Build a PAYMENT-REQUIRED challenge for a given resource + price. */
export async function buildChallenge(
  env: Env,
  params: {
    resource: string;
    description: string;
    payTo: string; // owner pubkey (ATA is derived)
    asset: string; // SPL mint
    amount: bigint; // base units
    decimals: number;
    memo?: string;
    timeoutSeconds?: number;
  },
): Promise<SolanaPaymentRequirement> {
  const { blockhash } = await getLatestBlockhash(env);

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
  /** The tx hash that will be produced once broadcast */
  signature?: string;
  /** The caller's pubkey (fee payer) — useful for receipts + holder-discount checks */
  payer?: string;
}

/**
 * Verify that a submitted transaction matches the payment requirement.
 *
 * Checks:
 *   - Transaction is signed and signature verifies
 *   - Exactly one SPL transferChecked instruction
 *   - transferChecked.mint === requirement.asset
 *   - transferChecked.destination === derived ATA for (payTo, asset)
 *   - transferChecked.amount === maxAmountRequired
 *   - recentBlockhash === requirement.extra.recentBlockhash
 *   - Simulating the tx does not error
 */
export async function verifyPayment(
  env: Env,
  tx: VersionedTransaction,
  req: SolanaPaymentRequirement,
): Promise<VerifyResult> {
  try {
    // Basic: must have at least one signature
    if (tx.signatures.length === 0) return { valid: false, reason: "no signatures" };

    const msg = tx.message;
    const feePayer = msg.staticAccountKeys[0];
    if (!feePayer) return { valid: false, reason: "no fee payer" };

    // Blockhash must match — this binds the tx to our challenge window
    if (msg.recentBlockhash !== req.extra.recentBlockhash) {
      return { valid: false, reason: "blockhash mismatch" };
    }

    // Find the SPL / p-token transferChecked instruction
    const mint = new PublicKey(req.asset);
    const payToOwner = new PublicKey(req.payTo);
    // Accept ATA derived by either TOKEN_PROGRAM_ID or P_TOKEN_PROGRAM_ID (same address)
    const expectedDestAta = getPTokenATA(mint, payToOwner);
    const expectedAmount = BigInt(req.maxAmountRequired);

    const transferIx = findTransferCheckedIx(tx, mint, expectedDestAta, expectedAmount);
    if (!transferIx.ok) return { valid: false, reason: transferIx.reason };

    // Simulate — cheap belt-and-braces, catches insufficient balance, missing ATA, etc.
    const base64 = Buffer.from(tx.serialize()).toString("base64");
    const sim = await simulateTransaction(env, base64);
    if (sim.err) {
      return {
        valid: false,
        reason: `simulation failed: ${JSON.stringify(sim.err)} — logs: ${sim.logs.join(" | ")}`,
      };
    }

    // Pre-compute the signature the RPC will return
    const sig = bs58.encode(tx.signatures[0]);

    return { valid: true, signature: sig, payer: feePayer.toBase58() };
  } catch (e) {
    return { valid: false, reason: `parse error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Broadcast a verified transaction. Returns the signature.
 * This is called from the facilitator /settle endpoint.
 */
export async function settlePayment(env: Env, tx: VersionedTransaction): Promise<string> {
  const base64 = Buffer.from(tx.serialize()).toString("base64");
  return sendRawTransaction(env, base64);
}

/* ——— helpers ——— */

interface TransferCheckedResult {
  ok: true;
  destinationAta: string;
  amount: bigint;
}
interface TransferCheckedFail {
  ok: false;
  reason: string;
}

/**
 * Walk the versioned message's compiled instructions looking for a single
 * transferChecked that matches (mint, destAta, amount).
 *
 * SPL transferChecked layout:
 *   accounts: [source, mint, destination, owner, ...multisig]
 *   data: [instructionType:u8=12, amount:u64LE, decimals:u8]
 */
function findTransferCheckedIx(
  tx: VersionedTransaction,
  expectedMint: PublicKey,
  expectedDestAta: PublicKey,
  expectedAmount: bigint,
): TransferCheckedResult | TransferCheckedFail {
  const msg = tx.message;
  const keys = msg.staticAccountKeys;

  let matched: TransferCheckedResult | null = null;
  let otherTokenIx = 0;

  for (const ix of msg.compiledInstructions) {
    const programId = keys[ix.programIdIndex];
    if (!programId) continue;
    // Accept standard SPL Token or p-token (Pinocchio) — same instruction layout
    if (!isTokenProgram(programId)) continue;

    const data = ix.data;
    // transferChecked has opcode 12 and 1 + 8 + 1 = 10 bytes of data
    if (data.length !== 10 || data[0] !== 12) {
      otherTokenIx++;
      continue;
    }

    const amount = readU64LE(data, 1);
    const accountIdx = ix.accountKeyIndexes;
    // source, mint, destination, owner
    if (accountIdx.length < 4) continue;
    const mintKey = keys[accountIdx[1]];
    const destKey = keys[accountIdx[2]];
    if (!mintKey || !destKey) continue;

    if (!mintKey.equals(expectedMint)) {
      return { ok: false, reason: "mint mismatch" };
    }
    if (!destKey.equals(expectedDestAta)) {
      return { ok: false, reason: "destination ATA mismatch" };
    }
    if (amount !== expectedAmount) {
      return { ok: false, reason: `amount mismatch: got ${amount} want ${expectedAmount}` };
    }

    if (matched) {
      return { ok: false, reason: "multiple transferChecked instructions — ambiguous" };
    }
    matched = { ok: true, destinationAta: destKey.toBase58(), amount };
  }

  if (!matched) {
    return { ok: false, reason: "no matching transferChecked instruction found" };
  }
  return matched;
}

function readU64LE(buf: Uint8Array, offset: number): bigint {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  // biome-ignore lint: bigint readers are the correct tool here
  return view.getBigUint64(0, true);
}

/** For the AP2 path — build + sign a transfer ourselves when the client posted an intent. */
export async function operatorSignedTransfer(
  _env: Env,
  _params: {
    from: string; // agent caller (if custodial); omit for user-signed
    to: string;
    mint: string;
    amount: bigint;
  },
): Promise<VersionedTransaction> {
  // TODO: When AP2 is used with a custodial payer (e.g. a Tempo-bridged charge),
  // the operator signs the Solana leg. Build a transaction via @solana/web3.js,
  // sign with OPERATOR_KEYPAIR, and return. Deferred to integration pass.
  throw new Error("operatorSignedTransfer: not implemented — wire operator keypair");
}

export { ASSOCIATED_TOKEN_PROGRAM_ID };
