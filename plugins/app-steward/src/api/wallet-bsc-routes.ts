/**
 * BSC wallet trade routes: preflight, quote, tx-status, trading profile,
 * transfer/execute, and production-defaults.
 *
 * Extracted from server.ts to reduce file size.
 */

import type http from "node:http";
import type { ReadJsonBodyOptions } from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/agent";
import { logger } from "@elizaos/core";
import { ethers } from "ethers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalletBscRouteDeps {
  getWalletAddresses: () => {
    evmAddress: string | null;
    solanaAddress: string | null;
  };
  resolveWalletRpcReadiness: (config: ElizaConfig) => {
    bscRpcUrls: string[];
    cloudManagedAccess: boolean;
  };
  resolvePrimaryBscRpcUrl: (args: {
    rpcUrls: string[];
    cloudManagedAccess: boolean;
  }) => string | null;
  buildBscTradePreflight: (args: {
    walletAddress: string | null;
    tokenAddress?: string;
    rpcUrls: string[];
    cloudManagedAccess: boolean;
  }) => Promise<unknown>;
  buildBscTradeQuote: (args: {
    walletAddress: string | null;
    rpcUrls: string[];
    cloudManagedAccess: boolean;
    request: {
      side: "buy" | "sell";
      tokenAddress: string;
      amount: string;
      slippageBps?: number;
      routeProvider?: "auto" | "pancakeswap-v2" | "0x";
    };
  }) => Promise<unknown>;
  updateWalletTradeLedgerEntryStatus: (
    hash: string,
    update: unknown,
  ) => unknown;
  loadWalletTradingProfile: (opts: unknown) => unknown;
  resolveTradePermissionMode: (config: ElizaConfig) => unknown;
  isAgentAutomationRequest: (req: http.IncomingMessage) => boolean;
  canUseLocalTradeExecution: (
    mode: unknown,
    isAgentRequest: boolean,
  ) => boolean;
  saveElizaConfig: (config: ElizaConfig) => void;
}

export interface WalletBscRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: { config: ElizaConfig };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  deps: WalletBscRouteDeps;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleWalletBscRoutes(
  ctx: WalletBscRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    url,
    state,
    json,
    error,
    readJsonBody,
    deps,
  } = ctx;

  // ── POST /api/wallet/trade/preflight ───────────────────────────────────
  if (method === "POST" && pathname === "/api/wallet/trade/preflight") {
    const body = await readJsonBody<{ tokenAddress?: string }>(req, res);
    if (!body) return true;

    const addrs = deps.getWalletAddresses();
    const walletRpcReadiness = deps.resolveWalletRpcReadiness(state.config);
    try {
      const result = await deps.buildBscTradePreflight({
        walletAddress: addrs.evmAddress ?? null,
        tokenAddress: body.tokenAddress,
        rpcUrls: walletRpcReadiness.bscRpcUrls,
        cloudManagedAccess: walletRpcReadiness.cloudManagedAccess,
      });
      json(res, result);
    } catch (err) {
      logger.error(
        `[api] BSC trade preflight failed: ${err instanceof Error ? err.message : err}`,
      );
      error(
        res,
        `Trade preflight failed: ${err instanceof Error ? err.message : "unknown error"}`,
        500,
      );
    }
    return true;
  }

  // ── POST /api/wallet/trade/quote ────────────────────────────────────────
  if (method === "POST" && pathname === "/api/wallet/trade/quote") {
    const body = await readJsonBody<{
      side?: string;
      tokenAddress?: string;
      amount?: string;
      slippageBps?: number;
      routeProvider?: "auto" | "pancakeswap-v2" | "0x";
    }>(req, res);
    if (!body) return true;

    if (!body.side || !body.tokenAddress || !body.amount) {
      error(res, "side, tokenAddress, and amount are required", 400);
      return true;
    }

    const addrs = deps.getWalletAddresses();
    const walletRpcReadiness = deps.resolveWalletRpcReadiness(state.config);
    try {
      const result = await deps.buildBscTradeQuote({
        walletAddress: addrs.evmAddress ?? null,
        rpcUrls: walletRpcReadiness.bscRpcUrls,
        cloudManagedAccess: walletRpcReadiness.cloudManagedAccess,
        request: {
          side: body.side as "buy" | "sell",
          tokenAddress: body.tokenAddress,
          amount: body.amount,
          slippageBps: body.slippageBps,
          routeProvider: body.routeProvider,
        },
      });
      json(res, result);
    } catch (err) {
      logger.error(
        `[api] BSC trade quote failed: ${err instanceof Error ? err.message : err}`,
      );
      error(
        res,
        `Trade quote failed: ${err instanceof Error ? err.message : "unknown error"}`,
        500,
      );
    }
    return true;
  }

  // ── GET /api/wallet/trade/tx-status ────────────────────────────────────
  if (method === "GET" && pathname === "/api/wallet/trade/tx-status") {
    const hash = url.searchParams.get("hash");
    if (!hash?.trim()) {
      error(res, "hash query parameter is required", 400);
      return true;
    }

    const walletRpcReadiness = deps.resolveWalletRpcReadiness(state.config);
    const rpcUrl = deps.resolvePrimaryBscRpcUrl({
      rpcUrls: walletRpcReadiness.bscRpcUrls,
      cloudManagedAccess: walletRpcReadiness.cloudManagedAccess,
    });

    if (!rpcUrl) {
      error(res, "BSC RPC not configured.", 503);
      return true;
    }

    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const receipt = await provider.getTransactionReceipt(hash);

      let txStatus: "pending" | "success" | "reverted" | "not_found";
      let blockNumber: number | null = null;
      let gasUsed: string | null = null;
      let effectiveGasPriceWei: string | null = null;
      let confirmations = 0;
      let nonce: number | null = null;

      if (!receipt) {
        const tx = await provider.getTransaction(hash);
        txStatus = tx ? "pending" : "not_found";
        if (tx) nonce = tx.nonce;
      } else {
        txStatus = receipt.status === 1 ? "success" : "reverted";
        blockNumber = receipt.blockNumber ?? null;
        gasUsed = receipt.gasUsed?.toString() ?? null;
        effectiveGasPriceWei = receipt.gasPrice?.toString() ?? null;
        const currentBlock = await provider.getBlockNumber();
        confirmations =
          blockNumber !== null ? Math.max(0, currentBlock - blockNumber) : 0;
        const tx = await provider.getTransaction(hash);
        if (tx) nonce = tx.nonce;
      }

      if (txStatus === "success" || txStatus === "reverted") {
        try {
          deps.updateWalletTradeLedgerEntryStatus(hash, {
            status: txStatus,
            confirmations,
            nonce,
            blockNumber,
            gasUsed,
            effectiveGasPriceWei,
            explorerUrl: `https://bscscan.com/tx/${hash}`,
          });
        } catch (ledgerErr) {
          logger.warn(
            `[api] Failed to update trade ledger: ${ledgerErr instanceof Error ? ledgerErr.message : ledgerErr}`,
          );
        }
      }

      provider.destroy();

      json(res, {
        ok: true,
        hash,
        status: txStatus,
        explorerUrl: `https://bscscan.com/tx/${hash}`,
        chainId: 56,
        blockNumber,
        confirmations,
        nonce,
        gasUsed,
        effectiveGasPriceWei,
      });
    } catch (err) {
      logger.error(
        `[api] BSC tx-status failed: ${err instanceof Error ? err.message : err}`,
      );
      error(
        res,
        `TX status check failed: ${err instanceof Error ? err.message : "unknown error"}`,
        500,
      );
    }
    return true;
  }

  // ── GET /api/wallet/trading/profile ────────────────────────────────────
  if (method === "GET" && pathname === "/api/wallet/trading/profile") {
    const windowParam = url.searchParams.get("window");
    const sourceParam = url.searchParams.get("source");

    const window =
      windowParam === "7d" || windowParam === "30d" || windowParam === "all"
        ? windowParam
        : "30d";
    const source =
      sourceParam === "agent" ||
      sourceParam === "manual" ||
      sourceParam === "all"
        ? sourceParam
        : "all";

    try {
      const profile = deps.loadWalletTradingProfile({ window, source });
      json(res, profile);
    } catch (err) {
      logger.error(
        `[api] Wallet trading profile failed: ${err instanceof Error ? err.message : err}`,
      );
      error(
        res,
        `Trading profile fetch failed: ${err instanceof Error ? err.message : "unknown error"}`,
        500,
      );
    }
    return true;
  }

  // ── POST /api/wallet/transfer/execute ──────────────────────────────────
  if (method === "POST" && pathname === "/api/wallet/transfer/execute") {
    const body = await readJsonBody<{
      toAddress?: string;
      amount?: string;
      assetSymbol?: string;
      tokenAddress?: string;
      confirm?: boolean;
    }>(req, res);
    if (!body) return true;

    if (
      !body.toAddress?.trim() ||
      !body.amount?.trim() ||
      !body.assetSymbol?.trim()
    ) {
      error(res, "toAddress, amount, and assetSymbol are required", 400);
      return true;
    }

    const tradePermissionMode = deps.resolveTradePermissionMode(state.config);
    const isAgentRequest = deps.isAgentAutomationRequest(req);
    const hasLocalKey = Boolean(process.env.EVM_PRIVATE_KEY?.trim());
    const canExecuteLocally = deps.canUseLocalTradeExecution(
      tradePermissionMode,
      isAgentRequest,
    );
    const addrs = deps.getWalletAddresses();
    const walletRpcReadiness = deps.resolveWalletRpcReadiness(state.config);

    let toAddress: string;
    try {
      toAddress = ethers.getAddress(body.toAddress.trim());
    } catch {
      error(res, "Invalid toAddress — must be a valid EVM address", 400);
      return true;
    }

    const isBnb = body.assetSymbol.toUpperCase() === "BNB";

    let decimals = 18;
    if (body.tokenAddress) {
      try {
        const tokenContract = new ethers.Contract(
          body.tokenAddress,
          ["function decimals() view returns (uint8)"],
          new ethers.JsonRpcProvider(
            deps.resolvePrimaryBscRpcUrl({
              rpcUrls: walletRpcReadiness.bscRpcUrls,
              cloudManagedAccess: walletRpcReadiness.cloudManagedAccess,
            }) ?? "https://bsc-dataseed1.binance.org/",
          ),
        );
        decimals = Number(await tokenContract.decimals());
      } catch {
        // Fallback to 18 if decimals call fails
      }
    }

    const unsignedTx = {
      chainId: 56,
      from: addrs.evmAddress ?? null,
      to: isBnb ? toAddress : (body.tokenAddress ?? toAddress),
      data: isBnb
        ? "0x"
        : (() => {
            const iface = new ethers.Interface([
              "function transfer(address to, uint256 amount) returns (bool)",
            ]);
            return iface.encodeFunctionData("transfer", [
              toAddress,
              ethers.parseUnits(body.amount?.trim(), decimals),
            ]);
          })(),
      valueWei: isBnb ? ethers.parseEther(body.amount.trim()).toString() : "0",
      explorerUrl: "https://bscscan.com",
      assetSymbol: body.assetSymbol,
      amount: body.amount.trim(),
      tokenAddress: body.tokenAddress,
    };

    if (!hasLocalKey || !canExecuteLocally || body.confirm !== true) {
      json(res, {
        ok: true,
        mode: hasLocalKey && canExecuteLocally ? "local-key" : "user-sign",
        executed: false,
        requiresUserSignature: true,
        toAddress,
        amount: body.amount.trim(),
        assetSymbol: body.assetSymbol,
        tokenAddress: body.tokenAddress,
        unsignedTx,
      });
      return true;
    }

    const rpcUrl = deps.resolvePrimaryBscRpcUrl({
      rpcUrls: walletRpcReadiness.bscRpcUrls,
      cloudManagedAccess: walletRpcReadiness.cloudManagedAccess,
    });

    if (!rpcUrl) {
      error(res, "BSC RPC not configured for local execution.", 503);
      return true;
    }

    try {
      const evmKey = process.env.EVM_PRIVATE_KEY ?? "";
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(
        evmKey.startsWith("0x") ? evmKey : `0x${evmKey}`,
        provider,
      );

      const txReq: ethers.TransactionRequest = {
        to: unsignedTx.to,
        data: unsignedTx.data,
        value: BigInt(unsignedTx.valueWei),
        chainId: unsignedTx.chainId,
      };

      const txResponse = await wallet.sendTransaction(txReq);
      const nonce = txResponse.nonce;

      provider.destroy();

      json(res, {
        ok: true,
        mode: "local-key",
        executed: true,
        requiresUserSignature: false,
        toAddress,
        amount: body.amount.trim(),
        assetSymbol: body.assetSymbol,
        tokenAddress: body.tokenAddress,
        unsignedTx,
        execution: {
          hash: txResponse.hash,
          nonce,
          gasLimit: txResponse.gasLimit?.toString() ?? "0",
          valueWei: unsignedTx.valueWei,
          explorerUrl: `https://bscscan.com/tx/${txResponse.hash}`,
          blockNumber: null,
          status: "pending",
        },
      });
    } catch (err) {
      logger.error(
        `[api] Transfer execute failed: ${err instanceof Error ? err.message : err}`,
      );
      error(
        res,
        `Transfer failed: ${err instanceof Error ? err.message : "unknown error"}`,
        500,
      );
    }
    return true;
  }

  // ── POST /api/wallet/production-defaults ───────────────────────────────
  if (method === "POST" && pathname === "/api/wallet/production-defaults") {
    const changed: string[] = [];

    if (!state.config.features) {
      state.config.features = {};
    }
    const features = state.config.features as Record<string, unknown>;

    if (!features.tradePermissionMode) {
      features.tradePermissionMode = "user-sign-only";
      changed.push("tradePermissionMode=user-sign-only");
    }

    if (changed.length > 0) {
      try {
        deps.saveElizaConfig(state.config);
      } catch (err) {
        logger.warn(
          `[api] production-defaults config save failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    json(res, {
      ok: true,
      applied: changed,
      tradePermissionMode: deps.resolveTradePermissionMode(state.config),
    });
    return true;
  }

  return false;
}
