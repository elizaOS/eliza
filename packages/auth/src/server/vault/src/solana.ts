import { Buffer } from "node:buffer";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  type Signer,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import { getKnownToken } from "../../shared/src/index.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./solana-instructions";

/** Return true only for a canonical base58 encoding of one 32-byte Solana public key. */
export function isValidSolanaPublicKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/** Uint8Array → lowercase hex string. */
function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Uint8Array → base64url string.
 * Uses btoa() (available in Node 16+) to avoid Buffer.from() polyfill type conflicts
 * introduced by @solana/web3.js bundling its own browser Buffer shim.
 */
function uint8ArrayToBase64url(arr: Uint8Array): string {
  const base64 = btoa(Array.from(arr, (b) => String.fromCharCode(b)).join(""));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function uint64ToLittleEndian(value: bigint): Uint8Array {
  if (value < 0n || value > 18_446_744_073_709_551_615n) {
    throw new Error("SPL token transfer amount must fit in uint64 base units");
  }
  const out = new Uint8Array(8);
  let remaining = value;
  for (let i = 0; i < out.length; i++) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

function transactionToBase64(tx: Transaction): string {
  return btoa(
    Array.from(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      (b) => String.fromCharCode(b),
    ).join(""),
  );
}

// ─── Key Generation ────────────────────────────────────────────────────────

/**
 * Generate a Solana Ed25519 keypair.
 * Returns the public key in base58 format and the secret key as a hex string
 * (64 bytes: 32-byte seed + 32-byte public key, as stored by @solana/web3.js).
 */
export function generateSolanaKeypair(): {
  publicKey: string;
  secretKey: string;
} {
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: uint8ArrayToHex(keypair.secretKey),
  };
}

/**
 * Check if a string is valid hexadecimal (only 0-9, a-f, A-F).
 */
function isHexString(str: string): boolean {
  return /^[0-9a-fA-F]+$/.test(str);
}

/**
 * Decode a base58-encoded string to Uint8Array.
 * Uses the Bitcoin alphabet (same as Solana).
 */
function decodeBase58(encoded: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const BASE = BigInt(58);

  // Handle empty input
  if (encoded.length === 0) {
    return new Uint8Array(0);
  }

  // Count leading '1's (they represent leading zero bytes)
  let leadingZeros = 0;
  for (let i = 0; i < encoded.length && encoded[i] === "1"; i++) {
    leadingZeros++;
  }

  // Convert base58 to a big integer
  let num = BigInt(0);
  for (const char of encoded) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base58 character: ${char}`);
    }
    num = num * BASE + BigInt(index);
  }

  // Convert the big integer to bytes
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num % 256n));
    num = num / 256n;
  }

  // Add leading zero bytes back
  const result = new Uint8Array(leadingZeros + bytes.length);
  result.set(bytes, leadingZeros);

  return result;
}

/**
 * Restore a Solana Keypair from a secret key string.
 * Accepts either:
 * - 128-character hex string (64 bytes: 32-byte seed + 32-byte pubkey)
 * - 64-character hex string (32-byte seed only)
 * - Base58-encoded 64-byte secret key (as stored by Phantom, Solana CLI)
 */
export function restoreSolanaKeypair(secretKey: string): Keypair {
  let keyBytes: Uint8Array;

  // Detect format: hex strings are longer and only contain hex chars
  // A 64-byte key in hex = 128 chars, in base58 ≈ 87-88 chars
  // A 32-byte seed in hex = 64 chars, in base58 ≈ 43-44 chars
  if (
    isHexString(secretKey) &&
    (secretKey.length === 128 || secretKey.length === 64)
  ) {
    // Hex-encoded key
    keyBytes = Uint8Array.from(Buffer.from(secretKey, "hex"));
  } else {
    // Assume base58-encoded
    keyBytes = decodeBase58(secretKey);
  }

  // If we only have a 32-byte seed, we need to derive the keypair
  if (keyBytes.length === 32) {
    return Keypair.fromSeed(keyBytes);
  }

  // Full 64-byte secret key
  if (keyBytes.length === 64) {
    return Keypair.fromSecretKey(keyBytes);
  }

  throw new Error(
    `Invalid Solana secret key: expected 32-byte seed or 64-byte key, got ${keyBytes.length} bytes`,
  );
}

// ─── Compute budget / priority fees ──────────────────────────────────────────

/**
 * Safety rails for Solana priority-fee / compute-unit estimation.
 *
 * The estimator derives a compute-unit *limit* from transaction simulation and a
 * per-CU *price* from recent on-chain prioritization fees (the correct, adaptive
 * form — NOT a hardcoded constant). Every output is clamped by these bounds so a
 * misbehaving RPC, a fee spike, or a bad override can never make the vault sign a
 * transaction that reserves more than `MAX_UNIT_LIMIT` units, pays more than
 * `MAX_MICRO_LAMPORTS_PER_CU` per unit, or burns more than `MAX_PRIORITY_FEE_LAMPORTS`
 * in total priority fees.
 */
export const COMPUTE_BUDGET_BOUNDS = {
  /** Floor for the unit limit. A bare SOL transfer consumes ~150 CU. */
  MIN_UNIT_LIMIT: 300,
  /** Protocol hard ceiling: 1.4M CU per transaction. */
  MAX_UNIT_LIMIT: 1_400_000,
  /** Headroom multiplier applied to simulated units. */
  UNIT_LIMIT_MARGIN: 1.2,
  /** Fallback unit limit when simulation is disabled or fails. */
  DEFAULT_UNIT_LIMIT: 10_000,
  /** Fallback per-CU price when recent-fee data is unavailable. */
  DEFAULT_MICRO_LAMPORTS_PER_CU: 1_000,
  /** Hard ceiling on the per-CU price (µlamports/CU). */
  MAX_MICRO_LAMPORTS_PER_CU: 1_000_000,
  /** Percentile (0..1) of recent fees to target. */
  DEFAULT_FEE_PERCENTILE: 0.75,
  /** Absolute ceiling on total priority fee (lamports) = 0.0005 SOL. */
  MAX_PRIORITY_FEE_LAMPORTS: 500_000,
} as const;

export interface ComputeBudgetOptions {
  /** Skip simulation and use this exact unit limit (still clamped to bounds). */
  unitLimit?: number;
  /** Skip the recent-fee query and use this exact per-CU price (still clamped). */
  microLamportsPerCu?: number;
  /** Percentile (0..1) of recent prioritization fees to target. Default 0.75. */
  feePercentile?: number;
  /** Lower the operative per-CU price ceiling below the hard maximum. */
  maxMicroLamportsPerCu?: number;
  /** Lower the operative total priority-fee ceiling below the hard maximum. */
  maxPriorityFeeLamports?: number;
  /** When false, skip simulation and use the default unit limit. Default true. */
  simulate?: boolean;
}

export interface ComputeBudgetEstimate {
  unitLimit: number;
  microLamportsPerCu: number;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Median/percentile of recent prioritization fees for the writable accounts a
 * transaction touches. Never throws — returns the default price on any RPC error
 * or empty result so estimation degrades gracefully.
 */
async function priceFromRecentFees(
  connection: Connection,
  writableAccounts: PublicKey[],
  percentile: number,
): Promise<number> {
  try {
    const fees = await connection.getRecentPrioritizationFees(
      writableAccounts.length > 0
        ? { lockedWritableAccounts: writableAccounts }
        : undefined,
    );
    if (!Array.isArray(fees) || fees.length === 0) {
      return COMPUTE_BUDGET_BOUNDS.DEFAULT_MICRO_LAMPORTS_PER_CU;
    }
    const values = fees
      .map((f) => f.prioritizationFee)
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
      .sort((a, b) => a - b);
    if (values.length === 0)
      return COMPUTE_BUDGET_BOUNDS.DEFAULT_MICRO_LAMPORTS_PER_CU;
    // Nearest-rank percentile via ceil(p*n)-1: for p=0.75 over [a,b,c,d] this
    // selects index 2 (the 75th percentile), whereas floor(p*n) would snap to the
    // last/max element for small n and systematically overpay. A non-finite
    // percentile (e.g. an explicit NaN) falls back to the default rather than
    // indexing values[NaN] === undefined, which would zero the fee.
    const p = Number.isFinite(percentile)
      ? Math.min(1, Math.max(0, percentile))
      : COMPUTE_BUDGET_BOUNDS.DEFAULT_FEE_PERCENTILE;
    const idx = Math.min(
      values.length - 1,
      Math.max(0, Math.ceil(p * values.length) - 1),
    );
    return values[idx];
  } catch {
    return COMPUTE_BUDGET_BOUNDS.DEFAULT_MICRO_LAMPORTS_PER_CU;
  }
}

/**
 * Compute-unit estimate from simulating the transaction with the maximum unit
 * limit, then applying a headroom margin. Never throws — returns the default
 * unit limit on any RPC/simulation error so estimation degrades gracefully.
 */
async function unitsFromSimulation(
  connection: Connection,
  params: {
    feePayer: PublicKey;
    instructions: TransactionInstruction[];
    recentBlockhash: string;
    signers: Signer[];
  },
): Promise<number> {
  try {
    const simTx = new Transaction({
      recentBlockhash: params.recentBlockhash,
      feePayer: params.feePayer,
    }).add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: COMPUTE_BUDGET_BOUNDS.MAX_UNIT_LIMIT,
      }),
      ...params.instructions,
    );
    const sim = await connection.simulateTransaction(simTx, params.signers);
    const units = sim?.value?.unitsConsumed;
    if (sim?.value?.err || typeof units !== "number" || units <= 0) {
      return COMPUTE_BUDGET_BOUNDS.DEFAULT_UNIT_LIMIT;
    }
    return Math.ceil(units * COMPUTE_BUDGET_BOUNDS.UNIT_LIMIT_MARGIN);
  } catch {
    return COMPUTE_BUDGET_BOUNDS.DEFAULT_UNIT_LIMIT;
  }
}

/**
 * Estimate a Solana compute budget (unit limit + per-CU price) for a set of
 * instructions, bounded by {@link COMPUTE_BUDGET_BOUNDS}. The total projected
 * priority fee (`unitLimit × microLamportsPerCu`) is capped by lowering the price
 * while preserving the (landing-critical) unit limit. Never throws.
 */
export async function estimateSolanaComputeBudget(
  connection: Connection,
  params: {
    feePayer: PublicKey;
    instructions: TransactionInstruction[];
    recentBlockhash: string;
    signers: Signer[];
    writableAccounts?: PublicKey[];
  },
  options: ComputeBudgetOptions = {},
): Promise<ComputeBudgetEstimate> {
  const B = COMPUTE_BUDGET_BOUNDS;
  const priceCeiling = clampInt(
    options.maxMicroLamportsPerCu ?? B.MAX_MICRO_LAMPORTS_PER_CU,
    0,
    B.MAX_MICRO_LAMPORTS_PER_CU,
  );
  const totalCeiling = clampInt(
    options.maxPriorityFeeLamports ?? B.MAX_PRIORITY_FEE_LAMPORTS,
    0,
    B.MAX_PRIORITY_FEE_LAMPORTS,
  );

  let microLamportsPerCu =
    typeof options.microLamportsPerCu === "number"
      ? options.microLamportsPerCu
      : await priceFromRecentFees(
          connection,
          params.writableAccounts ?? [],
          options.feePercentile ?? B.DEFAULT_FEE_PERCENTILE,
        );
  microLamportsPerCu = clampInt(microLamportsPerCu, 0, priceCeiling);

  let unitLimit: number;
  if (typeof options.unitLimit === "number") {
    unitLimit = options.unitLimit;
  } else if (options.simulate === false) {
    unitLimit = B.DEFAULT_UNIT_LIMIT;
  } else {
    unitLimit = await unitsFromSimulation(connection, params);
  }
  unitLimit = clampInt(unitLimit, B.MIN_UNIT_LIMIT, B.MAX_UNIT_LIMIT);

  // Cap the total priority fee by lowering the price (keep the accurate limit).
  const projectedLamports = Math.ceil(
    (unitLimit * microLamportsPerCu) / 1_000_000,
  );
  if (projectedLamports > totalCeiling) {
    microLamportsPerCu = Math.floor((totalCeiling * 1_000_000) / unitLimit);
  }

  return { unitLimit, microLamportsPerCu };
}

/** Build the two ComputeBudget instructions for a (limit, price) estimate. */
export function buildComputeBudgetInstructions(
  estimate: ComputeBudgetEstimate,
): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: estimate.unitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: estimate.microLamportsPerCu,
    }),
  ];
}

// ─── Transactions ──────────────────────────────────────────────────────────

/**
 * Build and sign a SOL transfer transaction. When broadcast is true, sends the
 * transaction and returns the signature. Otherwise returns the signed serialized
 * transaction as base64 without submitting it to RPC.
 *
 * Priority fees: pass `options.computeBudget` (an object, or `true` for defaults)
 * to prepend adaptive ComputeBudget instructions — a simulated unit limit plus a
 * per-CU price derived from recent on-chain fees, both bounded by
 * {@link COMPUTE_BUDGET_BOUNDS}. Omit it (or pass `false`) to preserve the legacy
 * single-instruction transfer with no compute budget. Estimation never throws:
 * on any RPC error it falls back to safe defaults.
 */
export async function signSolanaTransaction(
  secretKeyHex: string,
  to: string,
  lamports: bigint,
  rpcUrl: string,
  options: {
    broadcast?: boolean;
    computeBudget?: ComputeBudgetOptions | boolean;
  } = {},
): Promise<string> {
  const keypair = restoreSolanaKeypair(secretKeyHex);
  const connection = new Connection(rpcUrl, "confirmed");
  const shouldBroadcast = options.broadcast !== false;
  const toPubkey = new PublicKey(to);

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const transferIx = SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey,
    lamports: Number(lamports),
  });

  const instructions: TransactionInstruction[] = [];

  // Compute budget is opt-in so existing single-instruction-transfer callers are
  // unaffected. When enabled, the two ComputeBudget instructions are prepended so
  // they sit ahead of the transfer (the runtime reads them regardless of order,
  // but leading them is the convention).
  const cbOption = options.computeBudget;
  if (cbOption !== undefined && cbOption !== false) {
    const estimate = await estimateSolanaComputeBudget(
      connection,
      {
        feePayer: keypair.publicKey,
        instructions: [transferIx],
        recentBlockhash: blockhash,
        signers: [keypair],
        writableAccounts: [keypair.publicKey, toPubkey],
      },
      cbOption === true ? {} : cbOption,
    );
    instructions.push(...buildComputeBudgetInstructions(estimate));
  }

  instructions.push(transferIx);

  const tx = new Transaction({
    recentBlockhash: blockhash,
    feePayer: keypair.publicKey,
  }).add(...instructions);

  if (!shouldBroadcast) {
    tx.sign(keypair);
    return btoa(
      Array.from(tx.serialize(), (b) => String.fromCharCode(b)).join(""),
    );
  }

  const signature = await connection.sendTransaction(tx, [keypair], {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  return signature;
}

export interface SolanaSplTransferTransaction {
  transaction: string;
  sourceTokenAccount: string;
  destinationTokenAccount: string;
  mint: string;
  tokenProgram: string;
  decimals: number;
}

function associatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  )[0];
}

function createTransferCheckedInstruction(args: {
  source: PublicKey;
  mint: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amount: bigint;
  decimals: number;
  tokenProgram: PublicKey;
}): TransactionInstruction {
  const data = new Uint8Array(10);
  data[0] = 12;
  data.set(uint64ToLittleEndian(args.amount), 1);
  data[9] = args.decimals;
  return {
    programId: args.tokenProgram,
    keys: [
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: args.destination, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data: data as unknown as Buffer,
  } as TransactionInstruction;
}

/**
 * Build a canonical SPL Token / Token-2022 TransferChecked transaction between
 * deterministic associated token accounts. This intentionally does not create
 * ATAs; the API parser currently rejects unknown side-effect programs, so a
 * transfer action remains a single policy-checked token movement.
 */
export async function buildSolanaSplTransferTransaction(args: {
  from: string;
  to: string;
  mint: string;
  amount: bigint;
  rpcUrl: string;
}): Promise<SolanaSplTransferTransaction> {
  const owner = new PublicKey(args.from);
  const recipient = new PublicKey(args.to);
  const mint = new PublicKey(args.mint);
  const connection = new Connection(args.rpcUrl, "confirmed");
  const mintAccount = await connection.getParsedAccountInfo(mint, "confirmed");
  const account = mintAccount.value;
  if (!account) {
    throw new Error("SPL token mint account was not found");
  }
  const tokenProgram = account.owner;
  if (
    !tokenProgram.equals(new PublicKey(TOKEN_PROGRAM_ID)) &&
    !tokenProgram.equals(new PublicKey(TOKEN_2022_PROGRAM_ID))
  ) {
    throw new Error(
      "SPL token mint is not owned by the SPL Token or Token-2022 program",
    );
  }

  const parsedData = account.data;
  const decimals =
    typeof parsedData === "object" && "parsed" in parsedData
      ? Number(
          (parsedData.parsed as { info?: { decimals?: unknown } })?.info
            ?.decimals,
        )
      : Number.NaN;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("SPL token mint decimals could not be read from RPC");
  }

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const sourceTokenAccount = associatedTokenAddress(owner, mint, tokenProgram);
  const destinationTokenAccount = associatedTokenAddress(
    recipient,
    mint,
    tokenProgram,
  );
  const tx = new Transaction({
    feePayer: owner,
    recentBlockhash: blockhash,
  }).add(
    createTransferCheckedInstruction({
      source: sourceTokenAccount,
      mint,
      destination: destinationTokenAccount,
      owner,
      amount: args.amount,
      decimals,
      tokenProgram,
    }),
  );

  return {
    transaction: transactionToBase64(tx),
    sourceTokenAccount: sourceTokenAccount.toBase58(),
    destinationTokenAccount: destinationTokenAccount.toBase58(),
    mint: mint.toBase58(),
    tokenProgram: tokenProgram.toBase58(),
    decimals,
  };
}

// ─── Balance ───────────────────────────────────────────────────────────────

/**
 * Query the SOL balance of an address.
 */
export async function getSolanaBalance(
  address: string,
  rpcUrl: string,
): Promise<{ lamports: bigint; formatted: string }> {
  const connection = new Connection(rpcUrl, "confirmed");
  const balance = await connection.getBalance(new PublicKey(address));
  return {
    lamports: BigInt(balance),
    formatted: (balance / LAMPORTS_PER_SOL).toFixed(9),
  };
}

export interface SplTokenBalance {
  mint: string;
  token: string;
  symbol: string;
  balance: string;
  formatted: string;
  decimals: number;
}

function formatBaseUnits(amount: string, decimals: number): string {
  if (decimals <= 0) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Query parsed SPL Token and Token-2022 balances owned by a Solana address.
 *
 * This is a direct wallet RPC read, not an indexed portfolio source. Steward
 * labels only assets in its audited local token registry; unknown mints remain
 * `SPL` rather than trusting mutable, remote token metadata. `chainId` defaults
 * to Solana mainnet (101), so devnet callers must pass 102 explicitly.
 */
export async function getSplTokenBalances(
  address: string,
  rpcUrl: string,
  chainId = 101,
): Promise<SplTokenBalance[]> {
  const connection = new Connection(rpcUrl, "confirmed");
  const owner = new PublicKey(address);
  const programIds = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  const byMint = new Map<string, { balance: bigint; decimals: number }>();

  for (const programId of programIds) {
    const accounts = await connection.getParsedTokenAccountsByOwner(owner, {
      programId: new PublicKey(programId),
    });
    for (const account of accounts.value) {
      const parsed = account.account.data.parsed;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        parsed.info?.mint === undefined
      )
        continue;
      const mint = String(parsed.info.mint);
      const tokenAmount = parsed.info.tokenAmount;
      const amount = String(tokenAmount?.amount ?? "0");
      const decimals = Number(tokenAmount?.decimals ?? 0);
      if (
        !/^\d+$/.test(amount) ||
        !Number.isSafeInteger(decimals) ||
        decimals < 0
      )
        continue;
      const current = byMint.get(mint) ?? { balance: 0n, decimals };
      current.balance += BigInt(amount);
      current.decimals = decimals;
      byMint.set(mint, current);
    }
  }

  return [...byMint.entries()]
    .filter(([, value]) => value.balance > 0n)
    .map(([mint, value]) => {
      const balance = value.balance.toString();
      const knownToken = getKnownToken(chainId, mint);
      const decimals = knownToken?.decimals ?? value.decimals;
      return {
        mint,
        token: mint,
        symbol: knownToken?.symbol ?? "SPL",
        balance,
        formatted: formatBaseUnits(balance, decimals),
        decimals,
      };
    });
}

// ─── Message Signing ──────────────────────────────────────────────────────

/**
 * Sign an arbitrary UTF-8 message with Ed25519, using Node.js built-in crypto
 * (no tweetnacl required). Returns the detached signature as a hex string.
 *
 * Compatible with Phantom / Solana wallet standards for off-chain message signing.
 */
export function signSolanaMessage(
  secretKeyHex: string,
  message: string,
): string {
  const keypair = restoreSolanaKeypair(secretKeyHex);
  const messageBytes = Buffer.from(message, "utf8");

  // keypair.secretKey is 64 bytes: [0..31] = 32-byte seed, [32..63] = public key
  const seed = keypair.secretKey.slice(0, 32);

  // Build an Ed25519 private key via JWK — no tweetnacl required.
  // Use Array.from() helpers to avoid @types/node v25 Uint8Array overload issues.
  const keyObject = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: uint8ArrayToBase64url(seed),
      x: uint8ArrayToBase64url(keypair.publicKey.toBytes()),
    },
    format: "jwk",
  });

  // cryptoSign returns a Buffer — call .toString("hex") directly (no Buffer.from wrapper).
  const signature = cryptoSign(null, messageBytes, keyObject);
  return signature.toString("hex");
}

/**
 * Sign a raw byte payload with Ed25519 using Node.js built-in crypto
 * (no tweetnacl required). Returns the detached signature as a hex string and
 * the signing public key in base58.
 *
 * Unlike secp256k1 (which signs a pre-computed 32-byte digest), Ed25519 signs
 * the message bytes directly (it hashes internally with SHA-512). The vault
 * intentionally restricts the payload to a fixed 32-byte digest before calling
 * this helper so the raw-sign edge cannot be abused to blind-sign a full Solana
 * transaction message; this helper enforces that floor defensively.
 */
export function signEd25519Digest(
  secretKeyHex: string,
  payload: Uint8Array,
): { signature: string; publicKey: string } {
  if (payload.length !== 32) {
    throw new Error("Ed25519 raw digest payload must be exactly 32 bytes");
  }
  const keypair = restoreSolanaKeypair(secretKeyHex);

  // keypair.secretKey is 64 bytes: [0..31] = 32-byte seed, [32..63] = public key
  const seed = keypair.secretKey.slice(0, 32);

  const keyObject = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: uint8ArrayToBase64url(seed),
      x: uint8ArrayToBase64url(keypair.publicKey.toBytes()),
    },
    format: "jwk",
  });

  const signature = cryptoSign(null, payload, keyObject);
  return {
    signature: signature.toString("hex"),
    publicKey: keypair.publicKey.toBase58(),
  };
}

/**
 * Bound the priority fee a transaction may attach. ComputeBudget instructions move
 * no value, but an arbitrarily large `setComputeUnitPrice` would drain the signing
 * wallet's SOL as priority fees entirely outside the spend policy. This enforces
 * the same ceiling the build path already applies (COMPUTE_BUDGET_BOUNDS.
 * MAX_PRIORITY_FEE_LAMPORTS), so the caller-submitted-transaction signing path
 * cannot be used as an uncapped fee drain. Decoded as bigint because the per-CU
 * price is a u64 and `unitLimit × price` overflows Number.
 */
function assertComputeBudgetWithinCap(
  computeBudgetInstructions: TransactionInstruction[],
  totalInstructionCount: number,
): void {
  let explicitUnitLimit: number | undefined;
  let microLamportsPerCu = 0n;
  for (const ix of computeBudgetInstructions) {
    const data = ix.data;
    if (data.length < 1) continue;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    // SetComputeUnitLimit (u32) / SetComputeUnitPrice (u64); the last of each wins
    // on-chain, matching the runtime's behaviour.
    if (data[0] === 2 && data.length >= 5)
      explicitUnitLimit = view.getUint32(1, true);
    else if (data[0] === 3 && data.length >= 9)
      microLamportsPerCu = view.getBigUint64(1, true);
  }
  if (microLamportsPerCu === 0n) return; // no priority fee attached

  // With no explicit unit limit the runtime defaults to 200k CU per instruction
  // (capped at the protocol max) — a conservative upper bound on priced CU.
  const effectiveUnitLimit =
    explicitUnitLimit ??
    Math.min(
      COMPUTE_BUDGET_BOUNDS.MAX_UNIT_LIMIT,
      200_000 * Math.max(1, totalInstructionCount),
    );
  const projectedLamports =
    (BigInt(effectiveUnitLimit) * microLamportsPerCu) / 1_000_000n;
  if (
    projectedLamports > BigInt(COMPUTE_BUDGET_BOUNDS.MAX_PRIORITY_FEE_LAMPORTS)
  ) {
    throw new Error(
      `Solana priority fee (${projectedLamports} lamports) exceeds the allowed maximum of ${COMPUTE_BUDGET_BOUNDS.MAX_PRIORITY_FEE_LAMPORTS} lamports`,
    );
  }
}

export function assertSolanaTransferTransactionMatches(
  tx: Transaction,
  expected: { from: PublicKey; to: string; lamports: bigint },
): void {
  if (expected.lamports < 0n) {
    throw new Error("expected Solana transfer lamports must be non-negative");
  }

  // ComputeBudget instructions (priority-fee price + compute-unit limit) carry no
  // value movement — the ComputeBudget program cannot transfer lamports or tokens —
  // so they are safe to ignore for value policy. After excluding them, the
  // transaction must contain exactly one instruction: the SystemProgram transfer
  // that matches the policy envelope. This lets the vault attach adaptive priority
  // fees, and lets callers submit pre-built transfers that include them, without
  // weakening the single-policy-checked-transfer guarantee. The priority fee they
  // imply is still bounded so it cannot become an uncapped SOL drain.
  const computeBudgetInstructions = tx.instructions.filter((ix) =>
    ix.programId.equals(ComputeBudgetProgram.programId),
  );
  const valueInstructions = tx.instructions.filter(
    (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
  );
  assertComputeBudgetWithinCap(
    computeBudgetInstructions,
    tx.instructions.length,
  );
  if (valueInstructions.length !== 1) {
    throw new Error(
      "Solana signing only supports a single policy-checked transfer instruction (plus optional compute-budget instructions)",
    );
  }

  const [instruction] = valueInstructions;
  if (!instruction.programId.equals(SystemProgram.programId)) {
    throw new Error(
      "Solana transaction instruction must be a SystemProgram transfer",
    );
  }
  const [fromKey, toKey] = instruction.keys;
  if (!fromKey?.pubkey.equals(expected.from) || fromKey.isSigner !== true) {
    throw new Error("Solana transfer source does not match the vault wallet");
  }
  if (!toKey?.pubkey.equals(new PublicKey(expected.to))) {
    throw new Error(
      "Solana transfer recipient does not match the policy envelope",
    );
  }

  const data = instruction.data;
  const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength !== 12 || dataView.getUint32(0, true) !== 2) {
    throw new Error("Solana transaction instruction must be a native transfer");
  }
  const lamports = dataView.getBigUint64(4, true);
  if (lamports !== expected.lamports) {
    throw new Error(
      "Solana transfer amount does not match the policy envelope",
    );
  }
}
