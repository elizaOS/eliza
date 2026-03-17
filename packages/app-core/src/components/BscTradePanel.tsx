/**
 * Quick-trade panel — token address input, amount presets, buy/sell,
 * quote display, execution confirmation, and tx status tracking.
 *
 * Extracted from InventoryView to keep that component focused on
 * portfolio display and chain navigation.
 */

import type {
  BscTradeExecuteRequest,
  BscTradeExecuteResponse,
  BscTradePreflightResponse,
  BscTradeQuoteRequest,
  BscTradeQuoteResponse,
  BscTradeTxStatusResponse,
} from "@elizaos/app-core/api";
import { useApp } from "@elizaos/app-core/state";
import { Button, Input } from "@elizaos/ui";
import { useCallback, useState } from "react";
import { HEX_ADDRESS_RE } from "./companion/walletUtils";
import { formatBalance, type TrackedToken } from "./inventory/constants";

/* ── Constants ─────────────────────────────────────────────────────── */

const AMOUNT_PRESETS = [0.05, 0.1, 0.2, 0.5];
const DEFAULT_QUICK_AMOUNT = "0.1";

export interface TradePanelProps {
  tradeReady: boolean;
  bnbBalance: number;
  onAddToken: (token: TrackedToken) => void;
  getBscTradePreflight?: (
    tokenAddress?: string,
  ) => Promise<BscTradePreflightResponse>;
  getBscTradeQuote?: (
    request: BscTradeQuoteRequest,
  ) => Promise<BscTradeQuoteResponse>;
  executeBscTrade?: (
    request: BscTradeExecuteRequest,
  ) => Promise<BscTradeExecuteResponse>;
  getBscTradeTxStatus?: (hash: string) => Promise<BscTradeTxStatusResponse>;
}

/* ── Component ─────────────────────────────────────────────────────── */

export function TradePanel({
  tradeReady,
  bnbBalance,
  onAddToken,
  getBscTradePreflight,
  getBscTradeQuote,
  executeBscTrade,
  getBscTradeTxStatus,
}: TradePanelProps) {
  const { t, copyToClipboard, setActionNotice } = useApp();
  const [quickTokenAddress, setQuickTokenAddress] = useState("");
  const [quickAmount, setQuickAmount] = useState(DEFAULT_QUICK_AMOUNT);
  const [latestQuote, setLatestQuote] = useState<BscTradeQuoteResponse | null>(
    null,
  );
  const [latestExecution, setLatestExecution] =
    useState<BscTradeExecuteResponse | null>(null);
  const [txStatus, setTxStatus] = useState<BscTradeTxStatusResponse | null>(
    null,
  );
  const [tradeFeedback, setTradeFeedback] = useState<{
    tone: "error" | "info" | "success";
    text: string;
  } | null>(null);
  const [quoteSide, setQuoteSide] = useState<"buy" | "sell">("buy");
  const [pendingTrade, setPendingTrade] = useState<{
    side: string;
    amount: string;
    token: string;
  } | null>(null);

  // ── Trade handlers ──────────────────────────────────────────────────

  const requestQuote = useCallback(
    async (side: "buy" | "sell") => {
      if (!getBscTradeQuote) return;
      const tokenAddress = quickTokenAddress.trim();
      if (!HEX_ADDRESS_RE.test(tokenAddress)) {
        setActionNotice(
          "Enter a valid token contract address first.",
          "error",
          3200,
        );
        setTradeFeedback({
          tone: "error",
          text: "Enter a valid token contract address first.",
        });
        return;
      }
      const amount = quickAmount.trim() || DEFAULT_QUICK_AMOUNT;
      const amountNum = Number.parseFloat(amount);
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        setActionNotice("Enter a valid BNB amount first.", "error", 3200);
        setTradeFeedback({
          tone: "error",
          text: "Enter a valid BNB amount first.",
        });
        return;
      }

      setQuoteSide(side);
      try {
        if (getBscTradePreflight) {
          const preflight = await getBscTradePreflight(tokenAddress);
          if (!preflight.ok) {
            setLatestQuote(null);
            setLatestExecution(null);
            setTxStatus(null);
            setPendingTrade(null);
            setActionNotice(
              preflight.reasons[0] ?? "Preflight checks failed.",
              "error",
              3600,
            );
            setTradeFeedback({
              tone: "error",
              text: preflight.reasons[0] ?? "Preflight checks failed.",
            });
            return;
          }
        }

        const result = await getBscTradeQuote({
          side,
          tokenAddress,
          amount,
        });
        setLatestQuote(result);
        setLatestExecution(null);
        setTxStatus(null);
        setPendingTrade(null);
        setActionNotice(
          `${side === "buy" ? "Quote ready" : "Sell quote ready"}: ${result.quoteOut?.amount ?? ""} ${result.quoteOut?.symbol ?? ""}`.trim(),
          "success",
          3200,
        );
        setTradeFeedback({
          tone: "success",
          text: `${side === "buy" ? "Quote ready" : "Sell quote ready"}: ${result.quoteOut?.amount ?? ""} ${result.quoteOut?.symbol ?? ""}`.trim(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setActionNotice(message, "error", 4600);
        setTradeFeedback({
          tone: "error",
          text: message,
        });
      }
    },
    [
      getBscTradePreflight,
      getBscTradeQuote,
      quickAmount,
      quickTokenAddress,
      setActionNotice,
    ],
  );

  const handlePreflight = useCallback(async () => {
    if (!getBscTradePreflight) return;
    const tokenAddress = quickTokenAddress.trim();
    if (tokenAddress && !HEX_ADDRESS_RE.test(tokenAddress)) {
      setActionNotice(
        "Enter a valid token contract address first.",
        "error",
        3200,
      );
      setTradeFeedback({
        tone: "error",
        text: "Enter a valid token contract address first.",
      });
      return;
    }
    try {
      const result = await getBscTradePreflight(tokenAddress || undefined);
      if (!result.ok) {
        setActionNotice(
          result.reasons[0] ?? "Preflight checks failed.",
          "error",
          3600,
        );
        setTradeFeedback({
          tone: "error",
          text: result.reasons[0] ?? "Preflight checks failed.",
        });
        return;
      }
      const message = tokenAddress
        ? "Preflight checks passed."
        : "Wallet is ready for BSC trading checks.";
      setActionNotice(message, "success", 2600);
      setTradeFeedback({
        tone: "success",
        text: message,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setActionNotice(message, "error", 4600);
      setTradeFeedback({
        tone: "error",
        text: message,
      });
    }
  }, [getBscTradePreflight, quickTokenAddress, setActionNotice]);

  const handleQuickBuy = useCallback(
    async () => requestQuote("buy"),
    [requestQuote],
  );

  const handleQuickSell = useCallback(
    async () => requestQuote("sell"),
    [requestQuote],
  );

  const handleToolbarQuote = useCallback(async () => {
    await requestQuote(quoteSide);
  }, [quoteSide, requestQuote]);

  const handleRequestExecute = useCallback(() => {
    if (!latestQuote) return;
    setPendingTrade({
      side: latestQuote.side,
      amount: quickAmount,
      token: quickTokenAddress,
    });
  }, [latestQuote, quickAmount, quickTokenAddress]);

  const handleConfirmExecute = useCallback(async () => {
    if (!executeBscTrade || !pendingTrade || !latestQuote) return;
    setPendingTrade(null);
    try {
      const result = await executeBscTrade({
        side: latestQuote.side,
        tokenAddress: pendingTrade.token,
        amount: pendingTrade.amount,
      });
      setLatestExecution(result);
      if (result?.executed && result?.execution) {
        // Already executed on-chain
      } else if (result?.requiresUserSignature) {
        setActionNotice(
          "Sign swap transaction in your wallet to complete the trade.",
          "info",
          4600,
        );
      }
    } catch (err) {
      setActionNotice(
        err instanceof Error ? err.message : String(err),
        "error",
        4600,
      );
    }
  }, [executeBscTrade, pendingTrade, latestQuote, setActionNotice]);

  const handleCancelExecute = useCallback(() => {
    setPendingTrade(null);
  }, []);

  const handleRefreshTxStatus = useCallback(async () => {
    if (!getBscTradeTxStatus || !latestExecution) return;
    const hash = latestExecution.execution?.hash;
    if (!hash) return;
    const status = await getBscTradeTxStatus(hash);
    setTxStatus(status);
  }, [getBscTradeTxStatus, latestExecution]);

  const handleAddToken = useCallback(() => {
    if (!HEX_ADDRESS_RE.test(quickTokenAddress)) return;
    const newToken: TrackedToken = {
      address: quickTokenAddress,
      symbol: `TKN-${quickTokenAddress.slice(2, 6)}`,
      addedAt: Date.now(),
    };
    onAddToken(newToken);
    setActionNotice("Token added to watchlist.", "success", 2600);
  }, [quickTokenAddress, onAddToken, setActionNotice]);

  // ── Render helpers ──────────────────────────────────────────────────

  function renderExecutionResult() {
    if (!latestExecution) return null;

    if (latestExecution.executed && latestExecution.execution) {
      const { hash, status, explorerUrl } = latestExecution.execution;
      const shortHash = hash ? `${hash.slice(0, 10)}` : "";

      return (
        <div className="border border-border p-2 text-xs space-y-1">
          <div>
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-txt"
            >
              {t("bsctradepanel.ViewTx")} {shortHash}
            </a>
          </div>
          {status === "pending" && (
            <div className="flex items-center gap-2">
              <span className="text-yellow-500">
                {t("bsctradepanel.Pending")}
              </span>
              <Button
                variant="outline"
                size="sm"
                data-testid="wallet-tx-refresh"
                className="h-6 px-2 py-0.5 text-[10px] font-mono shadow-sm hover:border-accent"
                onClick={handleRefreshTxStatus}
              >
                {t("bsctradepanel.RefreshStatus")}
              </Button>
            </div>
          )}
          {txStatus && (
            <div className="text-muted">
              {t("bsctradepanel.Confirmations")} {txStatus.confirmations ?? 0}
            </div>
          )}
        </div>
      );
    }

    if (latestExecution.requiresUserSignature) {
      return (
        <div className="border border-border p-2 text-xs space-y-1">
          <div className="text-yellow-500">
            {t("bsctradepanel.RequiresWalletSign")}
          </div>
          {latestExecution.unsignedApprovalTx && (
            <Button
              variant="outline"
              size="sm"
              data-testid="wallet-copy-approve-tx"
              className="h-6 px-2 py-0.5 text-[10px] font-mono shadow-sm hover:border-accent"
              onClick={() =>
                copyToClipboard(
                  JSON.stringify(latestExecution.unsignedApprovalTx),
                )
              }
            >
              {t("bsctradepanel.CopyApprovalTX")}
            </Button>
          )}
          {latestExecution.unsignedTx && (
            <Button
              variant="outline"
              size="sm"
              data-testid="wallet-copy-swap-tx"
              className="h-6 px-2 py-0.5 text-[10px] font-mono shadow-sm hover:border-accent"
              onClick={() =>
                copyToClipboard(JSON.stringify(latestExecution.unsignedTx))
              }
            >
              {t("bsctradepanel.CopySwapTX")}
            </Button>
          )}
        </div>
      );
    }

    return null;
  }

  // ── Main render ─────────────────────────────────────────────────────

  return (
    <>
      {/* Status bar */}
      <div className="flex items-center gap-2 text-xs">
        <span className={tradeReady ? "text-green-500" : "text-yellow-500"}>
          {tradeReady ? "Trade Ready" : "Trade Not Ready"}
        </span>
        <span className="text-muted">
          {t("bsctradepanel.BNB")} {formatBalance(String(bnbBalance))}
        </span>
        {getBscTradePreflight && (
          <Button
            variant="outline"
            size="sm"
            data-testid="wallet-token-preflight"
            className="h-6 px-2 py-0.5 text-[10px] font-mono shadow-sm hover:border-accent"
            onClick={() => {
              void handlePreflight();
            }}
          >
            {t("bsctradepanel.Preflight")}
          </Button>
        )}
        {getBscTradeQuote && (
          <Button
            variant="outline"
            size="sm"
            data-testid="wallet-token-quote"
            className="h-6 px-2 py-0.5 text-[10px] font-mono shadow-sm hover:border-accent"
            onClick={() => {
              void handleToolbarQuote();
            }}
          >
            {t("bsctradepanel.Quote")}
          </Button>
        )}
      </div>

      {tradeFeedback && (
        <div
          data-testid="wallet-trade-feedback"
          className={`border px-2 py-1.5 text-xs ${
            tradeFeedback.tone === "success"
              ? "border-green-500/40 text-green-400"
              : tradeFeedback.tone === "info"
                ? "border-accent/40 text-txt"
                : "border-red-500/40 text-red-400"
          }`}
        >
          {tradeFeedback.text}
        </div>
      )}

      {/* Quick trade panel */}
      <div className="border border-border bg-card p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Input
            data-testid="wallet-quick-token-input"
            placeholder={t("bsctradepanel.TokenContractAddre")}
            value={quickTokenAddress}
            onChange={(e) => setQuickTokenAddress(e.target.value)}
            className="flex-1 h-8 px-2 py-1 text-xs font-mono bg-bg border-border shadow-sm focus-visible:ring-1 focus-visible:ring-accent"
          />
          <Button
            variant="outline"
            size="sm"
            data-testid="wallet-quick-add-token"
            className="h-8 px-2 py-1 text-[10px] font-mono shadow-sm hover:border-accent"
            onClick={handleAddToken}
          >
            {t("secretsview.Add")}
          </Button>
        </div>

        <div className="flex items-center gap-1.5">
          {AMOUNT_PRESETS.map((amt) => (
            <button
              key={amt}
              type="button"
              data-testid={`wallet-quick-amount-${amt}`}
              className={`px-2 py-0.5 border text-[10px] font-mono cursor-pointer ${
                quickAmount === String(amt)
                  ? "border-accent text-txt"
                  : "border-border bg-bg hover:border-accent"
              }`}
              onClick={() => setQuickAmount(String(amt))}
            >
              {amt} {t("bsctradepanel.BNB1")}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="wallet-quick-buy"
            className="h-8 px-3 py-1 text-xs font-mono text-green-500 border-green-500 hover:bg-green-500 hover:text-white shadow-sm"
            onClick={() => {
              void handleQuickBuy();
            }}
          >
            {t("bsctradepanel.Buy")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="wallet-quick-sell"
            className="h-8 px-3 py-1 text-xs font-mono text-red-500 border-red-500 hover:bg-red-500 hover:text-white shadow-sm"
            onClick={() => {
              void handleQuickSell();
            }}
          >
            {t("bsctradepanel.Sell")}
          </Button>
        </div>

        {/* Latest quote display */}
        {latestQuote && (
          <div className="border border-border p-2 text-xs">
            <div className="font-bold mb-1">
              {t("bsctradepanel.LatestQuote")}
            </div>
            <div className="text-muted">
              {latestQuote.side === "buy" ? "Buy" : "Sell"}{" "}
              {latestQuote.quoteOut?.amount ?? ""}{" "}
              {latestQuote.quoteOut?.symbol ?? ""}
            </div>
            {pendingTrade ? (
              <div className="mt-1 flex items-center gap-2">
                <span className="text-yellow-500 font-bold">
                  {t("onboarding.confirm")} {pendingTrade.side}{" "}
                  {t("bsctradepanel.trade")}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="wallet-quote-confirm"
                  className="h-7 px-3 py-1 text-[10px] font-mono text-green-500 border-green-500 hover:bg-green-500 hover:text-white shadow-sm"
                  onClick={handleConfirmExecute}
                >
                  {t("onboarding.confirm")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="wallet-quote-cancel"
                  className="h-7 px-3 py-1 text-[10px] font-mono text-muted border-border hover:border-danger hover:text-danger shadow-sm"
                  onClick={handleCancelExecute}
                >
                  {t("onboarding.cancel")}
                </Button>
              </div>
            ) : (
              <Button
                variant="default"
                size="sm"
                data-testid="wallet-quote-execute"
                className="mt-1 h-7 px-3 py-1 text-[10px] font-mono shadow-sm"
                onClick={handleRequestExecute}
              >
                {t("bsctradepanel.ExecuteTrade")}
              </Button>
            )}
          </div>
        )}

        {/* Execution result */}
        {latestExecution && renderExecutionResult()}
      </div>
    </>
  );
}

export type { TradePanelProps as BscTradePanelProps };
export { TradePanel as BscTradePanel };
