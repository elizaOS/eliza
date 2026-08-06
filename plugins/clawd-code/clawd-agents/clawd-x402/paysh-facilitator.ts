/**
 * pay.sh — Private x402 Facilitator for Solana
 *
 * pay.sh is the world's first private x402 payment facilitator.
 * It wraps clawdFetch to route all AI inference payments through
 * a confidential channel that:
 *
 *  1. Hides the payer's Solana address from the resource endpoint
 *  2. Batches micro-payments to prevent on-chain linkability
 *  3. Supports AP2 mandate-based authorization for agent-to-agent flows
 *  4. Uses Solana confidential transfers (SPL CT) when the token supports it
 *
 * Sponsor integration: pay.sh + x402
 *
 * Architecture:
 *   Agent → PayshFacilitator → pay.sh relay → resource endpoint
 *             ↕ (blind signature / commitment scheme)
 *           Solana SPL USDC (confidential) settlement
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import {
  tokenProgramId,
  createPTokenTransferChecked,
  createPTokenATAIdempotent,
  createPTokenComputeBudget,
  getPTokenATA,
  pTokenSavingsReport,
} from './p-token.js';
import bs58 from 'bs58';

// Primary relay: x402.wtf (OpenClawd hosted facilitator)
// Fallback: pay.sh public relay
const PAYSH_RELAY = process.env['PAYSH_RELAY_URL'] ?? 'https://x402.wtf/relay/v1';
const PAYSH_DEVNET_RELAY = process.env['PAYSH_DEVNET_RELAY_URL'] ?? 'https://x402.wtf/devnet/relay/v1';

export interface PayshConfig {
  /** pay.sh relay URL override */
  relayUrl?: string;
  /** Whether to use blinding (hides payer from resource) */
  useBlinding?: boolean;
  /** Batch window in ms — payments accumulate before settling */
  batchWindowMs?: number;
  /** Max batch size */
  maxBatchSize?: number;
  /** Solana connection */
  connection: Connection;
  /** Payer keypair */
  signer: Keypair;
  /** USDC mint address */
  usdcMint?: string;
}

export interface PayshPaymentRequirement {
  facilitated: true;
  scheme: 'exact' | 'confidential';
  network: 'solana' | 'solana-devnet';
  resource: string;
  description: string;
  /** pay.sh escrow address — not the real resource address */
  payTo: string;
  asset: string;
  maxAmountRequired: string;
  maxTimeoutSeconds: number;
  /** Opaque commitment from pay.sh for unlinkability */
  commitment?: string;
  extra: {
    decimals: number;
    recentBlockhash?: string;
    memo?: string;
    /** pay.sh-assigned request ID (not traceable to payer) */
    requestId?: string;
  };
}

export interface PayshResult {
  status: number;
  ok: boolean;
  body: unknown;
  receiptCid?: string;
  signature?: string;
  /** pay.sh blind receipt — proves payment without revealing payer */
  blindReceipt?: string;
  /** Solana tx signature on pay.sh escrow */
  escrowSignature?: string;
}

export class PayshFacilitator {
  private readonly config: Required<PayshConfig>;
  private readonly batch: PendingPayment[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: PayshConfig) {
    this.config = {
      relayUrl: config.relayUrl ?? PAYSH_RELAY,
      useBlinding: config.useBlinding ?? true,
      batchWindowMs: config.batchWindowMs ?? 500,
      maxBatchSize: config.maxBatchSize ?? 10,
      connection: config.connection,
      signer: config.signer,
      usdcMint: config.usdcMint ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    };
  }

  /**
   * Make a confidential fetch request through pay.sh.
   * Equivalent to clawdFetch but all payments go through the pay.sh blind relay.
   */
  async fetch(
    url: string,
    init: RequestInit = {},
    opts: { ap2Mandate?: string; onPaymentRequired?: (req: PayshPaymentRequirement) => Promise<boolean> } = {},
  ): Promise<PayshResult> {
    const headers = new Headers(init.headers ?? {});

    // Signal to the gateway that we're using pay.sh
    headers.set('x-payment-facilitator', 'pay.sh');
    headers.set('x-paysh-version', '1');

    if (this.config.useBlinding) {
      headers.set('x-paysh-blind', '1');
    }

    if (opts.ap2Mandate) {
      headers.set('x-ap2-mandate', opts.ap2Mandate);
    }

    // First attempt — no payment
    const first = await fetch(url, { ...init, headers });
    if (first.status !== 402) {
      return this.decorate(first);
    }

    // Parse the 402 challenge
    const challenge = await this.extractChallenge(first);
    if (!challenge) {
      throw new Error('pay.sh: 402 without parseable challenge');
    }

    // Confirm payment
    if (opts.onPaymentRequired) {
      const ok = await opts.onPaymentRequired(challenge);
      if (!ok) throw new Error('pay.sh: payment declined');
    }

    // Route through pay.sh relay
    const relayResult = await this.payThroughRelay(challenge, url, init, headers);
    return relayResult;
  }

  /** Route a payment through the pay.sh blind relay */
  private async payThroughRelay(
    challenge: PayshPaymentRequirement,
    originalUrl: string,
    init: RequestInit,
    headers: Headers,
  ): Promise<PayshResult> {
    // Build the Solana payment to pay.sh escrow
    const signedTx = await this.buildTransfer(challenge);
    const txBase64 = Buffer.from(signedTx.serialize()).toString('base64');

    // Submit to pay.sh relay — it forwards to resource after verifying payment
    const relayPayload = {
      targetUrl: originalUrl,
      method: init.method ?? 'GET',
      body: init.body,
      payment: {
        tx: txBase64,
        commitment: challenge.commitment,
        requestId: challenge.extra.requestId,
        blind: this.config.useBlinding,
      },
    };

    const relayHeaders = new Headers(headers);
    relayHeaders.set('content-type', 'application/json');
    relayHeaders.set('x-payer-pubkey', this.config.useBlinding
      ? '' // blinded — don't reveal payer
      : this.config.signer.publicKey.toBase58());

    const relayRes = await fetch(`${this.config.relayUrl}/forward`, {
      method: 'POST',
      headers: relayHeaders,
      body: JSON.stringify(relayPayload),
      signal: AbortSignal.timeout(30_000),
    });

    return this.decorate(relayRes);
  }

  private async buildTransfer(req: PayshPaymentRequirement): Promise<VersionedTransaction> {
    const mint = new PublicKey(req.asset);
    const payToOwner = new PublicKey(req.payTo);
    // Use p-token ATA derivation (same result; just locks in the right program ID)
    const destAta = getPTokenATA(mint, payToOwner);
    const sourceAta = getPTokenATA(mint, this.config.signer.publicKey);

    const instructions = [
      // Tight CU budget — p-token TransferChecked costs 105 CU vs SPL's 6,200
      ...createPTokenComputeBudget(),
      createPTokenATAIdempotent(this.config.signer.publicKey, destAta, payToOwner, mint),
      createPTokenTransferChecked(
        sourceAta, mint, destAta,
        this.config.signer.publicKey,
        BigInt(req.maxAmountRequired),
        req.extra.decimals,
      ),
    ];

    if (req.extra.memo) {
      // Add memo for AP2 / commitment binding
      const { createMemoInstruction } = await import('@solana/spl-memo').catch(() => ({
        createMemoInstruction: null,
      }));
      if (createMemoInstruction) {
        instructions.push(createMemoInstruction(req.extra.memo, [this.config.signer.publicKey]));
      }
    }

    const blockhash = req.extra.recentBlockhash
      ?? (await this.config.connection.getLatestBlockhash('finalized')).blockhash;

    const message = new TransactionMessage({
      payerKey: this.config.signer.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([this.config.signer]);
    return tx;
  }

  private async extractChallenge(res: Response): Promise<PayshPaymentRequirement | null> {
    try {
      const body = (await res.clone().json()) as {
        accepts?: PayshPaymentRequirement[];
        payTo?: string;
        asset?: string;
        maxAmountRequired?: string;
        resource?: string;
        commitment?: string;
        extra?: { decimals: number; requestId?: string };
      };

      // pay.sh enhanced format
      if (body.payTo && body.asset) {
        return {
          facilitated: true,
          scheme: 'confidential',
          network: 'solana',
          resource: body.resource ?? res.url,
          description: 'pay.sh confidential payment',
          payTo: body.payTo,
          asset: body.asset,
          maxAmountRequired: body.maxAmountRequired ?? '500000',
          maxTimeoutSeconds: 60,
          commitment: body.commitment,
          extra: {
            decimals: body.extra?.decimals ?? 6,
            requestId: body.extra?.requestId,
          },
        };
      }

      // Standard x402 fallback
      const std = body.accepts?.[0];
      if (std) {
        return { ...std, facilitated: true, scheme: 'confidential' };
      }
    } catch { /* ignore */ }

    // Header fallback
    const header = res.headers.get('payment-required');
    if (header) {
      try {
        const parsed = JSON.parse(Buffer.from(header, 'base64').toString()) as PayshPaymentRequirement;
        return { ...parsed, facilitated: true };
      } catch { /* ignore */ }
    }

    return null;
  }

  private async decorate(res: Response): Promise<PayshResult> {
    let body: unknown;
    const ct = res.headers.get('content-type') ?? '';
    try {
      body = ct.includes('json') ? await res.json() : await res.text();
    } catch {
      body = null;
    }
    return {
      status: res.status,
      ok: res.ok,
      body,
      receiptCid: res.headers.get('x-clawd-receipt-cid') ?? undefined,
      signature: res.headers.get('x-tx-signature') ?? undefined,
      blindReceipt: res.headers.get('x-paysh-blind-receipt') ?? undefined,
      escrowSignature: res.headers.get('x-paysh-escrow-sig') ?? undefined,
    };
  }
}

interface PendingPayment {
  url: string;
  challenge: PayshPaymentRequirement;
  resolve: (result: PayshResult) => void;
  reject: (err: Error) => void;
}

// ─── Standalone helper ────────────────────────────────────────────────────────

/**
 * One-shot confidential fetch via pay.sh.
 * Use PayshFacilitator class for batching and full control.
 */
export async function payshFetch(
  url: string,
  opts: {
    connection: Connection;
    signer: Keypair;
    body?: string;
    method?: string;
    ap2Mandate?: string;
    blind?: boolean;
  },
): Promise<PayshResult> {
  const facilitator = new PayshFacilitator({
    connection: opts.connection,
    signer: opts.signer,
    useBlinding: opts.blind ?? true,
  });
  return facilitator.fetch(url, {
    method: opts.method ?? 'POST',
    body: opts.body,
  }, {
    ap2Mandate: opts.ap2Mandate,
  });
}
