/**
 * Wallet trade / transfer compat routes.
 *
 * Handles:
 *   POST /api/wallet/trade/execute    — BSC DEX trade execution
 *   POST /api/wallet/transfer/execute — token / BNB transfer execution
 */
import type http from "node:http";
import { loadElizaConfig } from "@elizaos/agent";
import {
  type CompatRuntimeState,
  ensureCompatApiAuthorized,
  readCompatJsonBody,
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "@elizaos/app-core";
import { logger } from "@elizaos/core";
import {
  canUseLocalTradeExecution as _canUseLocalTradeExecution,
  resolveTradePermissionMode as _resolveTradePermissionMode,
} from "@elizaos/plugin-wallet";
import { type PolicyResult, StewardApiError } from "@stwd/sdk";
import * as ethers from "ethers";
import {
  buildBscApproveUnsignedTx,
  buildBscBuyUnsignedTx,
  buildBscSellUnsignedTx,
  buildBscTradeQuote,
  resolveBscApprovalSpender,
  resolvePrimaryBscRpcUrl,
} from "../api/bsc-trade";
import { getWalletAddresses } from "../api/wallet";
import { resolveWalletRpcReadiness } from "../api/wallet-rpc";
import { recordWalletTradeLedgerEntry } from "../api/wallet-trading-profile";
import {
  isStewardConfigured,
  signTransactionWithOptionalSteward,
} from "./steward-bridge";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_AUTOMATION_HEADER = "x-elizaos-agent-action";

// ---------------------------------------------------------------------------
// Helpers (only used by trade / transfer routes)
// ---------------------------------------------------------------------------

function isAgentAutomationRequest(
  req: Pick<http.IncomingMessage, "headers">,
): boolean {
  const raw = req.headers[AGENT_AUTOMATION_HEADER];
  return typeof raw === "string" && /^(1|true|yes|agent)$/i.test(raw.trim());
}

function resolveBscExecutionNetwork(): {
  chainId: number;
  explorerBaseUrl: string;
} {
  if (process.env.ELIZA_WALLET_NETWORK?.trim().toLowerCase() === "testnet") {
    const parsedChainId = Number.parseInt(
      process.env.BSC_TESTNET_CHAIN_ID?.trim() ?? "97",
      10,
    );
    return {
      chainId: Number.isNaN(parsedChainId) ? 97 : parsedChainId,
      explorerBaseUrl: "https://testnet.bscscan.com",
    };
  }

  return {
    chainId: 56,
    explorerBaseUrl: "https://bscscan.com",
  };
}

function resolveWalletExecutionMode(
  canSign: boolean,
  canExecuteLocally: boolean,
  hasStewardSigner: boolean,
): "local-key" | "steward" | "user-sign" {
  if (!canSign || !canExecuteLocally) {
    return "user-sign";
  }

  return hasStewardSigner ? "steward" : "local-key";
}

interface LocalSignedTransactionResult {
  hash: string;
  nonce: number;
  gasLimit: string;
}

/** Broadcast a signed tx using `EVM_PRIVATE_KEY` and a JSON-RPC provider (local execution path). */
async function sendLocalWalletTransaction(
  rpcUrl: string,
  tx: {
    to: string;
    data?: string;
    value: bigint;
    chainId: number;
    nonce?: number;
  },
): Promise<LocalSignedTransactionResult> {
  const evmKey = process.env.EVM_PRIVATE_KEY ?? "";
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  try {
    const wallet = new ethers.Wallet(
      evmKey.startsWith("0x") ? evmKey : `0x${evmKey}`,
      provider,
    );
    const txResponse = await wallet.sendTransaction(tx);
    return {
      hash: txResponse.hash,
      nonce: txResponse.nonce,
      gasLimit: txResponse.gasLimit?.toString() ?? "0",
    };
  } finally {
    provider.destroy();
  }
}

function getStewardPolicyResults(error: StewardApiError): PolicyResult[] {
  if (
    error.data &&
    typeof error.data === "object" &&
    "results" in error.data &&
    Array.isArray(error.data.results)
  ) {
    return error.data.results as PolicyResult[];
  }

  return [];
}

function isStewardPolicyRejection(error: unknown): error is StewardApiError {
  return error instanceof StewardApiError && error.status === 403;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleWalletTradeCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  // ── POST /api/wallet/trade/execute ─────────────────────────────────────
  if (method === "POST" && url.pathname === "/api/wallet/trade/execute") {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const body = await readCompatJsonBody(req, res);
    if (body == null) {
      return true;
    }

    const side = typeof body.side === "string" ? body.side : "";
    const tokenAddress =
      typeof body.tokenAddress === "string" ? body.tokenAddress : "";
    const amount = typeof body.amount === "string" ? body.amount : "";
    const routeProvider =
      body.routeProvider === "0x" ||
      body.routeProvider === "pancakeswap-v2" ||
      body.routeProvider === "auto"
        ? body.routeProvider
        : undefined;

    if (!side || !tokenAddress || !amount) {
      sendJsonErrorResponse(
        res,
        400,
        "side, tokenAddress, and amount are required",
      );
      return true;
    }

    if (side !== "buy" && side !== "sell") {
      sendJsonErrorResponse(res, 400, 'side must be "buy" or "sell"');
      return true;
    }

    const config = loadElizaConfig();
    const tradePermissionMode = _resolveTradePermissionMode(config);
    const canExecuteLocally = _canUseLocalTradeExecution(
      tradePermissionMode,
      isAgentAutomationRequest(req),
    );
    const addresses = getWalletAddresses();
    const walletAddress = addresses.evmAddress ?? null;
    const hasLocalKey = Boolean(process.env.EVM_PRIVATE_KEY?.trim());
    const hasStewardSigner = isStewardConfigured();
    const canSign = hasLocalKey || hasStewardSigner;
    const rpcReadiness = resolveWalletRpcReadiness(config);
    const bscExecutionNetwork = resolveBscExecutionNetwork();

    try {
      const quote = await buildBscTradeQuote({
        walletAddress,
        rpcUrls: rpcReadiness.bscRpcUrls,
        cloudManagedAccess: rpcReadiness.cloudManagedAccess,
        request: {
          side,
          tokenAddress,
          amount,
          slippageBps:
            typeof body.slippageBps === "number" ? body.slippageBps : undefined,
          routeProvider,
        },
      });

      const unsignedTx =
        quote.side === "buy"
          ? buildBscBuyUnsignedTx(
              quote,
              walletAddress,
              typeof body.deadlineSeconds === "number"
                ? body.deadlineSeconds
                : undefined,
            )
          : buildBscSellUnsignedTx(
              quote,
              walletAddress,
              typeof body.deadlineSeconds === "number"
                ? body.deadlineSeconds
                : undefined,
            );

      let unsignedApprovalTx:
        | ReturnType<typeof buildBscApproveUnsignedTx>
        | undefined;
      let requiresApproval = false;
      if (quote.side === "sell" && walletAddress) {
        unsignedApprovalTx = buildBscApproveUnsignedTx(
          quote.tokenAddress,
          walletAddress,
          resolveBscApprovalSpender(quote),
          quote.quoteIn.amountWei,
        );
        requiresApproval = true;
      }

      if (!canSign || !canExecuteLocally || body.confirm !== true) {
        sendJsonResponse(res, 200, {
          ok: true,
          side: quote.side,
          mode: resolveWalletExecutionMode(
            canSign,
            canExecuteLocally,
            hasStewardSigner,
          ),
          quote,
          executed: false,
          requiresUserSignature: true,
          unsignedTx,
          unsignedApprovalTx,
          requiresApproval,
        });
        return true;
      }

      const rpcUrl = resolvePrimaryBscRpcUrl({
        rpcUrls: rpcReadiness.bscRpcUrls,
        cloudManagedAccess: rpcReadiness.cloudManagedAccess,
      });

      let approvalHash: string | undefined;
      let finalHash = "";
      let finalNonce: number | null = null;
      let finalGasLimit = "0";
      let finalMode: "local-key" | "steward" = hasLocalKey
        ? "local-key"
        : "steward";

      if (hasLocalKey && canExecuteLocally) {
        if (!rpcUrl) {
          sendJsonErrorResponse(
            res,
            503,
            "BSC RPC not configured for local execution",
          );
          return true;
        }

        if (requiresApproval && unsignedApprovalTx) {
          const approvalResult = await sendLocalWalletTransaction(rpcUrl, {
            to: unsignedApprovalTx.to,
            data: unsignedApprovalTx.data,
            value: BigInt(unsignedApprovalTx.valueWei),
            chainId: unsignedApprovalTx.chainId,
          });
          approvalHash = approvalResult.hash;
          const provider = new ethers.JsonRpcProvider(rpcUrl);
          try {
            await provider.waitForTransaction(approvalHash, 1);
          } finally {
            provider.destroy();
          }
        }

        const localExecution = await sendLocalWalletTransaction(rpcUrl, {
          to: unsignedTx.to,
          data: unsignedTx.data,
          value: BigInt(unsignedTx.valueWei),
          chainId: unsignedTx.chainId,
        });
        finalHash = localExecution.hash;
        finalNonce = localExecution.nonce;
        finalGasLimit = localExecution.gasLimit;
      } else {
        finalMode = "steward";
        if (requiresApproval && unsignedApprovalTx) {
          const approvalResult = await signTransactionWithOptionalSteward({
            evmAddress: walletAddress,
            tx: {
              to: unsignedApprovalTx.to,
              data: unsignedApprovalTx.data,
              value: unsignedApprovalTx.valueWei,
              chainId: unsignedApprovalTx.chainId,
              broadcast: true,
            },
          });

          if (
            approvalResult.mode === "steward" &&
            approvalResult.pendingApproval
          ) {
            sendJsonResponse(res, 200, {
              ok: true,
              side: quote.side,
              mode: "steward",
              quote,
              executed: false,
              requiresUserSignature: false,
              unsignedTx,
              unsignedApprovalTx,
              requiresApproval,
              approval: {
                status: "pending_approval",
                policyResults: approvalResult.policyResults,
              },
            });
            return true;
          }

          approvalHash =
            "txHash" in approvalResult ? approvalResult.txHash : "";

          if (approvalResult.mode === "steward" && rpcUrl) {
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            try {
              await provider.waitForTransaction(approvalHash, 1);
            } finally {
              provider.destroy();
            }
          }
        }

        const executionResult = await signTransactionWithOptionalSteward({
          evmAddress: walletAddress,
          tx: {
            to: unsignedTx.to,
            data: unsignedTx.data,
            value: unsignedTx.valueWei,
            chainId: unsignedTx.chainId,
            broadcast: true,
          },
        });

        if (
          executionResult.mode === "steward" &&
          executionResult.pendingApproval
        ) {
          sendJsonResponse(res, 200, {
            ok: true,
            side: quote.side,
            mode: "steward",
            quote,
            executed: false,
            requiresUserSignature: false,
            unsignedTx,
            unsignedApprovalTx,
            requiresApproval,
            approvalHash,
            execution: {
              status: "pending_approval",
              policyResults: executionResult.policyResults,
            },
          });
          return true;
        }

        finalHash = "txHash" in executionResult ? executionResult.txHash : "";
      }

      try {
        const tradeSource =
          body.source === "agent" || body.source === "manual"
            ? body.source
            : "manual";

        recordWalletTradeLedgerEntry({
          hash: finalHash,
          source: tradeSource,
          side: quote.side,
          tokenAddress: quote.tokenAddress,
          slippageBps: quote.slippageBps,
          route: quote.route,
          quoteIn: {
            symbol: quote.quoteIn.symbol,
            amount: quote.quoteIn.amount,
            amountWei: quote.quoteIn.amountWei,
          },
          quoteOut: {
            symbol: quote.quoteOut.symbol,
            amount: quote.quoteOut.amount,
            amountWei: quote.quoteOut.amountWei,
          },
          status: "pending",
          confirmations: 0,
          nonce: finalNonce,
          blockNumber: null,
          gasUsed: null,
          effectiveGasPriceWei: null,
          explorerUrl: `${bscExecutionNetwork.explorerBaseUrl}/tx/${finalHash}`,
        });
      } catch (ledgerErr) {
        logger.warn(
          `[api] Failed to record trade ledger entry: ${ledgerErr instanceof Error ? ledgerErr.message : ledgerErr}`,
        );
      }

      sendJsonResponse(res, 200, {
        ok: true,
        side: quote.side,
        mode: finalMode,
        quote,
        executed: true,
        requiresUserSignature: false,
        unsignedTx,
        unsignedApprovalTx,
        requiresApproval,
        execution: {
          hash: finalHash,
          nonce: finalNonce,
          gasLimit: finalGasLimit,
          valueWei: unsignedTx.valueWei,
          explorerUrl: `${bscExecutionNetwork.explorerBaseUrl}/tx/${finalHash}`,
          blockNumber: null,
          status: "pending",
          approvalHash,
        },
      });
    } catch (err) {
      if (isStewardPolicyRejection(err)) {
        sendJsonResponse(res, 403, {
          ok: false,
          mode: "steward",
          executed: false,
          requiresUserSignature: false,
          error: err.message,
          execution: {
            status: "rejected",
            policyResults: getStewardPolicyResults(err),
          },
        });
        return true;
      }

      sendJsonErrorResponse(
        res,
        500,
        `Trade execution failed: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    return true;
  }

  // ── POST /api/wallet/transfer/execute ──────────────────────────────────
  if (method === "POST" && url.pathname === "/api/wallet/transfer/execute") {
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const body = await readCompatJsonBody(req, res);
    if (body == null) {
      return true;
    }

    const toAddressRaw =
      typeof body.toAddress === "string" ? body.toAddress.trim() : "";
    const amount = typeof body.amount === "string" ? body.amount.trim() : "";
    const assetSymbol =
      typeof body.assetSymbol === "string" ? body.assetSymbol.trim() : "";

    if (!toAddressRaw || !amount || !assetSymbol) {
      sendJsonErrorResponse(
        res,
        400,
        "toAddress, amount, and assetSymbol are required",
      );
      return true;
    }

    const config = loadElizaConfig();
    const tradePermissionMode = _resolveTradePermissionMode(config);
    const canExecuteLocally = _canUseLocalTradeExecution(
      tradePermissionMode,
      isAgentAutomationRequest(req),
    );
    const hasLocalKey = Boolean(process.env.EVM_PRIVATE_KEY?.trim());
    const hasStewardSigner = isStewardConfigured();
    const canSign = hasLocalKey || hasStewardSigner;
    const addresses = getWalletAddresses();
    const rpcReadiness = resolveWalletRpcReadiness(config);
    const bscExecutionNetwork = resolveBscExecutionNetwork();

    let toAddress: string;
    try {
      toAddress = ethers.getAddress(toAddressRaw);
    } catch {
      sendJsonErrorResponse(
        res,
        400,
        "Invalid toAddress — must be a valid EVM address",
      );
      return true;
    }

    const isBnb = assetSymbol.toUpperCase() === "BNB";
    let decimals = 18;
    if (typeof body.tokenAddress === "string" && body.tokenAddress.trim()) {
      const provider = new ethers.JsonRpcProvider(
        resolvePrimaryBscRpcUrl({
          rpcUrls: rpcReadiness.bscRpcUrls,
          cloudManagedAccess: rpcReadiness.cloudManagedAccess,
        }) ?? "https://bsc-dataseed1.binance.org/",
      );
      try {
        const tokenContract = new ethers.Contract(
          body.tokenAddress,
          ["function decimals() view returns (uint8)"],
          provider,
        );
        decimals = Number(await tokenContract.decimals());
      } finally {
        provider.destroy();
      }
    }

    const unsignedTx = {
      chainId: bscExecutionNetwork.chainId,
      from: addresses.evmAddress ?? null,
      to:
        isBnb || typeof body.tokenAddress !== "string"
          ? toAddress
          : body.tokenAddress,
      data: isBnb
        ? "0x"
        : new ethers.Interface([
            "function transfer(address to, uint256 amount) returns (bool)",
          ]).encodeFunctionData("transfer", [
            toAddress,
            ethers.parseUnits(amount, decimals),
          ]),
      valueWei: isBnb ? ethers.parseEther(amount).toString() : "0",
      explorerUrl: bscExecutionNetwork.explorerBaseUrl,
      assetSymbol,
      amount,
      tokenAddress:
        typeof body.tokenAddress === "string" ? body.tokenAddress : undefined,
    };

    if (!canSign || !canExecuteLocally || body.confirm !== true) {
      sendJsonResponse(res, 200, {
        ok: true,
        mode: resolveWalletExecutionMode(
          canSign,
          canExecuteLocally,
          hasStewardSigner,
        ),
        executed: false,
        requiresUserSignature: true,
        toAddress,
        amount,
        assetSymbol,
        tokenAddress: unsignedTx.tokenAddress,
        unsignedTx,
      });
      return true;
    }

    const _rpcUrl = resolvePrimaryBscRpcUrl({
      rpcUrls: rpcReadiness.bscRpcUrls,
      cloudManagedAccess: rpcReadiness.cloudManagedAccess,
    });

    try {
      let finalHash = "";
      let finalNonce: number | null = null;
      let finalGasLimit = "0";
      let finalMode: "local-key" | "steward" = hasLocalKey
        ? "local-key"
        : "steward";

      if (hasLocalKey && canExecuteLocally) {
        if (!_rpcUrl) {
          sendJsonErrorResponse(
            res,
            503,
            "BSC RPC not configured for local execution",
          );
          return true;
        }

        const localExecution = await sendLocalWalletTransaction(_rpcUrl, {
          to: unsignedTx.to,
          data: unsignedTx.data,
          value: BigInt(unsignedTx.valueWei),
          chainId: unsignedTx.chainId,
        });
        finalHash = localExecution.hash;
        finalNonce = localExecution.nonce;
        finalGasLimit = localExecution.gasLimit;
      } else {
        finalMode = "steward";
        const executionResult = await signTransactionWithOptionalSteward({
          evmAddress: addresses.evmAddress,
          tx: {
            to: unsignedTx.to,
            data: unsignedTx.data,
            value: unsignedTx.valueWei,
            chainId: unsignedTx.chainId,
            broadcast: true,
          },
        });

        if (
          executionResult.mode === "steward" &&
          executionResult.pendingApproval
        ) {
          sendJsonResponse(res, 200, {
            ok: true,
            mode: "steward",
            executed: false,
            requiresUserSignature: false,
            toAddress,
            amount,
            assetSymbol,
            tokenAddress: unsignedTx.tokenAddress,
            unsignedTx,
            execution: {
              status: "pending_approval",
              policyResults: executionResult.policyResults,
            },
          });
          return true;
        }

        finalHash = "txHash" in executionResult ? executionResult.txHash : "";
      }

      sendJsonResponse(res, 200, {
        ok: true,
        mode: finalMode,
        executed: true,
        requiresUserSignature: false,
        toAddress,
        amount,
        assetSymbol,
        tokenAddress: unsignedTx.tokenAddress,
        unsignedTx,
        execution: {
          hash: finalHash,
          nonce: finalNonce,
          gasLimit: finalGasLimit,
          valueWei: unsignedTx.valueWei,
          explorerUrl: `${bscExecutionNetwork.explorerBaseUrl}/tx/${finalHash}`,
          blockNumber: null,
          status: "pending",
        },
      });
    } catch (err) {
      if (isStewardPolicyRejection(err)) {
        sendJsonResponse(res, 403, {
          ok: false,
          mode: "steward",
          executed: false,
          requiresUserSignature: false,
          error: err.message,
          execution: {
            status: "rejected",
            policyResults: getStewardPolicyResults(err),
          },
        });
        return true;
      }

      sendJsonErrorResponse(
        res,
        500,
        `Transfer failed: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    return true;
  }

  return false;
}
