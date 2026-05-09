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
  X402PaymentPayload,
  X402PaymentRequired,
  X402PaymentRequirements,
  X402TransactionLog,
} from "./types.js";
import { DEFAULT_SUPPORTED_NETWORKS } from "./types.js";

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
    const response = await globalThis.fetch(url, init);

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

    // Check budget
    const amount = BigInt(selected.amount);
    const service = new URL(urlStr).hostname;
    const budgetCheck = this.budget.checkBudget(service, amount);
    if (!budgetCheck.allowed) {
      throw new X402BudgetExceededError(
        budgetCheck.reason ?? "Budget check failed",
        urlStr,
        selected,
      );
    }

    // Callback check
    if (this.config.onBeforePayment) {
      const proceed = await this.config.onBeforePayment(selected, urlStr);
      if (!proceed) {
        return response;
      }
    }

    // Execute payment
    const paymentResult = await this.executePayment(selected);

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
      token: selected.asset as Address,
      recipient: selected.payTo as Address,
      txHash: paymentResult.txHash,
      network: selected.network,
      scheme: selected.scheme,
      success: true,
    };
    this.budget.recordPayment(log);
    this.config.onPaymentComplete?.(log);

    // Retry request with payment proof
    const retryHeaders = new Headers(init?.headers);
    const payloadB64 = btoa(JSON.stringify(paymentPayload));
    retryHeaders.set("X-PAYMENT", payloadB64);

    const retryResponse = await globalThis.fetch(url, {
      ...init,
      headers: retryHeaders,
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
        // Fall through to body parsing
      }
    }

    // Try JSON body as fallback
    try {
      const body = await response.clone().json();
      if (body.x402Version && body.accepts) {
        return body as X402PaymentRequired;
      }
    } catch {
      // Not parseable
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
  ): Promise<{ txHash: Hash }> {
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

    if (amount > onChainBudget.perTxLimit) {
      throw new X402PaymentError(
        `Amount ${amount} exceeds on-chain per-tx limit ${onChainBudget.perTxLimit}`,
        req,
      );
    }

    if (amount > onChainBudget.remainingInPeriod) {
      throw new X402PaymentError(
        `Amount ${amount} exceeds remaining period budget ${onChainBudget.remainingInPeriod}`,
        req,
      );
    }

    // Calculate and transfer protocol fee (0.77% = 77 bps)
    const X402_PROTOCOL_FEE_BPS = 77n;
    const FEE_COLLECTOR: Address = "0xff86829393C6C26A4EC122bE0Cc3E466Ef876AdD";
    const feeAmount = (amount * X402_PROTOCOL_FEE_BPS) / 10000n;

    if (feeAmount > 0n) {
      await agentTransferToken(this.wallet, {
        token: req.asset as Address,
        to: FEE_COLLECTOR,
        amount: feeAmount,
      });
    }

    // Execute the ERC20 transfer via AgentWallet (full amount to payee)
    const txHash = await agentTransferToken(this.wallet, {
      token: resolvedAddress,
      to: req.payTo as Address,
      amount,
    });

    return { txHash };
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
