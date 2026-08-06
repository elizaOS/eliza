/**
 * x402/p-token-stream-facilitator.ts
 *
 * ══════════════════════════════════════════════════════════════════════
 *  THE INNOVATION: Per-Output-Token x402 Metered Billing
 * ══════════════════════════════════════════════════════════════════════
 *
 * Before p-token, per-inference-token micropayments were economically
 * broken:
 *   $0.0001 per token × 1 token = $0.0001 payment
 *   SPL TransferChecked = 6,200 CU ≈ $0.000080 fee
 *   → 80% of payment value consumed by fees. Not viable.
 *
 * After p-token (SIMD-0266):
 *   TransferChecked = 105 CU ≈ $0.000001 fee
 *   → 1% overhead. Per-token billing is now real.
 *
 * How it works:
 *   1. Agent opens a stream against x402.wtf
 *   2. Facilitator issues a METER challenge: price-per-token rate
 *   3. Agent pre-authorises a max spend (e.g. 0.10 USDC for 1000 tokens)
 *   4. Inference runs. Tokens stream back.
 *   5. Every SETTLE_BATCH_SIZE tokens (default 50), or at stream end,
 *      facilitator settles the exact amount consumed via p-token
 *      batch instruction (discriminator 255).
 *   6. Unused authorisation is released — agent never overpays.
 *
 * Three settlement modes:
 *   ATOMIC   — one tx per request (standard x402, just with p-token)
 *   BATCHED  — accumulate N streams, settle in one batch tx (cheapest)
 *   STREAMED — settle every SETTLE_THRESHOLD tokens as they arrive
 *
 * Program: ptok6rngomXrDbWf5v5Mkmu5CEbB51hzSCPDoj9DrvF
 * Ref: https://solana.com/upgrades/p-token
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  P_TOKEN_PROGRAM_ID,
  createPTokenTransferChecked,
  createPTokenATAIdempotent,
  createPTokenComputeBudget,
  getPTokenATA,
  P_TOKEN_CU,
  SPL_TOKEN_CU,
} from './p-token.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SettlementMode = 'atomic' | 'batched' | 'streamed';

export interface MeterChallenge {
  /** x402 version */
  x402Version: 1;
  /** This is a metered challenge, not a fixed-price one */
  scheme: 'metered';
  network: 'solana' | 'solana-devnet';
  /** USDC mint address */
  asset: string;
  /** Facilitator wallet that receives payments */
  payTo: string;
  /** Price in USDC per output token (e.g. 0.0001) */
  pricePerToken: number;
  /** Maximum spend the agent pre-authorises */
  maxSpendUsdc: number;
  /** Maximum tokens agent is willing to receive */
  maxTokens: number;
  /** Stream session ID — links debits to this session */
  sessionId: string;
  /** When this challenge expires (ISO timestamp) */
  expiresAt: string;
  /** Settlement mode chosen by facilitator */
  settlementMode: SettlementMode;
  /** How many tokens to accumulate before intermediate settlement */
  settleBatchSize: number;
  /** Token program in use */
  tokenProgram: string;
  /** CU cost per transfer at this program */
  cuPerTransfer: number;
  /** Facilitator relay endpoint */
  facilitator: string;
  nonce: string;
}

export interface StreamDebit {
  sessionId: string;
  tokensConsumed: number;
  usdcAmount: number;
  timestamp: string;
  settled: boolean;
  signature?: string;
}

export interface StreamSettlement {
  sessionId: string;
  totalTokens: number;
  totalUsdc: number;
  signature: string;
  cuUsed: number;
  cuSavedVsSpl: number;
  batchSize: number;
}

export interface PTokenStreamConfig {
  connection: Connection;
  facilitatorKeypair: Keypair;
  usdcMint: PublicKey;
  /** USDC decimals (6 for mainnet USDC) */
  decimals?: number;
  /** Default price per output token in USDC */
  defaultPricePerToken?: number;
  /** Tokens to accumulate before settling in streamed mode */
  settleBatchSize?: number;
  /** Default settlement mode */
  defaultMode?: SettlementMode;
  /** Maximum CU budget per settle tx (p-token default: 12,000) */
  computeUnitLimit?: number;
  /** Priority fee in microlamports */
  priorityFeeMicroLamports?: number;
}

// ─── Per-stream session state ─────────────────────────────────────────────────

interface StreamSession {
  id: string;
  payerPubkey: PublicKey;
  payerAta: PublicKey;
  facilitatorAta: PublicKey;
  pricePerToken: number;
  maxSpendUsdc: number;
  debits: StreamDebit[];
  pendingTokens: number;
  totalSettledUsdc: number;
  mode: SettlementMode;
  batchSize: number;
  createdAt: string;
  lastActivityAt: string;
}

// ─── PTokenStreamFacilitator ──────────────────────────────────────────────────

export class PTokenStreamFacilitator {
  private sessions = new Map<string, StreamSession>();
  private batchQueue: StreamSession[] = [];  // for BATCHED mode

  constructor(private readonly config: PTokenStreamConfig) {}

  get decimals(): number { return this.config.decimals ?? 6; }
  get pricePerToken(): number { return this.config.defaultPricePerToken ?? 0.0001; }
  get batchSize(): number { return this.config.settleBatchSize ?? 50; }
  get mode(): SettlementMode { return this.config.defaultMode ?? 'batched'; }

  // ─── Challenge issuance ────────────────────────────────────────────────────

  /**
   * Issue a METER challenge to an agent requesting AI inference.
   * The agent pre-authorises a max spend; we settle the exact amount consumed.
   */
  issueChallenge(opts: {
    payerPubkey: string;
    maxTokens?: number;
    maxSpendUsdc?: number;
    mode?: SettlementMode;
  }): MeterChallenge {
    const maxTokens = opts.maxTokens ?? 2048;
    const maxSpendUsdc = opts.maxSpendUsdc ?? parseFloat((maxTokens * this.pricePerToken).toFixed(6));
    const sessionId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = new Date(Date.now() + 300_000).toISOString();  // 5 min

    // Register session
    const payerPubkey = new PublicKey(opts.payerPubkey);
    const payerAta = getPTokenATA(this.config.usdcMint, payerPubkey);
    const facilitatorAta = getPTokenATA(this.config.usdcMint, this.config.facilitatorKeypair.publicKey);

    this.sessions.set(sessionId, {
      id: sessionId,
      payerPubkey,
      payerAta,
      facilitatorAta,
      pricePerToken: this.pricePerToken,
      maxSpendUsdc,
      debits: [],
      pendingTokens: 0,
      totalSettledUsdc: 0,
      mode: opts.mode ?? this.mode,
      batchSize: this.batchSize,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });

    return {
      x402Version: 1,
      scheme: 'metered',
      network: (process.env['SOLANA_NETWORK'] ?? 'solana-devnet') as 'solana' | 'solana-devnet',
      asset: this.config.usdcMint.toBase58(),
      payTo: this.config.facilitatorKeypair.publicKey.toBase58(),
      pricePerToken: this.pricePerToken,
      maxSpendUsdc,
      maxTokens,
      sessionId,
      expiresAt,
      settlementMode: opts.mode ?? this.mode,
      settleBatchSize: this.batchSize,
      tokenProgram: P_TOKEN_PROGRAM_ID.toBase58(),
      cuPerTransfer: P_TOKEN_CU.transferChecked,
      facilitator: process.env['PAYSH_RELAY_URL'] ?? 'https://x402.wtf/relay/v1',
      nonce: bs58.encode(crypto.getRandomValues(new Uint8Array(16))),
    };
  }

  // ─── Metering ──────────────────────────────────────────────────────────────

  /**
   * Record tokens consumed against a session. In STREAMED mode, triggers
   * settlement when pendingTokens crosses batchSize. Returns a settled
   * signature if settlement occurred, otherwise null.
   */
  async meter(sessionId: string, tokensConsumed: number): Promise<string | null> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown stream session: ${sessionId}`);

    const usdcAmount = parseFloat((tokensConsumed * session.pricePerToken).toFixed(6));
    const totalIfSettled = session.totalSettledUsdc + usdcAmount;

    if (totalIfSettled > session.maxSpendUsdc) {
      throw new Error(
        `Stream ${sessionId}: spend cap exceeded — ` +
        `${totalIfSettled.toFixed(6)} > ${session.maxSpendUsdc} USDC`,
      );
    }

    session.pendingTokens += tokensConsumed;
    session.lastActivityAt = new Date().toISOString();
    session.debits.push({
      sessionId,
      tokensConsumed,
      usdcAmount,
      timestamp: new Date().toISOString(),
      settled: false,
    });

    // STREAMED mode: settle when batch fills
    if (session.mode === 'streamed' && session.pendingTokens >= session.batchSize) {
      return this.settleSession(sessionId);
    }

    return null;
  }

  // ─── Settlement ────────────────────────────────────────────────────────────

  /**
   * Settle all pending debits for a session. Builds a single p-token
   * TransferChecked instruction (or uses the batch instruction for
   * multi-session batched mode) and broadcasts.
   */
  async settleSession(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);

    const unsettled = session.debits.filter(d => !d.settled);
    if (unsettled.length === 0) return 'no-op';

    const totalUsdc = unsettled.reduce((sum, d) => sum + d.usdcAmount, 0);
    const atomicUnits = BigInt(Math.round(totalUsdc * Math.pow(10, this.decimals)));

    const sig = await this._executeTransfer(session, atomicUnits);

    // Mark debits as settled
    unsettled.forEach(d => { d.settled = true; d.signature = sig; });
    session.totalSettledUsdc += totalUsdc;
    session.pendingTokens = 0;

    return sig;
  }

  /**
   * Batch settle multiple sessions in a single transaction using p-token's
   * batch instruction (discriminator 255). This is the most efficient mode:
   * 1000 CU base cost paid once for N transfers vs N × 1000.
   *
   * Only available with P_TOKEN_PROGRAM_ID.
   */
  async settleBatch(sessionIds: string[]): Promise<StreamSettlement[]> {
    if (sessionIds.length === 0) return [];

    const sessions = sessionIds.map(id => {
      const s = this.sessions.get(id);
      if (!s) throw new Error(`Unknown session: ${id}`);
      return s;
    });

    // Build one transfer instruction per session, then wrap in batch
    const transfers = sessions.map(s => {
      const unsettled = s.debits.filter(d => !d.settled);
      const totalUsdc = unsettled.reduce((sum, d) => sum + d.usdcAmount, 0);
      const atomicUnits = BigInt(Math.round(totalUsdc * Math.pow(10, this.decimals)));
      return { session: s, atomicUnits, unsettled, totalUsdc };
    }).filter(t => t.atomicUnits > 0n);

    if (transfers.length === 0) return [];

    // Build individual transfer instructions
    const ixs = transfers.map(({ session, atomicUnits }) =>
      createPTokenTransferChecked(
        session.payerAta,
        this.config.usdcMint,
        session.facilitatorAta,
        this.config.facilitatorKeypair.publicKey,
        atomicUnits,
        this.decimals,
      ),
    );

    // Compute units: 105 per transfer + 1000 base (paid once via batch)
    const cuTotal = 1000 + (transfers.length * P_TOKEN_CU.transferChecked);
    const cuSplEquiv = transfers.length * SPL_TOKEN_CU.transferChecked;

    const budgetIxs = createPTokenComputeBudget({
      computeUnits: Math.min(cuTotal + 5000, 200_000),
    });

    const { blockhash } = await this.config.connection.getLatestBlockhash('confirmed');
    const allKeys = [...new Set(
      ixs.flatMap(ix => ix.keys.map(k => k.pubkey.toBase58())),
    )].map(k => ({
      pubkey: new PublicKey(k),
      isSigner: k === this.config.facilitatorKeypair.publicKey.toBase58(),
      isWritable: true,
    }));

    // Use batch instruction for all transfers in one CPI
    const { createBatchInstruction } = await import('./p-token.js');
    const batchIx = createBatchInstruction(ixs, allKeys);

    const message = new TransactionMessage({
      payerKey: this.config.facilitatorKeypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [...budgetIxs, batchIx],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([this.config.facilitatorKeypair]);

    const sig = await this.config.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await this.config.connection.confirmTransaction(sig, 'confirmed');

    // Mark all sessions settled
    return transfers.map(({ session, unsettled, totalUsdc }) => {
      unsettled.forEach(d => { d.settled = true; d.signature = sig; });
      session.totalSettledUsdc += totalUsdc;
      session.pendingTokens = 0;
      return {
        sessionId: session.id,
        totalTokens: unsettled.reduce((n, d) => n + d.tokensConsumed, 0),
        totalUsdc,
        signature: sig,
        cuUsed: cuTotal,
        cuSavedVsSpl: cuSplEquiv - cuTotal,
        batchSize: transfers.length,
      };
    });
  }

  /**
   * Close a stream session: settle any remaining balance then clean up.
   * Returns the final settlement or null if balance was zero.
   */
  async closeSession(sessionId: string): Promise<StreamSettlement | null> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);

    const unsettled = session.debits.filter(d => !d.settled);
    const totalTokens = unsettled.reduce((n, d) => n + d.tokensConsumed, 0);
    const totalUsdc   = unsettled.reduce((s, d) => s + d.usdcAmount, 0);

    if (unsettled.length === 0) {
      this.sessions.delete(sessionId);
      return null;
    }

    const sig = await this.settleSession(sessionId);
    this.sessions.delete(sessionId);

    const cuUsed = P_TOKEN_CU.transferChecked + 5000;
    return {
      sessionId,
      totalTokens,
      totalUsdc,
      signature: sig,
      cuUsed,
      cuSavedVsSpl: SPL_TOKEN_CU.transferChecked - P_TOKEN_CU.transferChecked,
      batchSize: 1,
    };
  }

  // ─── Analytics ────────────────────────────────────────────────────────────

  /**
   * How much USDC this facilitator has saved in Solana fees by using
   * p-token instead of standard SPL Token, across all settled transfers.
   */
  totalCuSavedAcrossAllSessions(): { cuSaved: number; transferCount: number; usdcEquiv: string } {
    let totalSettled = 0;
    this.sessions.forEach(s => {
      totalSettled += s.debits.filter(d => d.settled).length;
    });
    const cuSavedPer = SPL_TOKEN_CU.transferChecked - P_TOKEN_CU.transferChecked;
    const cuSaved = totalSettled * cuSavedPer;
    // Rough USDC equiv at ~1M CU = $0.013
    const usdcEquiv = ((cuSaved / 1_000_000) * 0.013).toFixed(6);
    return { cuSaved, transferCount: totalSettled, usdcEquiv };
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private async _executeTransfer(session: StreamSession, atomicUnits: bigint): Promise<string> {
    const instructions = [
      ...createPTokenComputeBudget({
        computeUnits: this.config.computeUnitLimit,
        microLamportsPerCU: this.config.priorityFeeMicroLamports,
      }),
      createPTokenATAIdempotent(
        this.config.facilitatorKeypair.publicKey,
        session.facilitatorAta,
        this.config.facilitatorKeypair.publicKey,
        this.config.usdcMint,
      ),
      createPTokenTransferChecked(
        session.payerAta,
        this.config.usdcMint,
        session.facilitatorAta,
        this.config.facilitatorKeypair.publicKey,
        atomicUnits,
        this.decimals,
      ),
    ];

    const { blockhash } = await this.config.connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: this.config.facilitatorKeypair.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([this.config.facilitatorKeypair]);

    const sig = await this.config.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await this.config.connection.confirmTransaction(sig, 'confirmed');
    return sig;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createStreamFacilitator(opts: {
  rpcUrl?: string;
  facilitatorSecretKey?: string;
  usdcMint?: string;
  mode?: SettlementMode;
  pricePerToken?: number;
}): PTokenStreamFacilitator {
  const rpcUrl = opts.rpcUrl ?? process.env['SOLANA_RPC_URL'] ?? 'https://api.devnet.solana.com';
  const secretKey = opts.facilitatorSecretKey ?? process.env['FACILITATOR_SECRET_KEY'];
  if (!secretKey) throw new Error('FACILITATOR_SECRET_KEY required');

  const keypair = Keypair.fromSecretKey(bs58.decode(secretKey));
  const usdcMint = new PublicKey(
    opts.usdcMint ?? process.env['USDC_MINT'] ?? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  );

  return new PTokenStreamFacilitator({
    connection: new Connection(rpcUrl, 'confirmed'),
    facilitatorKeypair: keypair,
    usdcMint,
    defaultMode: opts.mode ?? 'batched',
    defaultPricePerToken: opts.pricePerToken ?? 0.0001,
    settleBatchSize: 50,
  });
}
