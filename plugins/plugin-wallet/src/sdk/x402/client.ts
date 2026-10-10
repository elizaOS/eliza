/**
 * @module x402/client
 * x402 Payment Client — automatic HTTP 402 payment handling for AgentWallet.
 *
 * Wraps the standard fetch API to transparently handle 402 Payment Required
 * responses using the x402 protocol. Supports multi-chain, multi-asset payments
 * (USDC, USDT, DAI, WETH, and any token in the TokenRegistry) across all 11
 * mainnet chains configured in x402/types.ts.
 *
 * Flow: fetch → 402 detected → parse payment requirements → resolve asset address
 *       via TokenRegistry → budget check → execute ERC-20 transfer → retry with
 *       X-PAYMENT header.
 */
// x402 Client — automatic 402 payment handling for AgentWallet (v6: multi-asset)
import type { Address, Hash } from "viem";
import {
  type AgentWallet,
  agentTransferToken,
  checkBudget,
} from "../wallet-core.js";
import { X402BudgetTracker } from "./budget.js";
import { resolveAssetAddress } from "./multi-asset.js";
import type {
  X402ClientConfig,
  X402PaymentAttempt,
  X402PaymentPayload,
  X402PaymentRequired,
  X402PaymentRequirements,
  X402TransactionLog,
} from "./types.js";
import { DEFAULT_SUPPORTED_NETWORKS } from "./types.js";

export const DEFAULT_X402_FETCH_TIMEOUT_MS = 10_000;
const X402_PROTOCOL_FEE_BPS = 77n;

/**
 * [MAX-ADDED] x402 Payment Client for AgentWallet.
 *
 * Handles the full x402 payment flow:
 * 1. Detects 402 Payment Required responses
 * 2. Parses payment instructions from PAYMENT-REQUIRED header
 * 3. Validates against budget controls
 * 4. Executes USDC payment via AgentWallet contract
 * 5. Retries original request with payment proof
 */
export class X402Client {
  private wallet: AgentWallet;
  private config: X402ClientConfig;
  private budget: X402BudgetTracker;
  private supportedNetworks: Set<string>;

  constructor(wallet: AgentWallet, config: X402ClientConfig = {}) {
    this.wallet = wallet;
    this.config = {
      autoPay: true,
      maxRetries: 1,
      supportedNetworks: [...DEFAULT_SUPPORTED_NETWORKS],
      ...config,
    };
    this.budget = new X402BudgetTracker(config);
    this.supportedNetworks = new Set(this.config.supportedNetworks);
  }

  /**
   * Make an x402-aware fetch request. Automatically handles 402 responses.
   */
  async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const urlStr = url.toString();
    const timeoutSignal = AbortSignal.timeout(DEFAULT_X402_FETCH_TIMEOUT_MS);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const response = await globalThis.fetch(url, { ...init, signal });

    if (response.status !== 402) {
      return response;
    }

    if (!this.config.autoPay) {
      return response;
    }

    // Parse the 402 response
    const paymentRequired = await this.parse402Response(response);
    if (!paymentRequired) {
      return response; // Couldn't parse — return original 402
    }

    // Find a compatible payment option
    const selected = this.selectPaymentOption(paymentRequired.accepts);
    if (!selected) {
      return response; // No compatible payment option
    }

    // Check the budget and hold the amount until the payment is recorded or
    // abandoned, so concurrent payments can't all pass the same check
    const amount = BigInt(selected.amount);
    const protocolFee = (amount * X402_PROTOCOL_FEE_BPS) / 10000n;
    const chargedAmount = amount + protocolFee;
    const service = new URL(urlStr).hostname;
    const reservation = this.budget.reserve(service, chargedAmount);
    if (!reservation.allowed) {
      throw new X402BudgetExceededError(reservation.reason, urlStr, selected);
    }
    const { reservationId } = reservation;
    // One id per attempt, passed to every payment callback
    const attempt: X402PaymentAttempt = { paymentId: crypto.randomUUID() };

    let paymentResult: { txHash: Hash; token: Address };
    let transferAttempted = false;
    let approved = false;
    try {
      // Callback check
      if (this.config.onBeforePayment) {
        const proceed = await this.config.onBeforePayment(
          selected,
          urlStr,
          attempt,
        );
        if (!proceed) {
          this.budget.releaseReservation(reservationId);
          return response;
        }
      }
      approved = true;

      // Execute payment
      paymentResult = await this.executePayment(selected, protocolFee, () => {
        transferAttempted = true;
      });
    } catch (error) {
      // A transport/receipt error cannot prove that a submitted transfer failed.
      // Retain the hold after either the fee or principal transfer was attempted.
      if (!transferAttempted) this.budget.releaseReservation(reservationId);
      if (approved) {
        try {
          this.config.onPaymentFailed?.(selected, urlStr, error, {
            ...attempt,
            transferAttempted,
          });
        } catch {
          // A failing callback must not hide the payment error
        }
      }
      throw error;
    }
    const resolvedToken = paymentResult.token;

    // Build payment payload
    const paymentPayload: X402PaymentPayload = {
      x402Version: paymentRequired.x402Version,
      resource: paymentRequired.resource,
      accepted: selected,
      payload: {
        txHash: paymentResult.txHash,
        network: selected.network,
      },
    };

    // Log the transaction
    const log: X402TransactionLog = {
      timestamp: Math.floor(Date.now() / 1000),
      service,
      url: urlStr,
      amount,
      ...(protocolFee > 0n ? { protocolFee } : {}),
      token: resolvedToken,
      recipient: selected.payTo as Address,
      txHash: paymentResult.txHash,
      network: selected.network,
      scheme: selected.scheme,
      success: true,
    };
    this.budget.recordPayment(log, reservationId);
    this.config.onPaymentComplete?.(log, attempt);

    // Retry request with payment proof
    const retryHeaders = new Headers(init?.headers);
    const payloadB64 = btoa(JSON.stringify(paymentPayload));
    retryHeaders.set("X-PAYMENT", payloadB64);

    const retryTimeoutSignal = AbortSignal.timeout(
      DEFAULT_X402_FETCH_TIMEOUT_MS,
    );
    const retrySignal = init?.signal
      ? AbortSignal.any([init.signal, retryTimeoutSignal])
      : retryTimeoutSignal;
    const retryResponse = await globalThis.fetch(url, {
      ...init,
      headers: retryHeaders,
      signal: retrySignal,
    });

    return retryResponse;
  }

  /**
   * Parse a 402 response to extract payment requirements.
   */
  async parse402Response(
    response: Response,
  ): Promise<X402PaymentRequired | null> {
    // Try PAYMENT-REQUIRED header first (standard x402)
    const headerValue =
      response.headers.get("payment-required") ??
      response.headers.get("x-payment-required");

    if (headerValue) {
      try {
        const decoded = JSON.parse(atob(headerValue));
        return decoded as X402PaymentRequired;
      } catch {
        // error-policy:J3 an invalid untrusted payment header falls through to
        // the response body; it is never treated as an accepted requirement.
        // Fall through to body parsing
      }
    }

    // Try JSON body as fallback
    try {
      const body = await response.clone().json();
      if (body.x402Version && body.accepts) {
        return body as X402PaymentRequired;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw error;
      }
      // error-policy:J3 an invalid untrusted payment body is an explicit
      // unparseable result, distinct from a request cancellation or timeout.
    }

    return null;
  }

  /**
   * Select the best compatible payment option from offered requirements.
   * Prefers: Base network, stablecoins, exact scheme.
   *
   * v6 change: resolves assets via TokenRegistry in addition to USDC_ADDRESSES.
   * Now accepts any ERC-20 whose address is in the TokenRegistry for the network.
   */
  selectPaymentOption(
    accepts: X402PaymentRequirements[],
  ): X402PaymentRequirements | null {
    // Filter to supported networks and resolvable assets
    const compatible = accepts.filter((req) => {
      if (!this.supportedNetworks.has(req.network)) return false;

      // Config override: explicit supportedAssets list
      if (this.config.supportedAssets?.[req.network]) {
        return this.config.supportedAssets[req.network].some(
          (a) => a.toLowerCase() === req.asset.toLowerCase(),
        );
      }

      // v6: resolve via TokenRegistry — accept any known ERC-20 on this network
      const resolved = resolveAssetAddress(req.asset, req.network);
      return resolved != null;
    });

    if (compatible.length === 0) return null;

    // Prefer "exact" scheme, then lowest amount
    const exact = compatible.filter((r) => r.scheme === "exact");
    const candidates = exact.length > 0 ? exact : compatible;
    candidates.sort((a, b) => Number(BigInt(a.amount) - BigInt(b.amount)));

    return candidates[0];
  }

  /**
   * Execute the payment via AgentWallet's agentTransferToken.
   *
   * v6 change: resolves asset address via TokenRegistry before executing.
   * The 402 response may specify an asset by symbol ("USDC") or by address.
   */
  private async executePayment(
    req: X402PaymentRequirements,
    protocolFee: bigint,
    markTransferAttempted: () => void,
  ): Promise<{ txHash: Hash; token: Address }> {
    // Resolve the actual contract address for the requested asset
    const resolvedAddress = resolveAssetAddress(req.asset, req.network);
    if (!resolvedAddress) {
      throw new X402PaymentError(
        `Cannot resolve asset "${req.asset}" on network "${req.network}" to a contract address`,
        req,
      );
    }

    // First check on-chain budget
    const onChainBudget = await checkBudget(this.wallet, resolvedAddress);
    const amount = BigInt(req.amount);

    const chargedAmount = amount + protocolFee;
    if (chargedAmount > onChainBudget.perTxLimit) {
      throw new X402PaymentError(
        `Amount ${chargedAmount} including protocol fee exceeds on-chain per-tx limit ${onChainBudget.perTxLimit}`,
        req,
      );
    }

    if (chargedAmount > onChainBudget.remainingInPeriod) {
      throw new X402PaymentError(
        `Amount ${chargedAmount} including protocol fee exceeds remaining period budget ${onChainBudget.remainingInPeriod}`,
        req,
      );
    }

    // Transfer the protocol fee (0.77% = 77 bps) before the recipient amount.
    const FEE_COLLECTOR: Address = "0xff86829393C6C26A4EC122bE0Cc3E466Ef876AdD";

    markTransferAttempted();
    if (protocolFee > 0n) {
      await agentTransferToken(this.wallet, {
        token: resolvedAddress,
        to: FEE_COLLECTOR,
        amount: protocolFee,
      });
    }

    // Execute the ERC20 transfer via AgentWallet (full amount to payee)
    const txHash = await agentTransferToken(this.wallet, {
      token: resolvedAddress,
      to: req.payTo as Address,
      amount,
    });

    return { txHash, token: resolvedAddress };
  }

  // ─── Budget Access ───

  /** Get the budget tracker for direct inspection */
  get budgetTracker(): X402BudgetTracker {
    return this.budget;
  }

  /** Get transaction log */
  getTransactionLog(filter?: {
    service?: string;
    since?: number;
  }): X402TransactionLog[] {
    return this.budget.getTransactionLog(filter);
  }

  /** Get daily spend summary */
  getDailySpendSummary() {
    return this.budget.getDailySpendSummary();
  }
}

// ─── Error Types ───

export class X402PaymentError extends Error {
  constructor(
    message: string,
    public readonly paymentRequirements: X402PaymentRequirements,
  ) {
    super(`x402 payment error: ${message}`);
    this.name = "X402PaymentError";
  }
}

export class X402BudgetExceededError extends Error {
  constructor(
    public readonly reason: string,
    public readonly url: string,
    public readonly paymentRequirements: X402PaymentRequirements,
  ) {
    super(`x402 budget exceeded: ${reason}`);
    this.name = "X402BudgetExceededError";
  }
}
