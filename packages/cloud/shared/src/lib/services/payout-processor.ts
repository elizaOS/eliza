/**
 * Secure Payout Processor Service
 *
 * Handles the actual token transfer for approved redemptions.
 *
 * ============================================================================
 * 🚨 CRITICAL SECURITY COMPONENT 🚨
 * ============================================================================
 *
 * This service manages private keys for hot wallets. It should:
 * 1. Run as a separate, isolated service (not in the main API process)
 * 2. Use HSM/KMS for key management in production
 * 3. Have minimal network exposure (internal only)
 * 4. Be rate-limited at infrastructure level
 * 5. Log all operations to immutable audit log
 *
 * PAYOUT FLOW:
 * 1. Cron job or worker picks up approved redemptions
 * 2. Validates quote hasn't expired
 * 3. Re-validates price within tolerance
 * 4. Locks redemption record (status = processing)
 * 5. Signs and broadcasts transaction
 * 6. Waits for confirmation
 * 7. Updates record with tx hash (status = completed)
 *
 * FAILURE HANDLING:
 * - Failed transactions are marked as "failed" with reason (requires_review)
 * - Automatic retry up to MAX_RETRY_ATTEMPTS
 * - Manual intervention flagged after max retries
 * - A provably-un-broadcast failed redemption (no tokens sent) returns its
 *   locked earnings from total_pending to the user's available_balance
 *   (refundStrandedRedemption); a broadcast-but-unconfirmed redemption is left
 *   for on-chain reconciliation and NOT auto-refunded (would be a reverse
 *   double-pay).
 *
 * ============================================================================
 */

import bs58 from "bs58";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { dbRead, dbWrite } from "../../db/client";
import { redeemableEarnings, redeemableEarningsLedger } from "../../db/schemas/redeemable-earnings";
import { tokenRedemptions } from "../../db/schemas/token-redemptions";
import {
  type EvmPayoutNetwork,
  listEvmPayoutNetworks,
  payoutEvmChain,
  resolvePayoutEvmRpc,
} from "../config/evm-rpc";
import {
  getMonitoringPayoutAsset,
  getPayoutTokenConfig,
  isPayoutLaunchRail,
  PAYOUT_LAUNCH_ASSET,
  PAYOUT_LAUNCH_NETWORK,
} from "../config/payout-assets";
import { ERC20_ABI } from "../config/token-constants";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { elizaTokenPriceService, type SupportedNetwork } from "./eliza-token-price";
import { payoutAlertsService } from "./payout-alerts";
import { redeemableEarningsService } from "./redeemable-earnings";

// Configuration
const PAYOUT_CONFIG = {
  // Maximum price slippage allowed from quote (5%)
  MAX_PRICE_SLIPPAGE: 0.05,

  // Default false: redemption requests lock the USD value and token amount at
  // request time. Admin approval may happen later, so re-pricing during payout
  // would break the fixed-dollar guarantee.
  ENFORCE_PRICE_VALIDATION: false,

  // Worker ID for distributed locking
  WORKER_ID: `worker-${process.pid}`,

  // Processing lock timeout (5 minutes)
  LOCK_TIMEOUT_MS: 5 * 60 * 1000,

  // Maximum retries before requiring manual intervention
  MAX_RETRY_ATTEMPTS: 3,

  // Batch size for processing
  BATCH_SIZE: 10,

  // Minimum hot wallet balance before alerting (in tokens)
  MIN_HOT_WALLET_BALANCE: 1000,
};

function getPayoutConfig() {
  const env = getCloudAwareEnv();
  return {
    ...PAYOUT_CONFIG,
    ENFORCE_PRICE_VALIDATION: env.PAYOUT_ENFORCE_PRICE_VALIDATION === "true",
    WORKER_ID: env.PAYOUT_WORKER_ID || PAYOUT_CONFIG.WORKER_ID,
  };
}

// Token decimals, EVM chains, ERC20_ABI imported from @/lib/config/token-constants

interface PayoutResult {
  success: boolean;
  txHash?: string;
  error?: string;
  retryable?: boolean;
}

/**
 * Thrown when a `token_redemptions` NUMERIC money field (eliza_amount,
 * eliza_price_usd, usd_value) reads back as a non-finite / unparseable value.
 *
 * These columns are Postgres `numeric(...)` and are returned by the driver as
 * STRINGS. A corrupt/malformed value (`'NaN'::numeric` is a legal store, a
 * truncated write, a bad manual edit) coerces to `NaN` under bare `Number()`,
 * or to `0n` under `viem.parseUnits('')`. On a hot-wallet payout path that is
 * catastrophic:
 *   - `Number(eliza_price_usd)=NaN` makes the price-slippage guard
 *     `slippage > MAX` evaluate `NaN > x === false` → the guard FAILS OPEN and
 *     authorizes a payout against an unvalidatable quote.
 *   - `parseUnits('', decimals)` returns `0n` and `Number('')*1e9 = 0` →
 *     a ZERO-token transfer is broadcast, confirmed, and marked `completed`
 *     with a real tx hash → fabricated success while the user receives nothing
 *     and their pending balance is still debited.
 *
 * Parsing these values through {@link parseRedemptionAmount} converts that
 * silent fail-open into an explicit, non-retryable failure that routes to
 * manual review before anything is signed or broadcast.
 */
export class CorruptRedemptionAmountError extends Error {
  constructor(
    public readonly field: string,
    public readonly rawValue: unknown,
  ) {
    super(`token_redemptions.${field} is not a finite number: ${JSON.stringify(rawValue)}`);
    this.name = "CorruptRedemptionAmountError";
  }
}

/**
 * Fail-closed boundary for a `token_redemptions` NUMERIC money field.
 *
 * Accepts an explicit domain value of `0` (a legitimate zero-value field), but
 * throws {@link CorruptRedemptionAmountError} for `null`/`undefined`, an empty
 * or whitespace-only string, or anything that does not coerce to a finite
 * number. NEVER returns `NaN` and NEVER silently substitutes `0`.
 */
export function parseRedemptionAmount(field: string, raw: unknown): number {
  if (raw === null || raw === undefined) {
    throw new CorruptRedemptionAmountError(field, raw);
  }
  if (typeof raw === "string" && raw.trim() === "") {
    throw new CorruptRedemptionAmountError(field, raw);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CorruptRedemptionAmountError(field, raw);
  }
  return value;
}

interface ProcessingStats {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

/**
 * Payout Processor Service
 *
 * IMPORTANT: This service requires sensitive environment variables:
 * - EVM_PAYOUT_PRIVATE_KEY: Private key for EVM hot wallet
 * - SOLANA_PAYOUT_PRIVATE_KEY: Base58 encoded private key for Solana hot wallet
 *
 * These should NEVER be committed to code or logs.
 * In production, use AWS KMS, HashiCorp Vault, or similar.
 */
export class PayoutProcessorService {
  private readonly evmPrivateKey: `0x${string}` | null;
  private readonly solanaKeypair: import("@solana/web3.js").Keypair | null;
  private readonly solanaConnection: import("@solana/web3.js").Connection | null;

  constructor() {
    const env = getCloudAwareEnv();

    // Load EVM private key (support both naming conventions)
    const evmKey = env.EVM_PAYOUT_PRIVATE_KEY || env.EVM_PRIVATE_KEY;
    if (evmKey) {
      this.evmPrivateKey = evmKey.startsWith("0x")
        ? (evmKey as `0x${string}`)
        : (`0x${evmKey}` as `0x${string}`);
      logger.info("[PayoutProcessor] EVM hot wallet configured");
    } else {
      this.evmPrivateKey = null;
      logger.warn(
        "[PayoutProcessor] EVM_PAYOUT_PRIVATE_KEY or EVM_PRIVATE_KEY not set - EVM payouts disabled",
      );
    }

    // Load Solana keypair
    const solanaKey = env.SOLANA_PAYOUT_PRIVATE_KEY;
    if (solanaKey) {
      try {
        const { Connection, Keypair } =
          require("@solana/web3.js") as typeof import("@solana/web3.js");
        const decoded = bs58.decode(solanaKey);
        this.solanaKeypair = Keypair.fromSecretKey(decoded);
        const solanaRpc = env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
        this.solanaConnection = new Connection(solanaRpc, "confirmed");
        logger.info("[PayoutProcessor] Solana hot wallet configured");
      } catch (error) {
        this.solanaKeypair = null;
        this.solanaConnection = null;
        logger.error(
          "[PayoutProcessor] Invalid SOLANA_PAYOUT_PRIVATE_KEY - Solana payouts disabled",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    } else {
      this.solanaKeypair = null;
      this.solanaConnection = null;
      logger.warn("[PayoutProcessor] SOLANA_PAYOUT_PRIVATE_KEY not set - Solana payouts disabled");
    }
  }

  /**
   * Check if the processor is configured and ready to process payouts.
   */
  isConfigured(): { evm: boolean; solana: boolean; any: boolean } {
    return {
      evm: !!this.evmPrivateKey,
      solana: !!this.solanaKeypair,
      any: !!(this.evmPrivateKey || this.solanaKeypair),
    };
  }

  /**
   * Process a batch of approved redemptions.
   * Should be called by a cron job or worker process.
   */
  async processBatch(): Promise<ProcessingStats> {
    const payoutConfig = getPayoutConfig();
    const stats: ProcessingStats = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    };

    // Check if any payout method is configured
    const walletConfig = this.isConfigured();
    if (!walletConfig.any) {
      logger.warn("[PayoutProcessor] No payout wallets configured - skipping batch processing");
      return stats;
    }

    // Recover redemptions abandoned in `processing` by a dead/evicted worker
    // BEFORE selecting fresh work. A provably-safe row (no broadcast tx hash) is
    // returned to `approved` so it can retry in this same batch; a row that
    // already broadcast a transaction is left alone and surfaced for on-chain
    // reconciliation (re-broadcasting would double-pay).
    await this.recoverStaleProcessing();

    // Find approved redemptions ready for payout. Approved rows always have a
    // NULL `processing_started_at` (acquireLock sets it on the way to
    // `processing`; retryable markFailed clears it on the way back to
    // `approved`). Stale processing rows remain fenced and are surfaced by
    // recoverStaleProcessing() instead of being selected here.
    const redemptions = await dbRead
      .select()
      .from(tokenRedemptions)
      .where(
        and(
          eq(tokenRedemptions.status, "approved"),
          isNull(tokenRedemptions.processing_started_at),
          lt(
            sql`CAST(${tokenRedemptions.retry_count} AS INTEGER)`,
            payoutConfig.MAX_RETRY_ATTEMPTS,
          ),
        ),
      )
      .limit(payoutConfig.BATCH_SIZE);

    for (const redemption of redemptions) {
      stats.processed++;
      const processingWorkerId = `${payoutConfig.WORKER_ID}:${crypto.randomUUID()}`;

      try {
        // Try to acquire lock
        const locked = await this.acquireLock(redemption.id, processingWorkerId);
        if (!locked) {
          stats.skipped++;
          continue;
        }

        // Isolate each redemption: a throw (RPC error, eviction, bug) must not
        // abort the rest of the batch, and must never silently re-broadcast.
        const result = await this.processRedemption(redemption, processingWorkerId);

        if (result.success) {
          await this.markCompleted(redemption, result.txHash!, processingWorkerId);
          stats.succeeded++;
        } else {
          await this.markFailed(
            redemption.id,
            result.error!,
            result.retryable ?? true,
            processingWorkerId,
          );
          stats.failed++;
        }
      } catch (error) {
        stats.failed++;
        await this.handleProcessingThrow(redemption.id, error, processingWorkerId);
      }
    }

    logger.info("[PayoutProcessor] Batch completed", stats);
    return stats;
  }

  /**
   * Surface stale processing leases without taking them over automatically.
   * A worker that exceeds the timeout may still resume, sign, and broadcast, so
   * neither a NULL broadcast hash nor an EVM account nonce proves that a
   * replacement worker can safely pay the same redemption. Operators must
   * reconcile the worker and chain state before changing the row.
   */
  private async recoverStaleProcessing(): Promise<void> {
    const config = getPayoutConfig();
    const staleThreshold = new Date(Date.now() - config.LOCK_TIMEOUT_MS);
    const stuck = await dbWrite
      .select({
        id: tokenRedemptions.id,
        network: tokenRedemptions.network,
        broadcast_tx_hash: tokenRedemptions.broadcast_tx_hash,
      })
      .from(tokenRedemptions)
      .where(
        and(
          eq(tokenRedemptions.status, "processing"),
          lt(tokenRedemptions.processing_started_at, staleThreshold),
        ),
      );

    if (stuck.length > 0) {
      logger.error(
        "[PayoutProcessor] Stale processing locks require worker and on-chain reconciliation (NOT auto-retried to avoid double-pay)",
        { count: stuck.length, redemptions: stuck },
      );
      await payoutAlertsService.sendAlert({
        severity: "high",
        title: "Payout processing lease stale",
        message: `${stuck.length} redemption(s) exceeded the processing timeout. Manual worker and on-chain reconciliation is required; they were intentionally left in processing and were not auto-retried.`,
        details: { redemptions: stuck },
      });
    }
  }

  /**
   * Handle a throw from processRedemption AFTER the lock was acquired.
   *
   * A throw can land either side of the broadcast. We re-read the row to decide:
   *  - A broadcast tx hash is present → a transaction may be in flight; resetting
   *    to `approved` would re-broadcast and double-pay. Leave it in `processing`
   *    (recorded with the failure reason) for on-chain reconciliation by
   *    recoverStaleProcessing()/operators.
   *  - No broadcast hash → nothing left our process; safe retryable failure.
   */
  private async handleProcessingThrow(
    redemptionId: string,
    error: unknown,
    processingWorkerId: string,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);

    const [row] = await dbRead
      .select({ broadcast_tx_hash: tokenRedemptions.broadcast_tx_hash })
      .from(tokenRedemptions)
      .where(eq(tokenRedemptions.id, redemptionId));

    if (row?.broadcast_tx_hash) {
      logger.error(
        "[PayoutProcessor] Redemption threw AFTER broadcast; leaving 'processing' for reconciliation (no auto-retry)",
        { redemptionId, broadcastTxHash: row.broadcast_tx_hash, reason },
      );
      await dbWrite
        .update(tokenRedemptions)
        .set({
          failure_reason: `Threw after broadcast (awaiting on-chain reconciliation): ${reason}`,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(tokenRedemptions.id, redemptionId),
            eq(tokenRedemptions.status, "processing"),
            eq(tokenRedemptions.processing_worker_id, processingWorkerId),
          ),
        );
      return;
    }

    logger.error("[PayoutProcessor] Redemption threw before broadcast; marking failed-retryable", {
      redemptionId,
      reason,
    });
    await this.markFailed(redemptionId, reason, true, processingWorkerId);
  }

  /**
   * Acquire processing lock on a redemption.
   */
  private async acquireLock(redemptionId: string, processingWorkerId: string): Promise<boolean> {
    const [updated] = await dbWrite
      .update(tokenRedemptions)
      .set({
        status: "processing",
        processing_started_at: new Date(),
        processing_worker_id: processingWorkerId,
        updated_at: new Date(),
      })
      .where(and(eq(tokenRedemptions.id, redemptionId), eq(tokenRedemptions.status, "approved")))
      .returning();

    return !!updated;
  }

  /**
   * Process a single redemption.
   */
  private async processRedemption(
    redemption: typeof tokenRedemptions.$inferSelect,
    processingWorkerId: string,
  ): Promise<PayoutResult> {
    const config = getPayoutConfig();
    const network = redemption.network as SupportedNetwork;

    // Defense in depth for already-approved or directly inserted rows: the
    // initial launch permits Base USDC only (#13100). Never execute a legacy
    // elizaOS, Solana, Ethereum, or BNB payout even if it bypassed request
    // validation.
    if (!isPayoutLaunchRail(network, redemption.asset)) {
      return {
        success: false,
        error: `Unsupported payout rail: launch permits ${PAYOUT_LAUNCH_ASSET.toUpperCase()} on ${PAYOUT_LAUNCH_NETWORK} only`,
        retryable: false,
      };
    }

    // Fail closed on a corrupt NUMERIC payout amount BEFORE anything is signed or
    // broadcast. A non-finite / empty `eliza_amount` otherwise coerces to a
    // zero-token transfer (parseUnits('')===0n, Number('')*1e9===0) that is
    // broadcast and marked `completed` with a real tx hash — fabricated success.
    // A corrupt row is not transient, so this is non-retryable (→ manual review).
    let payoutAmount: number;
    try {
      payoutAmount = parseRedemptionAmount("eliza_amount", redemption.eliza_amount);
    } catch (error) {
      logger.error("[PayoutProcessor] Corrupt eliza_amount; refusing payout", {
        redemptionId: redemption.id,
        network,
        rawElizaAmount: redemption.eliza_amount,
        reason: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: "Corrupt redemption amount (requires review)",
        retryable: false,
      };
    }
    if (payoutAmount <= 0) {
      // A zero/negative payout amount would broadcast a no-op transfer and mark
      // the redemption completed — same fabricated-success class. Refuse it.
      logger.error("[PayoutProcessor] Non-positive eliza_amount; refusing payout", {
        redemptionId: redemption.id,
        network,
        elizaAmount: payoutAmount,
      });
      return {
        success: false,
        error: "Non-positive redemption amount (requires review)",
        retryable: false,
      };
    }

    // Fail closed on a corrupt `usd_value` BEFORE broadcast. markCompleted (which
    // runs only AFTER a successful on-chain transfer) writes usd_value into the
    // earnings ledger via `total_pending - usd_value` / `total_redeemed +
    // usd_value` SQL and a `$${Number(usd_value).toFixed(2)}` description; a
    // corrupt value would poison the ledger balances (`- 'NaN'`) or log `$NaN`.
    // Catch it here so a corrupt row is reviewed, never broadcast then
    // half-recorded post-broadcast (tokens sent, accounting corrupt).
    try {
      parseRedemptionAmount("usd_value", redemption.usd_value);
    } catch (error) {
      logger.error("[PayoutProcessor] Corrupt usd_value; refusing payout", {
        redemptionId: redemption.id,
        network,
        rawUsdValue: redemption.usd_value,
        reason: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: "Corrupt redemption USD value (requires review)",
        retryable: false,
      };
    }

    if (config.ENFORCE_PRICE_VALIDATION) {
      // Optional compatibility guard for fully automated payout deployments.
      if (new Date() > redemption.price_quote_expires_at) {
        return {
          success: false,
          error: "Price quote expired",
          retryable: false,
        };
      }

      // Fail closed on a corrupt quoted price. A non-finite `eliza_price_usd`
      // makes the slippage guard `NaN > MAX === false` → fail open, authorizing
      // a payout against an unvalidatable quote. Refuse (non-retryable) instead.
      let quotedPriceUsd: number;
      try {
        quotedPriceUsd = parseRedemptionAmount("eliza_price_usd", redemption.eliza_price_usd);
      } catch (error) {
        logger.error("[PayoutProcessor] Corrupt eliza_price_usd; refusing payout", {
          redemptionId: redemption.id,
          network,
          rawElizaPriceUsd: redemption.eliza_price_usd,
          reason: error instanceof Error ? error.message : String(error),
        });
        return {
          success: false,
          error: "Corrupt quoted price (requires review)",
          retryable: false,
        };
      }
      if (quotedPriceUsd <= 0) {
        // A zero quoted price makes slippage `|current-0|/0 === Infinity`, an
        // accidental divide-by-zero-shaped rejection rather than an intentional
        // policy signal. Refuse explicitly so the reason is a corrupt quote.
        logger.error("[PayoutProcessor] Non-positive eliza_price_usd; refusing payout", {
          redemptionId: redemption.id,
          network,
          quotedPriceUsd,
        });
        return {
          success: false,
          error: "Non-positive quoted price (requires review)",
          retryable: false,
        };
      }

      const priceValidation = await this.validatePrice(network, quotedPriceUsd);
      if (!priceValidation.valid) {
        return {
          success: false,
          error: priceValidation.error,
          retryable: false,
        };
      }
    } else if (new Date() > redemption.price_quote_expires_at) {
      logger.info("[PayoutProcessor] Processing redemption with expired quote window", {
        redemptionId: redemption.id,
        network,
        quotedElizaAmount: redemption.eliza_amount,
        quotedPriceUsd: redemption.eliza_price_usd,
        quoteExpiredAt: redemption.price_quote_expires_at,
      });
    }

    // Execute payout based on network
    if (network === "solana") {
      return await this.executeSolanaPayout(redemption, processingWorkerId);
    } else {
      return await this.executeEvmPayout(redemption, network, processingWorkerId);
    }
  }

  /**
   * Validate current price against quoted price.
   */
  private async validatePrice(
    network: SupportedNetwork,
    quotedPrice: number,
  ): Promise<{ valid: boolean; error?: string }> {
    const { quote } = await elizaTokenPriceService.getQuote(network, 100);
    const currentPrice = quote.priceUsd;

    const slippage = Math.abs(currentPrice - quotedPrice) / quotedPrice;
    const config = getPayoutConfig();

    if (slippage > config.MAX_PRICE_SLIPPAGE) {
      return {
        valid: false,
        error: `Price moved ${(slippage * 100).toFixed(2)}% since quote (max ${config.MAX_PRICE_SLIPPAGE * 100}%)`,
      };
    }

    return { valid: true };
  }

  /**
   * Execute EVM token transfer.
   */
  private async executeEvmPayout(
    redemption: typeof tokenRedemptions.$inferSelect,
    network: SupportedNetwork,
    processingWorkerId: string,
  ): Promise<PayoutResult> {
    if (!this.evmPrivateKey) {
      return {
        success: false,
        error: "EVM payout not configured",
        retryable: false,
      };
    }

    const chain = payoutEvmChain(network as EvmPayoutNetwork);
    if (!chain) {
      return {
        success: false,
        error: `Unsupported EVM network: ${network}`,
        retryable: false,
      };
    }

    // Asset-aware (#10732): USDC (6 decimals) or the compatibility elizaOS token (9).
    // `eliza_amount` holds the payout-token amount in either case.
    const tokenConfig = getPayoutTokenConfig(network, redemption.asset);
    const tokenAddress = tokenConfig.address as Address;
    const toAddress = redemption.payout_address as Address;
    // Fail-closed parse: viem `parseUnits('', d) === 0n` would build a zero-token
    // transfer that broadcasts + marks completed with a real tx hash (fabricated
    // success). processRedemption already gates this, but re-validate here so a
    // direct call can never silently pay out nothing; parseUnits then does the
    // precise decimal-string conversion from the (now known-finite) value.
    parseRedemptionAmount("eliza_amount", redemption.eliza_amount);
    const amount = parseUnits(redemption.eliza_amount.toString(), tokenConfig.decimals);

    const account = privateKeyToAccount(this.evmPrivateKey);

    const { url: rpcUrl } = resolvePayoutEvmRpc(network as EvmPayoutNetwork);
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });

    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    });

    // Check hot wallet balance
    const balance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    });

    if (balance < amount) {
      logger.error("[PayoutProcessor] Insufficient hot wallet balance", {
        network,
        required: amount.toString(),
        available: balance.toString(),
      });
      return {
        success: false,
        error: "Insufficient hot wallet balance - contact support",
        retryable: true, // Retry after refilling
      };
    }

    // Sign the transfer LOCALLY first so its hash is known BEFORE it is
    // broadcast, then persist that hash BEFORE the raw send. This closes the
    // residual double-pay window (#10588): the previous flow used
    // `writeContract`, which broadcasts the tx and only THEN returns the hash, so
    // a worker death in the gap between the broadcast and the recordBroadcast
    // commit left a NULL-hash row that recovery re-approved → re-broadcast →
    // double-pay. With sign → record → send, a NULL `broadcast_tx_hash` provably
    // means the tx was never submitted (safe to re-approve), and anything from
    // the send onward leaves the hash set (reconciled, never re-broadcast). The
    // nonce is pinned by prepareTransactionRequest, so the recorded hash is the
    // exact — and only — transaction that can reach the chain.
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [toAddress, amount],
    });
    const preparedRequest = await walletClient.prepareTransactionRequest({
      account,
      to: tokenAddress,
      data,
      chain,
    });
    const serializedTransaction = await walletClient.signTransaction(
      preparedRequest as Parameters<typeof walletClient.signTransaction>[0],
    );
    const txHash = keccak256(serializedTransaction);

    // Persist BEFORE broadcasting. A crash before this commit means the tx was
    // never sent (sendRawTransaction is below) → recovery safely re-approves.
    await this.recordBroadcast(redemption.id, txHash, processingWorkerId);

    // Broadcast the pre-signed transaction. A throw here routes through
    // handleProcessingThrow, which sees the persisted hash and reconciles rather
    // than re-broadcasting.
    await walletClient.sendRawTransaction({ serializedTransaction });

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 2,
    });

    if (receipt.status === "reverted") {
      return {
        success: false,
        error: "Transaction reverted",
        retryable: true,
      };
    }

    logger.info("[PayoutProcessor] EVM payout completed", {
      redemptionId: redemption.id,
      network,
      txHash,
      amount: redemption.eliza_amount,
      toAddress,
    });

    return { success: true, txHash };
  }

  /**
   * Execute Solana SPL token transfer.
   */
  private async executeSolanaPayout(
    redemption: typeof tokenRedemptions.$inferSelect,
    processingWorkerId: string,
  ): Promise<PayoutResult> {
    if (!this.solanaKeypair || !this.solanaConnection) {
      return {
        success: false,
        error: "Solana payout not configured",
        retryable: false,
      };
    }

    const { PublicKey, Transaction } =
      require("@solana/web3.js") as typeof import("@solana/web3.js");
    const {
      createTransferInstruction,
      getAssociatedTokenAddress,
      createAssociatedTokenAccountInstruction,
      getAccount,
      TokenAccountNotFoundError,
    } = require("@solana/spl-token") as typeof import("@solana/spl-token");
    // Asset-aware (#10732): USDC SPL mint (6 decimals) or the compatibility elizaOS mint (9).
    const tokenConfig = getPayoutTokenConfig("solana", redemption.asset);
    const mintAddress = new PublicKey(tokenConfig.address);
    const toAddress = new PublicKey(redemption.payout_address);
    // Fail-closed parse: bare Number('') === 0 would build a zero-token transfer
    // that broadcasts + marks completed with a real signature (fabricated
    // success). processRedemption already gates this, but re-validate here so a
    // direct call can never silently pay out nothing.
    const amount = BigInt(
      Math.floor(
        parseRedemptionAmount("eliza_amount", redemption.eliza_amount) * 10 ** tokenConfig.decimals,
      ),
    );

    // Get source token account (hot wallet's ATA)
    const sourceAta = await getAssociatedTokenAddress(mintAddress, this.solanaKeypair.publicKey);
    let sourceAccount;
    try {
      sourceAccount = await getAccount(this.solanaConnection, sourceAta);
    } catch (error) {
      if (error instanceof TokenAccountNotFoundError) {
        logger.error("[PayoutProcessor] Source token account not found", {
          redemptionId: redemption.id,
          asset: redemption.asset,
          mint: tokenConfig.address,
          sourceAta: sourceAta.toBase58(),
        });
        return {
          success: false,
          error: "Source token account not configured - contact support",
          retryable: true,
        };
      }
      throw error;
    }
    if (sourceAccount.amount < amount) {
      logger.error("[PayoutProcessor] Insufficient Solana hot wallet balance", {
        redemptionId: redemption.id,
        asset: redemption.asset,
        required: amount.toString(),
        available: sourceAccount.amount.toString(),
      });
      return {
        success: false,
        error: "Insufficient hot wallet balance - contact support",
        retryable: true,
      };
    }

    // Get or create destination token account
    const destinationAta = await getAssociatedTokenAddress(mintAddress, toAddress);

    const transaction = new Transaction();

    // Check if destination ATA exists
    let destinationExists = false;
    try {
      await getAccount(this.solanaConnection, destinationAta);
      destinationExists = true;
    } catch (error) {
      if (!(error instanceof TokenAccountNotFoundError)) {
        throw error;
      }
    }

    // Create ATA if it doesn't exist
    if (!destinationExists) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          this.solanaKeypair.publicKey,
          destinationAta,
          toAddress,
          mintAddress,
        ),
      );
    }

    // Add transfer instruction
    transaction.add(
      createTransferInstruction(sourceAta, destinationAta, this.solanaKeypair.publicKey, amount),
    );

    // Set fee payer + a recent blockhash so the transaction can be signed and
    // serialized for a raw broadcast — we need the signature in hand BEFORE
    // confirmation so the broadcast hash can be persisted first.
    const { blockhash, lastValidBlockHeight } =
      await this.solanaConnection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = this.solanaKeypair.publicKey;
    transaction.sign(this.solanaKeypair);

    // The signature (= the txid) is deterministic the INSTANT the transaction is
    // signed — before it is sent — so persist it BEFORE the raw broadcast, the
    // same as the EVM sign→record→send order (#10588). The previous flow sent
    // first and recorded after, leaving the identical broadcast→persist window: a
    // crash in that gap left a NULL-hash row that recovery re-approved and
    // re-broadcast → double-pay. A recorded broadcast hash means recovery must
    // never re-broadcast (no double-pay); an expired blockhash / eviction during
    // confirmation throws into processBatch's try/catch, which leaves the
    // broadcast row in 'processing' for on-chain reconciliation.
    const serializedTransaction = transaction.serialize();
    const signatureBytes = transaction.signature;
    if (!signatureBytes) {
      // Signing did not populate a signature — nothing was broadcast, safe to retry.
      return {
        success: false,
        error: "Solana transaction has no signature after signing",
        retryable: true,
      };
    }
    const signature = bs58.encode(signatureBytes);
    await this.recordBroadcast(redemption.id, signature, processingWorkerId);

    await this.solanaConnection.sendRawTransaction(serializedTransaction);

    const confirmation = await this.solanaConnection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (confirmation.value.err) {
      // The transaction landed but failed atomically — no SPL transfer executed,
      // so it is safe to retry (markFailed clears the broadcast hash).
      return {
        success: false,
        error: `Solana transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`,
        retryable: true,
      };
    }

    logger.info("[PayoutProcessor] Solana payout completed", {
      redemptionId: redemption.id,
      signature,
      amount: redemption.eliza_amount,
      toAddress: redemption.payout_address,
    });

    return { success: true, txHash: signature };
  }

  /**
   * Mark redemption as completed.
   */
  private async markCompleted(
    redemption: typeof tokenRedemptions.$inferSelect,
    txHash: string,
    processingWorkerId: string,
  ): Promise<void> {
    const completedAt = new Date();
    const usdValue = redemption.usd_value.toString();
    // Proven finite pre-broadcast in processRedemption; parse fail-closed here
    // too so a direct call can never write a $NaN ledger description.
    const usdNumber = parseRedemptionAmount("usd_value", redemption.usd_value);

    await dbWrite.transaction(async (tx) => {
      const [completedRedemption] = await tx
        .update(tokenRedemptions)
        .set({
          status: "completed",
          tx_hash: txHash,
          completed_at: completedAt,
          updated_at: completedAt,
        })
        .where(
          and(
            eq(tokenRedemptions.id, redemption.id),
            eq(tokenRedemptions.status, "processing"),
            eq(tokenRedemptions.processing_worker_id, processingWorkerId),
            eq(tokenRedemptions.broadcast_tx_hash, txHash),
          ),
        )
        .returning({ id: tokenRedemptions.id });

      if (!completedRedemption) {
        throw new Error("Payout processing lease lost before completion");
      }

      const [updatedEarnings] = await tx
        .update(redeemableEarnings)
        .set({
          total_pending: sql`GREATEST(0, ${redeemableEarnings.total_pending} - ${usdValue})`,
          total_redeemed: sql`${redeemableEarnings.total_redeemed} + ${usdValue}`,
          last_redemption_at: completedAt,
          version: sql`${redeemableEarnings.version} + 1`,
          updated_at: completedAt,
        })
        .where(eq(redeemableEarnings.user_id, redemption.user_id))
        .returning();

      if (!updatedEarnings) {
        throw new Error("Earnings record not found for completed redemption");
      }

      await tx.insert(redeemableEarningsLedger).values({
        user_id: redemption.user_id,
        entry_type: "redemption",
        amount: "0",
        balance_after: updatedEarnings.available_balance,
        redemption_id: redemption.id,
        description: `Redemption completed: $${usdNumber.toFixed(2)} sent as elizaOS`,
        metadata: {
          completed_at: completedAt.toISOString(),
          network: redemption.network,
          tx_hash: txHash,
        },
      });
    });
  }

  /**
   * Persist the broadcast transaction hash the moment a payout is broadcast,
   * before waiting for confirmation. This is the recovery signal: a `processing`
   * row with a recorded broadcast hash must never be re-broadcast.
   */
  private async recordBroadcast(
    redemptionId: string,
    broadcastTxHash: string,
    processingWorkerId: string,
  ): Promise<void> {
    const [updated] = await dbWrite
      .update(tokenRedemptions)
      .set({
        broadcast_tx_hash: broadcastTxHash,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(tokenRedemptions.id, redemptionId),
          eq(tokenRedemptions.status, "processing"),
          eq(tokenRedemptions.processing_worker_id, processingWorkerId),
          isNull(tokenRedemptions.broadcast_tx_hash),
        ),
      )
      .returning({ id: tokenRedemptions.id });

    if (!updated) {
      throw new Error("Payout processing lease lost before broadcast");
    }
  }

  /**
   * Mark redemption as failed.
   */
  private async markFailed(
    redemptionId: string,
    reason: string,
    retryable: boolean,
    processingWorkerId: string,
  ): Promise<void> {
    if (retryable) {
      const config = getPayoutConfig();
      const retryableRows = await dbWrite
        .update(tokenRedemptions)
        .set({
          status: "approved", // Reset to approved for retry
          failure_reason: reason,
          retry_count: sql`${tokenRedemptions.retry_count} + 1`,
          processing_started_at: null,
          processing_worker_id: null,
          broadcast_tx_hash: null,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(tokenRedemptions.id, redemptionId),
            eq(tokenRedemptions.status, "processing"),
            eq(tokenRedemptions.processing_worker_id, processingWorkerId),
            lt(
              sql`CAST(${tokenRedemptions.retry_count} AS INTEGER)`,
              config.MAX_RETRY_ATTEMPTS - 1,
            ),
          ),
        )
        .returning({ id: tokenRedemptions.id });

      if (retryableRows.length === 0) {
        const failedRows = await dbWrite
          .update(tokenRedemptions)
          .set({
            status: "failed",
            failure_reason: `Retry attempts exhausted: ${reason}`,
            retry_count: sql`LEAST(CAST(${tokenRedemptions.retry_count} AS INTEGER) + 1, ${config.MAX_RETRY_ATTEMPTS})`,
            requires_review: true,
            processing_started_at: null,
            processing_worker_id: null,
            broadcast_tx_hash: null,
            updated_at: new Date(),
          })
          .where(
            and(
              eq(tokenRedemptions.id, redemptionId),
              eq(tokenRedemptions.status, "processing"),
              eq(tokenRedemptions.processing_worker_id, processingWorkerId),
            ),
          )
          .returning({ id: tokenRedemptions.id });

        if (failedRows.length > 0) {
          await payoutAlertsService.sendAlert({
            severity: "high",
            title: "Payout retries exhausted",
            message:
              "A retryable payout failure reached MAX_RETRY_ATTEMPTS and was marked failed for manual review instead of being orphaned in approved.",
            details: { redemptionId, reason },
          });
          // Retryable failures never sent tokens (this branch even cleared
          // broadcast_tx_hash), so return the locked earnings to the user.
          await this.refundStrandedRedemption(redemptionId, `Payout retries exhausted: ${reason}`);
        }
      }
    } else {
      // Mark as failed (requires manual intervention). Guard on status
      // 'processing' + RETURNING so the transition (and the refund below) happens
      // exactly once, even if this is called twice for the same row.
      const failedRows = await dbWrite
        .update(tokenRedemptions)
        .set({
          status: "failed",
          failure_reason: reason,
          requires_review: true,
          processing_started_at: null,
          processing_worker_id: null,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(tokenRedemptions.id, redemptionId),
            eq(tokenRedemptions.status, "processing"),
            eq(tokenRedemptions.processing_worker_id, processingWorkerId),
          ),
        )
        .returning({ id: tokenRedemptions.id });

      if (failedRows.length > 0) {
        // Non-retryable failures are terminal validation errors that occur
        // before any transfer is broadcast; refundStrandedRedemption additionally
        // guards on broadcast_tx_hash IS NULL, so a (future) post-broadcast
        // non-retryable error is left for reconciliation, never refunded.
        await this.refundStrandedRedemption(redemptionId, `Payout failed: ${reason}`);
      }
    }

    logger.error("[PayoutProcessor] Payout failed", {
      redemptionId,
      reason,
      retryable,
    });
  }

  /**
   * Return a permanently-failed redemption's locked USD from `total_pending`
   * back to the user's `available_balance` (#10059-adjacent earnings-stranding
   * fix). Requesting a redemption locks the earnings (available -= usd,
   * total_pending += usd); markCompleted moves that to total_redeemed on success.
   * A redemption that ends `failed` (retries exhausted / non-retryable / stale
   * Solana) previously left the USD stuck in total_pending forever —
   * rejectRedemption only refunds `pending` rows, and refundRedemption had no
   * callers — so the creator could neither receive tokens nor re-access those
   * earnings without a manual DB fix.
   *
   * SAFETY: only refund a row that is `failed` AND provably never broadcast a
   * transfer (`broadcast_tx_hash IS NULL`). A row that may have broadcast is left
   * for on-chain reconciliation — refunding it while tokens are/were in flight
   * would be a reverse double-pay. IDEMPOTENT: skips if a refund ledger entry for
   * this redemption already exists. Never throws (the row is requires_review) so
   * a refund hiccup can't crash the batch or un-fail the redemption.
   */
  private async refundStrandedRedemption(redemptionId: string, reason: string): Promise<void> {
    try {
      const [row] = await dbRead
        .select({
          userId: tokenRedemptions.user_id,
          usdValue: tokenRedemptions.usd_value,
          status: tokenRedemptions.status,
          broadcastTxHash: tokenRedemptions.broadcast_tx_hash,
        })
        .from(tokenRedemptions)
        .where(eq(tokenRedemptions.id, redemptionId))
        .limit(1);

      // Only refund a terminally-failed, provably-un-broadcast redemption.
      if (!row || row.status !== "failed" || row.broadcastTxHash) return;

      // Idempotency: never refund the same redemption twice.
      const [existingRefund] = await dbRead
        .select({ id: redeemableEarningsLedger.id })
        .from(redeemableEarningsLedger)
        .where(
          and(
            eq(redeemableEarningsLedger.redemption_id, redemptionId),
            eq(redeemableEarningsLedger.entry_type, "refund"),
          ),
        )
        .limit(1);
      if (existingRefund) return;

      let refundAmount: number;
      try {
        refundAmount = parseRedemptionAmount("usd_value", row.usdValue);
      } catch (error) {
        logger.error(
          "[PayoutProcessor] Corrupt usd_value on failed redemption; skipping automatic refund",
          {
            redemptionId,
            rawUsdValue: row.usdValue,
            reason: error instanceof Error ? error.message : String(error),
          },
        );
        return;
      }

      await redeemableEarningsService.refundRedemption({
        userId: row.userId,
        redemptionId,
        amount: refundAmount,
        reason,
      });

      logger.info("[PayoutProcessor] Refunded stranded earnings for failed redemption", {
        redemptionId,
        amount: row.usdValue,
        reason,
      });
    } catch (error) {
      logger.error("[PayoutProcessor] Failed to refund stranded redemption earnings", {
        redemptionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check hot wallet balances and alert if low.
   * Returns status for monitoring.
   */
  async checkHotWalletBalances(): Promise<{
    evm: { configured: boolean; balances: Record<string, number> };
    solana: { configured: boolean; balance: number };
  }> {
    const config = getPayoutConfig();
    const result = {
      evm: {
        configured: !!this.evmPrivateKey,
        balances: {} as Record<string, number>,
      },
      solana: { configured: !!this.solanaKeypair, balance: 0 },
    };

    // Check EVM wallets
    if (this.evmPrivateKey) {
      const account = privateKeyToAccount(this.evmPrivateKey);
      const monitoringAsset = getMonitoringPayoutAsset();

      for (const network of listEvmPayoutNetworks()) {
        // The token whose balance we monitor must match the asset actually being
        // paid out, and the chain + RPC must match the environment. Before this,
        // the monitor read ELIZA_TOKEN_ADDRESSES against the mainnet chain even in
        // staging (where payouts resolve testnet USDC), so operational health
        // advertised a different asset and network than the payout rail.
        const tokenConfig = getPayoutTokenConfig(network as SupportedNetwork, monitoringAsset);
        const tokenAddress = tokenConfig.address as Address;
        const chain = payoutEvmChain(network);
        const decimals = tokenConfig.decimals;

        const { url: rpcUrl } = resolvePayoutEvmRpc(network);
        const publicClient = createPublicClient({
          chain,
          transport: http(rpcUrl),
        });

        const balance = await publicClient.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        });

        const balanceFormatted = Number(balance) / 10 ** decimals;
        result.evm.balances[network] = balanceFormatted;

        if (balanceFormatted < config.MIN_HOT_WALLET_BALANCE) {
          logger.warn("[PayoutProcessor] LOW HOT WALLET BALANCE", {
            network,
            asset: monitoringAsset,
            balance: balanceFormatted,
            threshold: config.MIN_HOT_WALLET_BALANCE,
            address: account.address,
          });
          // Send alert to ops team
          void payoutAlertsService.alertLowBalance(
            network,
            balanceFormatted,
            config.MIN_HOT_WALLET_BALANCE,
          );
        }
      }
    } else {
      logger.info("[PayoutProcessor] EVM wallet not configured - skipping EVM balance check");
    }

    // Check Solana wallet
    if (this.solanaKeypair && this.solanaConnection) {
      const { PublicKey } = require("@solana/web3.js") as typeof import("@solana/web3.js");
      const { getAssociatedTokenAddress, getAccount } =
        require("@solana/spl-token") as typeof import("@solana/spl-token");
      // Asset-aware (#13100): monitor the asset being paid out, not the legacy
      // elizaOS mint. Solana payouts are deferred until Base USDC is proven, but
      // if Solana is configured the monitor must read the same rail.
      const monitoringAsset = getMonitoringPayoutAsset();
      const tokenConfig = getPayoutTokenConfig("solana", monitoringAsset);
      const mintAddress = new PublicKey(tokenConfig.address);
      const ata = await getAssociatedTokenAddress(mintAddress, this.solanaKeypair.publicKey);

      const account = await getAccount(this.solanaConnection, ata).catch(() => null);

      if (!account) {
        logger.warn("[PayoutProcessor] Solana token account not found", {
          asset: monitoringAsset,
          wallet: this.solanaKeypair.publicKey.toBase58(),
        });
        result.solana.balance = 0;
      } else {
        const balanceFormatted = Number(account.amount) / 10 ** tokenConfig.decimals;
        result.solana.balance = balanceFormatted;

        if (balanceFormatted < config.MIN_HOT_WALLET_BALANCE) {
          logger.warn("[PayoutProcessor] LOW HOT WALLET BALANCE", {
            network: "solana",
            asset: monitoringAsset,
            balance: balanceFormatted,
            threshold: config.MIN_HOT_WALLET_BALANCE,
            address: this.solanaKeypair.publicKey.toBase58(),
          });
          // Send alert to ops team
          void payoutAlertsService.alertLowBalance(
            "solana",
            balanceFormatted,
            config.MIN_HOT_WALLET_BALANCE,
          );
        }
      }
    } else {
      logger.info("[PayoutProcessor] Solana wallet not configured - skipping Solana balance check");
    }

    return result;
  }
}

let payoutProcessorServiceInstance: PayoutProcessorService | null = null;

function getPayoutProcessorService() {
  if (!payoutProcessorServiceInstance) {
    payoutProcessorServiceInstance = new PayoutProcessorService();
  }

  return payoutProcessorServiceInstance;
}

// Export a lazy singleton proxy so invalid config does not break module evaluation.
export const payoutProcessorService = new Proxy({} as PayoutProcessorService, {
  get(_target, property) {
    const service = getPayoutProcessorService();
    const value = Reflect.get(service, property, service);
    return typeof value === "function" ? value.bind(service) : value;
  },
});
