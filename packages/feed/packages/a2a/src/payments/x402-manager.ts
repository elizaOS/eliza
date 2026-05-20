/**
 * x402 Micropayment Manager
 * Implements HTTP 402-based micropayment protocol for agent services
 *
 * Supports optional Redis for persistent storage across serverless functions
 */

import {
  type JsonValue,
  logger,
  type PaymentVerificationParams,
  type PaymentVerificationResult,
} from '@babylon/shared';
import {
  formatEther,
  hexlify,
  JsonRpcProvider,
  type Provider,
  parseEther,
  randomBytes,
} from 'ethers';
import { z } from 'zod';
import type { PaymentRequest } from '../types/a2a';
import { PaymentRequestSchema } from '../types/a2a';

export interface X402Config {
  rpcUrl: string;
  minPaymentAmount?: string; // Minimum payment in wei (default: 0)
  paymentTimeout?: number; // Payment timeout in ms (default: 5 minutes)
  /** Max time for each JSON-RPC read (getTransaction / receipt). Prevents hung providers on serverless. */
  rpcReadTimeoutMs?: number;
  redis?: RedisClient; // Optional Redis client for persistence
}

/**
 * Generic Redis client interface to avoid dependency on specific Redis libraries
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { ex?: number }): Promise<void>;
  del(key: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
}

interface PendingPayment {
  request: PaymentRequest;
  createdAt: number;
  verified: boolean;
}

const PendingPaymentSchema = z.object({
  request: PaymentRequestSchema,
  createdAt: z.number(),
  verified: z.boolean(),
});

const REDIS_PREFIX = 'x402:payment:';

export class X402Manager {
  private provider: Provider;
  private config: Required<Omit<X402Config, 'redis' | 'rpcReadTimeoutMs'>> & {
    redis?: RedisClient;
    rpcReadTimeoutMs: number;
  };
  private readonly DEFAULT_MIN_PAYMENT = '1000000000000000'; // 0.001 ETH
  private readonly DEFAULT_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private readonly DEFAULT_RPC_READ_TIMEOUT_MS = 20_000;
  private inMemoryStore: Map<string, PendingPayment> = new Map();

  constructor(config: X402Config) {
    this.provider = new JsonRpcProvider(config.rpcUrl);
    this.config = {
      rpcUrl: config.rpcUrl,
      minPaymentAmount: config.minPaymentAmount || this.DEFAULT_MIN_PAYMENT,
      paymentTimeout: config.paymentTimeout || this.DEFAULT_TIMEOUT,
      rpcReadTimeoutMs:
        config.rpcReadTimeoutMs ?? this.DEFAULT_RPC_READ_TIMEOUT_MS,
      redis: config.redis,
    };
  }

  private async withRpcTimeout<T>(
    label: string,
    operation: Promise<T>
  ): Promise<T> {
    const ms = this.config.rpcReadTimeoutMs;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    });
    try {
      return await Promise.race([operation, timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Store payment with optional Redis persistence
   */
  private async storePayment(
    requestId: string,
    payment: PendingPayment
  ): Promise<void> {
    const key = `${REDIS_PREFIX}${requestId}`;
    const ttlSeconds = Math.ceil(this.config.paymentTimeout / 1000);
    const serialized = JSON.stringify(payment);

    // Always store in memory for fast access
    this.inMemoryStore.set(requestId, payment);

    // Also store in Redis if available
    if (this.config.redis) {
      await this.config.redis.set(key, serialized, { ex: ttlSeconds });
      logger.debug('[X402Manager] Stored payment in Redis', {
        requestId,
        ttl: ttlSeconds,
      });
    } else {
      logger.debug('[X402Manager] Redis not configured, using memory storage', {
        requestId,
      });
    }
  }

  /**
   * Retrieve payment from storage
   */
  private async getPayment(requestId: string): Promise<PendingPayment | null> {
    // First check in-memory store
    const inMemory = this.inMemoryStore.get(requestId);
    if (inMemory) {
      return inMemory;
    }

    // Try Redis if available
    if (!this.config.redis) {
      return null;
    }

    const key = `${REDIS_PREFIX}${requestId}`;

    const cached = await this.config.redis.get(key);

    if (!cached) {
      logger.debug('[X402Manager] Payment not found', { requestId });
      return null;
    }

    const paymentData = JSON.parse(cached);
    const validation = PendingPaymentSchema.safeParse(paymentData);

    if (!validation.success) {
      logger.error('[X402Manager] Invalid payment data', {
        requestId,
        error: validation.error,
      });
      await this.deletePayment(requestId);
      return null;
    }

    const payment: PendingPayment = {
      ...validation.data,
      request: {
        ...validation.data.request,
        metadata: validation.data.request.metadata as Record<
          string,
          string | number | boolean | null
        >,
      },
    };

    // Cache in memory
    this.inMemoryStore.set(requestId, payment);
    return payment;
  }

  /**
   * Update payment in storage
   */
  private async updatePayment(
    requestId: string,
    payment: PendingPayment
  ): Promise<void> {
    const key = `${REDIS_PREFIX}${requestId}`;
    const remainingMs = payment.request.expiresAt - Date.now();
    const ttlSeconds = Math.max(Math.ceil(remainingMs / 1000), 1);
    const serialized = JSON.stringify(payment);

    // Update in-memory
    this.inMemoryStore.set(requestId, payment);

    // Update Redis if available
    if (this.config.redis) {
      await this.config.redis.set(key, serialized, { ex: ttlSeconds });
      logger.debug('[X402Manager] Updated payment', { requestId });
    }
  }

  /**
   * Delete payment from storage
   */
  private async deletePayment(requestId: string): Promise<void> {
    const key = `${REDIS_PREFIX}${requestId}`;

    // Remove from memory
    this.inMemoryStore.delete(requestId);

    // Remove from Redis if available
    if (this.config.redis) {
      await this.config.redis.del(key);
      logger.debug('[X402Manager] Deleted payment', { requestId });
    }
  }

  /**
   * Create a payment request for a service
   */
  async createPaymentRequest(
    from: string,
    to: string,
    amount: string,
    service: string,
    metadata?: Record<string, string | number | boolean | null>
  ): Promise<PaymentRequest> {
    // Validate amount meets minimum
    const amountBn = parseEther(formatEther(amount));
    const minAmountBn = parseEther(formatEther(this.config.minPaymentAmount));

    if (amountBn < minAmountBn) {
      throw new Error(
        `Payment amount must be at least ${this.config.minPaymentAmount} wei`
      );
    }

    const requestId = this.generateRequestId();
    const expiresAt = Date.now() + this.config.paymentTimeout;

    const request: PaymentRequest = {
      requestId,
      from,
      to,
      amount,
      service,
      metadata: metadata as Record<string, JsonValue>,
      expiresAt,
    };

    // Store pending payment
    await this.storePayment(requestId, {
      request,
      createdAt: Date.now(),
      verified: false,
    });

    return request;
  }

  /**
   * Verify a payment receipt against blockchain transaction
   * Supports both EOA and smart wallet transactions
   */
  async verifyPayment(
    verificationData: PaymentVerificationParams
  ): Promise<PaymentVerificationResult> {
    const pending = await this.getPayment(verificationData.requestId);
    if (!pending) {
      return { verified: false, error: 'Payment request not found or expired' };
    }

    if (pending.verified) {
      return { verified: true };
    }

    if (Date.now() > pending.request.expiresAt) {
      await this.deletePayment(verificationData.requestId);
      return { verified: false, error: 'Payment request expired' };
    }

    let tx;
    try {
      tx = await this.withRpcTimeout(
        'getTransaction',
        this.provider.getTransaction(verificationData.txHash)
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('timed out')) {
        return {
          verified: false,
          error:
            'Blockchain RPC timed out. Wait for confirmation, then try again.',
        };
      }
      throw e;
    }
    if (!tx) {
      return { verified: false, error: 'Transaction not found on blockchain' };
    }

    let txReceipt;
    try {
      txReceipt = await this.withRpcTimeout(
        'getTransactionReceipt',
        this.provider.getTransactionReceipt(verificationData.txHash)
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('timed out')) {
        return {
          verified: false,
          error:
            'Blockchain RPC timed out. Wait for confirmation, then try again.',
        };
      }
      throw e;
    }
    if (!txReceipt) {
      return { verified: false, error: 'Transaction not yet confirmed' };
    }

    if (txReceipt.status !== 1) {
      return { verified: false, error: 'Transaction failed on blockchain' };
    }

    const errors: string[] = [];

    // For smart wallets (account abstraction), the tx.from might be the paymaster or smart wallet
    // We need to be more lenient with sender validation
    const fromMatch =
      tx.from.toLowerCase() === pending.request.from.toLowerCase();

    // Check if this might be a smart wallet transaction (has different from address)
    const isSmartWallet = !fromMatch;

    if (!fromMatch) {
      logger.warn(
        `[X402Manager] Sender mismatch: expected ${pending.request.from}, got ${tx.from}, treating as smart wallet`
      );
      // For production, you may want to implement more sophisticated verification:
      // - Check transaction trace for internal calls to the sender's smart wallet
      // - Verify the smart wallet contract code/factory
    }

    // Recipient validation - should be strict
    const recipientMatch =
      tx.to?.toLowerCase() === pending.request.to.toLowerCase();

    if (!recipientMatch) {
      // For smart wallets, tx.to could be an entrypoint. A robust solution would involve:
      // 1. Decoding the transaction data to find the ultimate recipient.
      // 2. Tracing the transaction to see internal calls.
      // For now, we will reject if there is a direct mismatch, to be safe.
      errors.push(
        `Recipient mismatch: expected ${pending.request.to}, got ${tx.to}`
      );
    }

    // Verify amount (with some tolerance for gas and fees)
    const requestedAmount = BigInt(pending.request.amount);
    const paidAmount = tx.value;

    // Allow for 1% tolerance for gas fees in smart wallet transactions
    const minAcceptableAmount = (requestedAmount * 99n) / 100n;

    if (paidAmount < minAcceptableAmount) {
      errors.push(
        `Insufficient payment: expected at least ${minAcceptableAmount}, got ${paidAmount}`
      );
    }

    if (errors.length > 0) {
      return { verified: false, error: errors.join('; ') };
    }

    // Mark as verified
    pending.verified = true;
    await this.updatePayment(verificationData.requestId, pending);

    logger.info(
      `[X402Manager] Payment verified successfully: ${verificationData.txHash}`,
      {
        requestId: verificationData.requestId,
        isSmartWallet,
      }
    );

    return { verified: true };
  }

  /**
   * Get payment request details
   */
  async getPaymentRequest(requestId: string): Promise<PaymentRequest | null> {
    const pending = await this.getPayment(requestId);
    return pending ? pending.request : null;
  }

  /**
   * Check if payment has been verified
   */
  async isPaymentVerified(requestId: string): Promise<boolean> {
    const pending = await this.getPayment(requestId);
    return pending ? pending.verified : false;
  }

  /**
   * Cancel a payment request
   */
  async cancelPaymentRequest(requestId: string): Promise<boolean> {
    await this.deletePayment(requestId);
    return true;
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `x402-${Date.now()}-${hexlify(randomBytes(16))}`;
  }

  /**
   * Get all pending payments (for testing/debugging)
   */
  async getPendingPayments(): Promise<PendingPayment[]> {
    // Get from in-memory store
    const payments = Array.from(this.inMemoryStore.values());
    return payments.filter((p) => !p.verified);
  }

  /**
   * Get statistics about payments (for testing/debugging)
   */
  async getStatistics() {
    const payments = Array.from(this.inMemoryStore.values());
    const now = Date.now();

    return payments.reduce(
      (acc, p) => {
        if (p.verified) {
          acc.verified++;
        } else if (p.request.expiresAt < now) {
          acc.expired++;
        } else {
          acc.pending++;
        }
        return acc;
      },
      { pending: 0, verified: 0, expired: 0 }
    );
  }

  /**
   * Cleanup method to clear in-memory storage
   */
  cleanup(): void {
    this.inMemoryStore.clear();
  }
}
