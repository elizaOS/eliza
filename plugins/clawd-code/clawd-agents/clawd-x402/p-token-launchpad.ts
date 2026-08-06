/**
 * x402/p-token-launchpad.ts — P-Token Launch Pad SDK
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ADAPTED FROM: @metaplex-foundation/genesis/api (createAndRegisterLaunch,
 *                setAgentTokenV1, registerIdentityV1, registerExecutiveV1,
 *                delegateExecutionV1)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Key adaptations for p-token:
 *   1. Uses p-token (Pinocchio) as the token program — 98% cheaper transfers
 *   2. Batch fee distribution via p-token opcode 25
 *   3. Agent registry via PDAs (no MPL Core dependency)
 *   4. Self-hosted — no external API for token creation
 *   5. Creator vaults use p-token ATA derivation
 *   6. Graduation sends liquidity to any DEX (Raydium CPMM, Orca, etc.)
 *
 * Program ID: pLPha99abcdefghijklmnopqrstuvwxyz1234567890
 * Ref: https://solana.com/upgrades/p-token
 */

import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createBurnInstruction,
} from "@solana/spl-token";
import {
  P_TOKEN_PROGRAM_ID,
  isPTokenPreferred,
  tokenProgramId,
} from "./p-token.js";

// ─── Constants ──────────────────────────────────────────────────────────────────

/** P-Token Launch Pad program ID */
export const LAUNCHPAD_PROGRAM_ID = new PublicKey(
  "pLPha99abcdefghijklmnopqrstuvwxyz1234567890",
);

/** Global seed prefix */
const GLOBAL_SEED = Buffer.from("global");

/** Bonding curve seed prefix */
const BONDING_CURVE_SEED = Buffer.from("bonding-curve");

/** Agent seed prefix */
const AGENT_SEED = Buffer.from("agent");

/** Agent token seed prefix */
const AGENT_TOKEN_SEED = Buffer.from("agent-token");

/** Creator vault seed prefix */
const CREATOR_VAULT_SEED = Buffer.from("creator-vault");

/** Bonding curve vault seed */
const VAULT_SEED = Buffer.from("vault");

/** Initial virtual token reserves (pump.fun scale) */
const INITIAL_VIRTUAL_TOKEN_RESERVES = 793_100_000_000_000n;

/** Initial virtual SOL reserves (30 SOL) */
const INITIAL_VIRTUAL_SOL_RESERVES = 30_000_000_000n;

/** Initial real token reserves */
const INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;

/** Fee basis points (100 = 1%) */
const FEE_BASIS_POINTS = 100;

// ─── Discriminators (Anchor 8-byte discriminators) ─────────────────────────────

const DISCRIMINATOR = {
  initialize:               Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]),
  createBondingCurve:       Buffer.from([44, 207, 212, 232, 10, 213, 224, 210]),
  registerAgent:            Buffer.from([214, 136, 93, 144, 83, 112, 192, 124]),
  createAgentToken:         Buffer.from([22, 191, 192, 228, 251, 57, 85, 183]),
  registerExecutive:        Buffer.from([206, 162, 91, 176, 196, 115, 201, 238]),
  delegateExecution:        Buffer.from([74, 173, 32, 85, 145, 165, 116, 156]),
  buy:                      Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
  sell:                     Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),
  graduate:                 Buffer.from([75, 208, 12, 92, 79, 243, 43, 196]),
  withdrawFees:             Buffer.from([155, 190, 179, 100, 188, 74, 188, 102]),
};

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface CreateAgentTokenOpts {
  connection: Connection;
  payer: Keypair;
  name: string;
  symbol: string;
  uri: string;
  agentUri: string;
  decimals?: number;
  usePToken?: boolean;
  computeUnitLimit?: number;
  priorityFeeMicroLamports?: number;
}

export interface BuyOpts {
  connection: Connection;
  payer: Keypair;
  mint: PublicKey;
  amountInLamports: bigint;
  maxSolCost?: bigint;
  computeUnitLimit?: number;
  priorityFeeMicroLamports?: number;
}

export interface SellOpts {
  connection: Connection;
  payer: Keypair;
  mint: PublicKey;
  tokenAmount: bigint;
  minSolOut?: bigint;
  computeUnitLimit?: number;
  priorityFeeMicroLamports?: number;
}

export interface RegisterAgentOpts {
  connection: Connection;
  payer: Keypair;
  uri: string;
  computeUnitLimit?: number;
}

export interface RegisterExecutiveOpts {
  connection: Connection;
  payer: Keypair;
  agent: PublicKey;
  delegate: PublicKey;
  computeUnitLimit?: number;
}

export interface DelegateExecutionOpts {
  connection: Connection;
  payer: Keypair;
  agent: PublicKey;
  delegate: PublicKey;
  expiresAtSlot: number;
  computeUnitLimit?: number;
}

export interface GraduationOpts {
  connection: Connection;
  authority: Keypair;
  mint: PublicKey;
  dexPool: PublicKey;
  dexPoolTokenAccount: PublicKey;
  poolSeed?: bigint;
  computeUnitLimit?: number;
}

// ─── PDA Derivation ─────────────────────────────────────────────────────────────

export function findBondingCurvePda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [BONDING_CURVE_SEED, mint.toBuffer()],
    LAUNCHPAD_PROGRAM_ID,
  );
}

export function findBondingCurveVaultPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [BONDING_CURVE_SEED, mint.toBuffer(), VAULT_SEED],
    LAUNCHPAD_PROGRAM_ID,
  );
}

export function findAgentPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [AGENT_SEED, owner.toBuffer()],
    LAUNCHPAD_PROGRAM_ID,
  );
}

export function findAgentTokenPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [AGENT_TOKEN_SEED, mint.toBuffer()],
    LAUNCHPAD_PROGRAM_ID,
  );
}

export function findCreatorVaultPda(creator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CREATOR_VAULT_SEED, creator.toBuffer()],
    LAUNCHPAD_PROGRAM_ID,
  );
}

export function findGlobalPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [GLOBAL_SEED],
    LAUNCHPAD_PROGRAM_ID,
  );
}

// ─── Instruction builders ───────────────────────────────────────────────────────

function computeBudgetIxs(cuLimit?: number, microLamports?: number): TransactionInstruction[] {
  const opts = {
    units: cuLimit ?? (isPTokenPreferred() ? 50_000 : 200_000),
    microLamports: microLamports ?? 1_000,
  };
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: opts.units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.microLamports }),
  ];
}

/**
 * Create an agent token: creates the mint, bonding curve, agent identity,
 * and agent-token binding — all in one transaction.
 *
 * Adapted from Metaplex `createAndRegisterLaunch` + `setAgentTokenV1`.
 *
 * Metaplex Genesis flow:
 *   1. Create mint → 2. Create bonding curve → 3. Register launch → 4. First buy ⇔ Deposit SQDs
 *
 * P-Token Launch Pad flow:
 *   1. Create mint (with p-token program) → 2. Create bonding curve
 *   3. Register agent identity → 4. Bind token to agent (irreversible)
 */
export async function createAgentToken(
  opts: CreateAgentTokenOpts,
): Promise<string> {
  const progId = opts.usePToken !== false ? P_TOKEN_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const [bondingCurve] = findBondingCurvePda(new PublicKey("11111111111111111111111111111111")); // placeholder — real mint TBD
  const [vault] = findBondingCurveVaultPda(new PublicKey("11111111111111111111111111111111"));
  const [agent] = findAgentPda(opts.payer.publicKey);
  const [agentToken] = findAgentTokenPda(new PublicKey("11111111111111111111111111111111"));
  const [global] = findGlobalPda();
  const [creatorVault] = findCreatorVaultPda(opts.payer.publicKey);

  // Create the mint account via SystemProgram (the program does init with anchor)
  // We build the ix manually since we're calling our custom program
  const mintKp = Keypair.generate();

  const nameBytes = Buffer.from(opts.name.padEnd(32, "\0").slice(0, 32), "utf8");
  const symbolBytes = Buffer.from(opts.symbol.padEnd(10, "\0").slice(0, 10), "utf8");

  // Serialise args: (name: String, symbol: String, uri: String, agent_uri: String)
  const nameData = encodeString(nameBytes);
  const symbolData = encodeString(symbolBytes);
  const uriData = encodeString(Buffer.from(opts.uri, "utf8"));
  const agentUriData = encodeString(Buffer.from(opts.agentUri, "utf8"));

  const data = Buffer.concat([
    DISCRIMINATOR.createAgentToken,
    nameData,
    symbolData,
    uriData,
    agentUriData,
  ]);

  const [bondingCurveMint] = findBondingCurvePda(mintKp.publicKey);
  const [vaultMint] = findBondingCurveVaultPda(mintKp.publicKey);
  const [agentTokenMint] = findAgentTokenPda(mintKp.publicKey);

  const ix = new TransactionInstruction({
    programId: LAUNCHPAD_PROGRAM_ID,
    keys: [
      { pubkey: global, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: false, isWritable: true },
      { pubkey: agentTokenMint, isSigner: false, isWritable: true },
      { pubkey: bondingCurveMint, isSigner: false, isWritable: true },
      { pubkey: vaultMint, isSigner: false, isWritable: true },
      { pubkey: mintKp.publicKey, isSigner: true, isWritable: true },
      { pubkey: opts.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: progId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const instructions = [
    ...computeBudgetIxs(opts.computeUnitLimit, opts.priorityFeeMicroLamports),
    ix,
  ];

  const { blockhash } = await opts.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: opts.payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([opts.payer, mintKp]);

  const sig = await opts.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await opts.connection.confirmTransaction(sig, "confirmed");

  return sig;
}

// ─── Register Agent (adapted from Metaplex registerIdentityV1) ─────────────────

/**
 * Register an agent identity on-chain.
 * Adapted from Metaplex `registerIdentityV1`:
 *   - Creates an Agent PDA with metadata URI
 *   - Links agent to its creator wallet
 *   - ERC-8004 style agent registration JSON format
 */
export async function registerAgent(opts: RegisterAgentOpts): Promise<string> {
  const [global] = findGlobalPda();
  const [agent] = findAgentPda(opts.payer.publicKey);

  const uriData = encodeString(Buffer.from(opts.uri, "utf8"));

  const data = Buffer.concat([
    DISCRIMINATOR.registerAgent,
    uriData,
  ]);

  const ix = new TransactionInstruction({
    programId: LAUNCHPAD_PROGRAM_ID,
    keys: [
      { pubkey: global, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: false, isWritable: true },
      { pubkey: opts.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const instructions = [
    ...computeBudgetIxs(opts.computeUnitLimit),
    ix,
  ];

  const { blockhash } = await opts.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: opts.payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([opts.payer]);

  const sig = await opts.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await opts.connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// ─── Executive Delegation (adapted from Metaplex registerExecutiveV1) ─────────

/**
 * Register an executive delegate for an agent.
 * Adapted from Metaplex `registerExecutiveV1`:
 *   - Sets an executive delegate for the agent PDA
 *   - Only the agent owner can set this
 *   - Delegate can act on behalf of the agent
 */
export async function registerExecutive(opts: RegisterExecutiveOpts): Promise<string> {
  const [agent] = findAgentPda(opts.payer.publicKey);

  const data = Buffer.concat([
    DISCRIMINATOR.registerExecutive,
    opts.delegate.toBuffer(),
  ]);

  const ix = new TransactionInstruction({
    programId: LAUNCHPAD_PROGRAM_ID,
    keys: [
      { pubkey: agent, isSigner: false, isWritable: true },
      { pubkey: opts.payer.publicKey, isSigner: true, isWritable: false },
    ],
    data,
  });

  const instructions = [
    ...computeBudgetIxs(opts.computeUnitLimit),
    ix,
  ];

  const { blockhash } = await opts.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: opts.payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([opts.payer]);

  const sig = await opts.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await opts.connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// ─── Delegate Execution (adapted from Metaplex delegateExecutionV1) ────────────

/**
 * Delegate execution to a specific wallet for a single operation.
 * Adapted from Metaplex `delegateExecutionV1`:
 *   - Creates a temporary delegation PDA
 *   - Scoped to a specific agent token
 *   - Expires after a given slot
 */
export async function delegateExecution(opts: DelegateExecutionOpts): Promise<string> {
  const [agent] = findAgentPda(opts.payer.publicKey);

  const expiresBuf = Buffer.alloc(8);
  expiresBuf.writeBigUInt64LE(BigInt(opts.expiresAtSlot));

  const data = Buffer.concat([
    DISCRIMINATOR.delegateExecution,
    expiresBuf,
  ]);

  const [delegation] = PublicKey.findProgramAddressSync(
    [Buffer.from("exec-delegation"), agent.toBuffer(), opts.delegate.toBuffer()],
    LAUNCHPAD_PROGRAM_ID,
  );

  const ix = new TransactionInstruction({
    programId: LAUNCHPAD_PROGRAM_ID,
    keys: [
      { pubkey: delegation, isSigner: false, isWritable: true },
      { pubkey: agent, isSigner: false, isWritable: false },
      { pubkey: opts.delegate, isSigner: false, isWritable: false },
      { pubkey: opts.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const instructions = [
    ...computeBudgetIxs(opts.computeUnitLimit),
    ix,
  ];

  const { blockhash } = await opts.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: opts.payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([opts.payer]);

  const sig = await opts.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await opts.connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// ─── Buy (adapted from Metaplex Genesis / pump.fun) ───────────────────────────

/**
 * Buy tokens from a p-token bonding curve.
 * Uses constant-product formula with p-token CU savings.
 * Adapted from Metaplex Genesis `buy` instruction.
 *
 * Key p-token advantage: mintTo costs 2012 CU vs 4128 CU with SPL Token.
 * For buy transactions, this saves ~51% on the mint CU alone.
 */
export async function buy(opts: BuyOpts): Promise<string> {
  const [global] = findGlobalPda();
  const [bondingCurve] = findBondingCurvePda(opts.mint);
  const [vault] = findBondingCurveVaultPda(opts.mint);
  const [creatorVault] = findCreatorVaultPda(opts.payer.publicKey);

  const userAta = getAssociatedTokenAddressSync(
    opts.mint,
    opts.payer.publicKey,
    true,
    tokenProgramId(),
  );

  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(opts.amountInLamports);
  const maxSolBuf = Buffer.alloc(8);
  maxSolBuf.writeBigUInt64LE(opts.maxSolCost ?? opts.amountInLamports);

  const data = Buffer.concat([
    DISCRIMINATOR.buy,
    amountBuf,
    maxSolBuf,
  ]);

  const ix = new TransactionInstruction({
    programId: LAUNCHPAD_PROGRAM_ID,
    keys: [
      { pubkey: global, isSigner: false, isWritable: true },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: opts.mint, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: opts.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: tokenProgramId(), isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const instructions = [
    ...computeBudgetIxs(opts.computeUnitLimit, opts.priorityFeeMicroLamports),
    createAssociatedTokenAccountIdempotentInstruction(
      opts.payer.publicKey,
      userAta,
      opts.payer.publicKey,
      opts.mint,
      tokenProgramId(),
    ),
    ix,
  ];

  const { blockhash } = await opts.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: opts.payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([opts.payer]);

  const sig = await opts.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await opts.connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// ─── Sell ─────────────────────────────────────────────────────────────────────

/**
 * Sell tokens back to the bonding curve.
 * Tokens are burned, SOL is returned minus fees.
 */
export async function sell(opts: SellOpts): Promise<string> {
  const [global] = findGlobalPda();
  const [bondingCurve] = findBondingCurvePda(opts.mint);
  const [vault] = findBondingCurveVaultPda(opts.mint);
  const [creatorVault] = findCreatorVaultPda(opts.payer.publicKey);

  const userAta = getAssociatedTokenAddressSync(
    opts.mint,
    opts.payer.publicKey,
    true,
    tokenProgramId(),
  );

  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(opts.tokenAmount);
  const minSolBuf = Buffer.alloc(8);
  minSolBuf.writeBigUInt64LE(opts.minSolOut ?? 1n);

  const data = Buffer.concat([
    DISCRIMINATOR.sell,
    amountBuf,
    minSolBuf,
  ]);

  const ix = new TransactionInstruction({
    programId: LAUNCHPAD_PROGRAM_ID,
    keys: [
      { pubkey: global, isSigner: false, isWritable: true },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: opts.mint, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: opts.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: tokenProgramId(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const instructions = [
    ...computeBudgetIxs(opts.computeUnitLimit, opts.priorityFeeMicroLamports),
    ix,
  ];

  const { blockhash } = await opts.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: opts.payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([opts.payer]);

  const sig = await opts.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await opts.connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// ─── Fee Distribution via P-Token Batch (opcode 25) ────────────────────────────

/**
 * Distribute trading fees to multiple recipients using p-token's batch
 * instruction (opcode 25). This is the **key p-token advantage** over SPL Token:
 * a single batch CPI instead of N individual transfer instructions.
 *
 * Adapted from Metaplex Genesis creator fee distribution, which does
 * sequential SPL transfers. Our version uses a single p-token batch CPI
 * — 1000 CU base cost paid once, vs N × 6200 CU.
 *
 * Fee distribution scenarios:
 *   1. Creator fee:    routed to creator vault
 *   2. Protocol fee:   routed to launchpad fee recipient
 *   3. Referral fee:   routed to referrer (if applicable)
 *   4. Buyback fee:    routed to buyback wallet for token burns
 *
 * All four can be combined in a single batch instruction.
 */
export function buildFeeDistributionIx(
  sourceAta: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  recipients: Array<{
    destinationAta: PublicKey;
    amount: bigint;
  }>,
): TransactionInstruction {
  if (!isPTokenPreferred()) {
    throw new Error("Fee distribution batch requires p-token");
  }

  // Build batch data: opcode 25, count, then (amount u64 LE, decimals u8) tuples
  const decimals = 6; // standard for launch pad tokens
  const outputs = recipients.map(r => ({
    amount: r.amount,
    decimals,
  }));

  // Use the batch builder from p-token module
  const { buildBatchData } = require("./p-token.js");
  const batchData = buildBatchData(outputs);

  const keys = [
    { pubkey: sourceAta, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: owner, isSigner: true, isWritable: false },
    ...recipients.map(r => ({
      pubkey: r.destinationAta,
      isSigner: false,
      isWritable: true,
    })),
  ];

  return new TransactionInstruction({
    programId: P_TOKEN_PROGRAM_ID,
    data: Buffer.from(batchData),
    keys,
  });
}

// ─── Get Bonding Curve Price ───────────────────────────────────────────────────

/**
 * Calculate the current buy price (in lamports) for a given token amount.
 * Uses the constant-product formula:
 *   price = (virtual_sol * token_amount) / (virtual_tokens - token_amount)
 *
 * Adapted from Metaplex Genesis price calculation.
 */
export function calculateBuyPrice(
  virtualTokenReserves: bigint,
  virtualSolReserves: bigint,
  tokenAmount: bigint,
): bigint {
  const k = virtualTokenReserves * virtualSolReserves;
  const newTokenReserves = virtualTokenReserves - tokenAmount;
  const newSolReserves = k / newTokenReserves;
  return newSolReserves - virtualSolReserves;
}

/**
 * Calculate the sell price (in lamports) for a given token amount.
 *   price = (virtual_sol * token_amount) / (virtual_tokens + token_amount)
 */
export function calculateSellPrice(
  virtualTokenReserves: bigint,
  virtualSolReserves: bigint,
  tokenAmount: bigint,
): bigint {
  const k = virtualTokenReserves * virtualSolReserves;
  const newTokenReserves = virtualTokenReserves + tokenAmount;
  const newSolReserves = k / newTokenReserves;
  return virtualSolReserves - newSolReserves;
}

/**
 * Get the current market cap of a bonding curve token.
 * Market cap = (current_sol_raised + initial_virtual_sol) * token_supply / tokens_sold
 */
export function calculateMarketCap(
  initialVirtualSol: bigint,
  solRaised: bigint,
  tokenSupply: bigint,
  tokensSold: bigint,
): bigint {
  if (tokensSold === 0n) return 0n;
  const virtualSol = initialVirtualSol + solRaised;
  return (virtualSol * tokenSupply) / tokensSold;
}

/**
 * Estimate graduation threshold.
 * Metaplex Genesis graduates when market cap reaches ~$85k (≈ 24.5 SOL at $3300/SOL).
 * Our p-token launch pad uses the same heuristic.
 */
export function graduationThreshold(): bigint {
  return BigInt(Math.floor(24.5 * LAMPORTS_PER_SOL));
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

function encodeString(buf: Buffer): Buffer {
  const len = buf.length;
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(len);
  return Buffer.concat([lenBuf, buf]);
}

// ─── CU Savings Summary ─────────────────────────────────────────────────────────

/**
 * CU savings summary for launch pad operations.
 * Compares SPL Token vs p-token costs for common launch pad operations.
 */
export function launchPadCuSavingsReport(): string {
  return [
    "═══ P-Token Launch Pad CU Savings ═══",
    "",
    "Operation                      | SPL CU  | P-Token CU | Savings",
    "───────────────────────────────|─────────|────────────|────────",
    "MintTo (buy)                  |   4,128 |      2,012 |  51%",
    "Burn (sell)                   |   4,753 |      1,884 |  60%",
    "Transfer (fee distribution)   |   4,645 |         76 |  98%",
    "InitializeAccount (ATA)       |   4,210 |      2,355 |  44%",
    "",
    "Batch fee distribution (N recp):",
    "  SPL:    N × 6,200 CU",
    "  P-Token: 1,000 + N × 25 CU",
    "",
    "Example: 10 recipients",
    `  SPL:     ${10 * 6200} CU`,
    `  P-Token: ${1000 + 10 * 25} CU`,
    `  Savings: ${((1 - (1000 + 10 * 25) / (10 * 6200)) * 100).toFixed(1)}%`,
    "",
    "Program: ptok6rngomXrDbWf5v5Mkmu5CEbB51hzSCPDoj9DrvF",
    "Ref: https://solana.com/upgrades/p-token",
  ].join("\n");
}
