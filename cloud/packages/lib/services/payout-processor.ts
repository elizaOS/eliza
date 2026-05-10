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
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { type Address, createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { dbRead, dbWrite } from "@/db/client";
import { tokenRedemptions } from "@/db/schemas/token-redemptions";
import { ELIZA_DECIMALS, ERC20_ABI, EVM_CHAINS } from "@/lib/config/token-constants";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { logger } from "@/lib/utils/logger";
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

    // Find approved redemptions that aren't being processed
    const redemptions = await dbRead
      .select()
      .from(tokenRedemptions)
      .where(
        and(
          eq(tokenRedemptions.status, "approved"),
          or(
            isNull(tokenRedemptions.processing_started_at),
            lt(
              tokenRedemptions.processing_started_at,
              new Date(Date.now() - payoutConfig.LOCK_TIMEOUT_MS),
            ),
          ),
          lt(
            sql`CAST(${tokenRedemptions.retry_count} AS INTEGER)`,
            payoutConfig.MAX_RETRY_ATTEMPTS,
          ),
        ),
      )
      .limit(payoutConfig.BATCH_SIZE);

    for (const redemption of redemptions) {
      stats.processed++;

      // Try to acquire lock
      const locked = await this.acquireLock(redemption.id);
      if (!locked) {
        stats.skipped++;
        continue;
      }

      // Process the payout
      const result = await this.processRedemption(redemption);

      if (result.success) {
        await this.markCompleted(redemption.id, result.txHash!);
        stats.succeeded++;
      } else {
        await this.markFailed(redemption.id, result.error!, result.retryable ?? true);
        stats.failed++;
      }
    }

    logger.info("[PayoutProcessor] Batch completed", stats);
    return stats;
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

    const publicClient = createPublicClient({
      chain,
      transport: http(),
    });

    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(),
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

    const { PublicKey, Transaction, sendAndConfirmTransaction } =
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

    // Send and confirm transaction
    const signature = await sendAndConfirmTransaction(
      this.solanaConnection,
      transaction,
      [this.solanaKeypair],
      { commitment: "confirmed" },
    );

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
  private async markCompleted(redemptionId: string, txHash: string): Promise<void> {
    await dbWrite
      .update(tokenRedemptions)
      .set({
        status: "completed",
        tx_hash: txHash,
        completed_at: new Date(),
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
      // Increment retry count and reset to approved for retry
      await dbWrite
        .update(tokenRedemptions)
        .set({
          status: "approved", // Reset to approved for retry
          failure_reason: reason,
          retry_count: sql`${tokenRedemptions.retry_count} + 1`,
          processing_started_at: null,
          processing_worker_id: null,
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

        const publicClient = createPublicClient({
          chain,
          transport: http(),
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
