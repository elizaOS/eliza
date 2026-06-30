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
 * - Failed transactions are marked as "failed" with reason
 * - Automatic retry up to MAX_RETRY_ATTEMPTS
 * - Manual intervention required after max retries
 * - Balance is NOT auto-refunded on failure (requires admin review)
 *
 * ============================================================================
 */

import bs58 from "bs58";
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { type Address, createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { dbRead, dbWrite } from "../../db/client";
import { redeemableEarnings, redeemableEarningsLedger } from "../../db/schemas/redeemable-earnings";
import { tokenRedemptions } from "../../db/schemas/token-redemptions";
import { type EvmPayoutNetwork, resolveEvmRpc } from "../config/evm-rpc";
import { ELIZA_DECIMALS, ERC20_ABI, EVM_CHAINS } from "../config/token-constants";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import {
  ELIZA_TOKEN_ADDRESSES,
  elizaTokenPriceService,
  type SupportedNetwork,
} from "./eliza-token-price";
import { payoutAlertsService } from "./payout-alerts";

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
    // `processing`; markFailed/recovery clear it on the way back to `approved`),
    // so stale-lock recovery is handled exclusively by recoverStaleProcessing()
    // above — there is no stale-lock branch to express here.
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

      try {
        // Try to acquire lock
        const locked = await this.acquireLock(redemption.id);
        if (!locked) {
          stats.skipped++;
          continue;
        }

        // Isolate each redemption: a throw (RPC error, eviction, bug) must not
        // abort the rest of the batch, and must never silently re-broadcast.
        const result = await this.processRedemption(redemption);

        if (result.success) {
          await this.markCompleted(redemption, result.txHash!);
          stats.succeeded++;
        } else {
          await this.markFailed(redemption.id, result.error!, result.retryable ?? true);
          stats.failed++;
        }
      } catch (error) {
        stats.failed++;
        await this.handleProcessingThrow(redemption.id, error);
      }
    }

    logger.info("[PayoutProcessor] Batch completed", stats);
    return stats;
  }

  /**
   * Recover redemptions stuck in `processing` past the lock timeout.
   *
   * Splits stuck rows by what is PROVABLY known about their on-chain state:
   *
   *  - No broadcast tx hash recorded → the payout never left this process. Safe
   *    to return to `approved` and retry, bounded by MAX_RETRY_ATTEMPTS.
   *  - No broadcast hash but retries exhausted → fail for manual intervention
   *    (mirrors the non-retryable markFailed path; never silently re-tried).
   *  - A broadcast hash IS recorded → a transaction may already be confirmed
   *    on-chain. Re-approving would re-broadcast and double-pay, so these are
   *    LEFT in `processing` and surfaced for on-chain reconciliation. This is
   *    the safety floor: recovery never auto re-broadcasts a broadcast payout.
   */
  private async recoverStaleProcessing(): Promise<void> {
    const config = getPayoutConfig();
    const staleThreshold = new Date(Date.now() - config.LOCK_TIMEOUT_MS);

    // (1) No broadcast hash recorded → do NOT auto-retry. A null broadcast hash
    // usually means the worker died before broadcasting, but it can ALSO mean it
    // died in the window between the transaction being broadcast (writeContract /
    // sendRawTransaction returning) and the hash being persisted by
    // recordBroadcast. Re-approving such a row would re-broadcast and DOUBLE-PAY
    // (#10588). Because we cannot prove it never broadcast, surface it for human /
    // on-chain review instead of auto-retrying — the same fail-safe posture
    // already applied to broadcast-but-unconfirmed rows in (2).
    const escalated = await dbWrite
      .update(tokenRedemptions)
      .set({
        status: "failed",
        failure_reason:
          "Stale processing lock with no recorded broadcast — a payout may have been broadcast before the worker died; verify on-chain before resolving (not auto-retried to avoid double-pay)",
        requires_review: true,
        processing_started_at: null,
        processing_worker_id: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(tokenRedemptions.status, "processing"),
          lt(tokenRedemptions.processing_started_at, staleThreshold),
          isNull(tokenRedemptions.broadcast_tx_hash),
        ),
      )
      .returning({ id: tokenRedemptions.id });

    // (2) Broadcast-but-unconfirmed → NEVER re-approve. Surface for reconciliation.
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
          isNotNull(tokenRedemptions.broadcast_tx_hash),
        ),
      );

    if (escalated.length > 0) {
      logger.error(
        "[PayoutProcessor] Stale processing locks with no recorded broadcast escalated for review (NOT auto-retried to avoid double-pay)",
        { count: escalated.length, redemptionIds: escalated.map((r) => r.id) },
      );
      void payoutAlertsService.sendAlert({
        severity: "high",
        title: "Payout stuck — stale lock, no recorded broadcast",
        message: `${escalated.length} redemption(s) held a processing lock past the timeout with no recorded broadcast hash. They are NOT auto-retried — a transaction may have been broadcast before the worker died. Verify on-chain and resolve manually.`,
        details: { redemptionIds: escalated.map((r) => r.id) },
      });
    }
    if (stuck.length > 0) {
      logger.error(
        "[PayoutProcessor] Stale processing locks with a broadcast tx require on-chain reconciliation (NOT auto-retried to avoid double-pay)",
        { count: stuck.length, redemptions: stuck },
      );
      void payoutAlertsService.sendAlert({
        severity: "high",
        title: "Payout stuck after broadcast",
        message: `${stuck.length} redemption(s) broadcast a transaction but never confirmed. Manual on-chain reconciliation required — these are intentionally NOT auto-retried to avoid double-paying.`,
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
  private async handleProcessingThrow(redemptionId: string, error: unknown): Promise<void> {
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
        .where(eq(tokenRedemptions.id, redemptionId));
      return;
    }

    logger.error("[PayoutProcessor] Redemption threw before broadcast; marking failed-retryable", {
      redemptionId,
      reason,
    });
    await this.markFailed(redemptionId, reason, true);
  }

  /**
   * Acquire processing lock on a redemption.
   */
  private async acquireLock(redemptionId: string): Promise<boolean> {
    const config = getPayoutConfig();
    const [updated] = await dbWrite
      .update(tokenRedemptions)
      .set({
        status: "processing",
        processing_started_at: new Date(),
        processing_worker_id: config.WORKER_ID,
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
  ): Promise<PayoutResult> {
    const config = getPayoutConfig();
    const network = redemption.network as SupportedNetwork;

    if (config.ENFORCE_PRICE_VALIDATION) {
      // Optional legacy guard for fully automated payout deployments.
      if (new Date() > redemption.price_quote_expires_at) {
        return {
          success: false,
          error: "Price quote expired",
          retryable: false,
        };
      }

      const priceValidation = await this.validatePrice(network, Number(redemption.eliza_price_usd));
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
      return await this.executeSolanaPayout(redemption);
    } else {
      return await this.executeEvmPayout(redemption, network);
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
  ): Promise<PayoutResult> {
    if (!this.evmPrivateKey) {
      return {
        success: false,
        error: "EVM payout not configured",
        retryable: false,
      };
    }

    const chain = EVM_CHAINS[network];
    if (!chain) {
      return {
        success: false,
        error: `Unsupported EVM network: ${network}`,
        retryable: false,
      };
    }

    const tokenAddress = ELIZA_TOKEN_ADDRESSES[network] as Address;
    const toAddress = redemption.payout_address as Address;
    const amount = parseUnits(
      redemption.eliza_amount.toString(),
      ELIZA_DECIMALS[network as keyof typeof ELIZA_DECIMALS],
    );

    const account = privateKeyToAccount(this.evmPrivateKey);

    const { url: rpcUrl } = resolveEvmRpc(network as EvmPayoutNetwork);
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

    // Execute transfer
    const txHash = await walletClient.writeContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [toAddress, amount],
    });

    // Persist the broadcast hash the INSTANT it is known — before waiting for
    // confirmation. If this worker dies during the confirmation wait, recovery
    // sees a non-NULL broadcast hash and will NOT re-approve (no double-pay);
    // the redemption is reconciled on-chain instead.
    await this.recordBroadcast(redemption.id, txHash);

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
    const mintAddress = new PublicKey(ELIZA_TOKEN_ADDRESSES.solana);
    const toAddress = new PublicKey(redemption.payout_address);
    const amount = BigInt(
      Math.floor(Number(redemption.eliza_amount) * 10 ** ELIZA_DECIMALS.solana),
    );

    // Get source token account (hot wallet's ATA)
    const sourceAta = await getAssociatedTokenAddress(mintAddress, this.solanaKeypair.publicKey);

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

    // Broadcast, then persist the signature BEFORE confirming — the same
    // crash-recovery invariant as the EVM path. A recorded broadcast hash means
    // recovery must never re-broadcast this payout (no double-pay); an expired
    // blockhash / eviction during confirmation throws into processBatch's
    // try/catch, which leaves the broadcast row in 'processing' for on-chain
    // reconciliation rather than re-approving it.
    const signature = await this.solanaConnection.sendRawTransaction(transaction.serialize());
    await this.recordBroadcast(redemption.id, signature);

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
  ): Promise<void> {
    const completedAt = new Date();
    const usdValue = redemption.usd_value.toString();
    const usdNumber = Number(redemption.usd_value);

    await dbWrite.transaction(async (tx) => {
      await tx
        .update(tokenRedemptions)
        .set({
          status: "completed",
          tx_hash: txHash,
          completed_at: completedAt,
          updated_at: completedAt,
        })
        .where(eq(tokenRedemptions.id, redemption.id));

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
  private async recordBroadcast(redemptionId: string, broadcastTxHash: string): Promise<void> {
    await dbWrite
      .update(tokenRedemptions)
      .set({
        broadcast_tx_hash: broadcastTxHash,
        updated_at: new Date(),
      })
      .where(eq(tokenRedemptions.id, redemptionId));
  }

  /**
   * Mark redemption as failed.
   */
  private async markFailed(
    redemptionId: string,
    reason: string,
    retryable: boolean,
  ): Promise<void> {
    if (retryable) {
      // Increment retry count and reset to approved for retry. Clear the
      // broadcast hash: a retryable failure only ever reaches here when nothing
      // was transferred (pre-broadcast failure, on-chain revert, or atomic
      // Solana failure), so the next attempt starts from a clean
      // "never broadcast" state and recovery treats it as safe again.
      await dbWrite
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
        .where(eq(tokenRedemptions.id, redemptionId));
    } else {
      // Mark as failed (requires manual intervention)
      await dbWrite
        .update(tokenRedemptions)
        .set({
          status: "failed",
          failure_reason: reason,
          updated_at: new Date(),
        })
        .where(eq(tokenRedemptions.id, redemptionId));
    }

    logger.error("[PayoutProcessor] Payout failed", {
      redemptionId,
      reason,
      retryable,
    });
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

      for (const [network, chain] of Object.entries(EVM_CHAINS)) {
        const tokenAddress = ELIZA_TOKEN_ADDRESSES[network as SupportedNetwork] as Address;

        const { url: rpcUrl } = resolveEvmRpc(network as EvmPayoutNetwork);
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

        const balanceFormatted =
          Number(balance) / 10 ** ELIZA_DECIMALS[network as keyof typeof ELIZA_DECIMALS];
        result.evm.balances[network] = balanceFormatted;

        if (balanceFormatted < config.MIN_HOT_WALLET_BALANCE) {
          logger.warn("[PayoutProcessor] LOW HOT WALLET BALANCE", {
            network,
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
      const mintAddress = new PublicKey(ELIZA_TOKEN_ADDRESSES.solana);
      const ata = await getAssociatedTokenAddress(mintAddress, this.solanaKeypair.publicKey);

      const account = await getAccount(this.solanaConnection, ata).catch(() => null);

      if (!account) {
        logger.warn("[PayoutProcessor] Solana token account not found", {
          wallet: this.solanaKeypair.publicKey.toBase58(),
        });
        result.solana.balance = 0;
      } else {
        const balanceFormatted = Number(account.amount) / 10 ** ELIZA_DECIMALS.solana;
        result.solana.balance = balanceFormatted;

        if (balanceFormatted < config.MIN_HOT_WALLET_BALANCE) {
          logger.warn("[PayoutProcessor] LOW HOT WALLET BALANCE", {
            network: "solana",
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
