import { StewardLogo } from "@elizaos/app-steward/StewardLogo";
import type {
  BscTradeExecuteRequest,
  BscTradeExecuteResponse,
  BscTradePreflightResponse,
  BscTradeQuoteRequest,
  BscTradeQuoteResponse,
  BscTradeTxStatusResponse,
  StewardPolicyResult,
} from "@elizaos/shared/contracts/wallet";
import { Button, Input } from "@elizaos/ui";
import { useCallback, useState } from "react";
import { useApp } from "../../state/useApp";
import { formatBalance, HEX_ADDRESS_RE, type TrackedToken } from "./constants";

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
  /** When true, trades are routed through Steward vault for policy enforcement. */
  stewardConnected?: boolean;
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
  stewardConnected,
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
          t("bsctradepanel.EnterValidTokenAddress"),
          "error",
          3200,
        );
        setTradeFeedback({
          tone: "error",
          text: t("bsctradepanel.EnterValidTokenAddress"),
        });
        return;
      }
      const amount = quickAmount.trim() || DEFAULT_QUICK_AMOUNT;
      const amountNum = Number.parseFloat(amount);
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        setActionNotice(t("bsctradepanel.EnterValidBnbAmount"), "error", 3200);
        setTradeFeedback({
          tone: "error",
          text: t("bsctradepanel.EnterValidBnbAmount"),
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
              preflight.reasons[0] ?? t("bsctradepanel.PreflightChecksFailed"),
              "error",
              3600,
            );
            setTradeFeedback({
              tone: "error",
              text:
                preflight.reasons[0] ??
                t("bsctradepanel.PreflightChecksFailed"),
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
        const quoteMessage = t(
          side === "buy"
            ? "bsctradepanel.QuoteReady"
            : "bsctradepanel.SellQuoteReady",
          {
            amount: result.quoteOut?.amount ?? "",
            symbol: result.quoteOut?.symbol ?? "",
          },
        ).trim();
        setActionNotice(quoteMessage, "success", 3200);
        setTradeFeedback({
          tone: "success",
          text: quoteMessage,
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
      t,
    ],
  );

  const handlePreflight = useCallback(async () => {
    if (!getBscTradePreflight) return;
    const tokenAddress = quickTokenAddress.trim();
    if (tokenAddress && !HEX_ADDRESS_RE.test(tokenAddress)) {
      setActionNotice(t("bsctradepanel.EnterValidTokenAddress"), "error", 3200);
      setTradeFeedback({
        tone: "error",
        text: t("bsctradepanel.EnterValidTokenAddress"),
      });
      return;
    }
    try {
      const result = await getBscTradePreflight(tokenAddress || undefined);
      if (!result.ok) {
        setActionNotice(
          result.reasons[0] ?? t("bsctradepanel.PreflightChecksFailed"),
          "error",
          3600,
        );
        setTradeFeedback({
          tone: "error",
          text: result.reasons[0] ?? t("bsctradepanel.PreflightChecksFailed"),
        });
        return;
      }
      const message = tokenAddress
        ? t("bsctradepanel.PreflightChecksPassed")
        : t("bsctradepanel.WalletReadyForBscTradingChecks");
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
  }, [getBscTradePreflight, quickTokenAddress, setActionNotice, t]);

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
        routeProvider: latestQuote.routeProvider,
      });
      setLatestExecution(result);
      if (result?.executed && result?.execution) {
        if (result.mode === "steward") {
          setActionNotice(
            t("bsctradepanel.TradeSignedViaStewardVault"),
            "success",
            4600,
          );
        }
      } else if (result?.mode === "steward" && !result?.requiresUserSignature) {
        // Steward pending approval or rejection
        const execStatus = result.execution?.status;
        if (
          result.approval?.status === "pending_approval" ||
          execStatus === "pending_approval"
        ) {
          setActionNotice(
            t("bsctradepanel.WaitingForStewardApproval"),
            "info",
            6000,
          );
        } else if (!result.ok || execStatus === "rejected") {
          const reason =
            result.execution?.policyResults?.find((p) => p.reason)?.reason ??
            result.error ??
            t("bsctradepanel.PolicyRejected");
          setActionNotice(
            t("bsctradepanel.StewardPolicyRejected", { reason }),
            "error",
            6000,
          );
        }
      } else if (result?.requiresUserSignature) {
        setActionNotice(
          t("bsctradepanel.SignSwapTransactionInWallet"),
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
  }, [executeBscTrade, pendingTrade, latestQuote, setActionNotice, t]);

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
    setActionNotice(t("bsctradepanel.TokenAddedToWatchlist"), "success", 2600);
  }, [quickTokenAddress, onAddToken, setActionNotice, t]);

  // ── Render helpers ──────────────────────────────────────────────────

  function renderPolicyResults(policyResults?: StewardPolicyResult[]) {
    if (!policyResults?.length) return null;
    return (
      <div className="mt-1 space-y-0.5">
        {policyResults.map((p) => (
          <div
            key={p.policyId ?? p.name ?? p.status}
            className="text-muted text-2xs"
          >
            {p.name && <span className="font-mono">{p.name}: </span>}
            <span
              className={
                p.status === "rejected"
                  ? "text-status-danger"
                  : "text-[color:var(--warn,var(--accent))]"
              }
            >
              {p.status}
            </span>
            {p.reason && <span> — {p.reason}</span>}
          </div>
        ))}
      </div>
    );
  }

  function renderExecutionResult() {
    if (!latestExecution) return null;

    if (latestExecution.executed && latestExecution.execution) {
      const { hash, status, explorerUrl } = latestExecution.execution;
      const shortHash = hash ? `${hash.slice(0, 10)}` : "";

      return (
        <div className="border border-border p-2 text-xs space-y-1">
          <div className="flex items-center gap-1">
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-txt"
            >
              {t("bsctradepanel.ViewTx")} {shortHash}
            </a>
            {latestExecution.mode === "steward" && (
              <span className="text-2xs text-purple-400 ml-1">🔐 Steward</span>
            )}
          </div>
          {status === "pending" && (
            <div className="flex items-center gap-2">
              <span className="text-[color:var(--warn,var(--accent))]">
                {t("bsctradepanel.Pending")}
              </span>
              <Button
                variant="outline"
                size="sm"
                data-testid="wallet-tx-refresh"
                className="h-6 px-2 py-0.5 text-2xs font-mono shadow-sm hover:border-accent"
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

    // Steward: pending approval
    if (
      latestExecution.mode === "steward" &&
      !latestExecution.requiresUserSignature &&
      !latestExecution.executed
    ) {
      const execStatus = latestExecution.execution?.status;
      const isPending =
        latestExecution.approval?.status === "pending_approval" ||
        execStatus === "pending_approval";
      const isRejected = !latestExecution.ok || execStatus === "rejected";

      if (isPending) {
        return (
          <div className="border border-border p-2 text-xs space-y-1">
            <div className="flex items-center gap-1 text-[color:var(--warn,var(--accent))]">
              <span>🔐</span>
              <span>{t("bsctradepanel.WaitingForStewardPolicyApproval")}</span>
            </div>
            {renderPolicyResults(
              latestExecution.approval?.policyResults ??
                latestExecution.execution?.policyResults,
            )}
          </div>
        );
      }

      if (isRejected) {
        return (
          <div className="border border-border p-2 text-xs space-y-1">
            <div className="flex items-center gap-1 text-status-danger">
              <span>🚫</span>
              <span>{t("bsctradepanel.StewardPolicyRejectedTransaction")}</span>
            </div>
            {latestExecution.error && (
              <div className="text-muted">{latestExecution.error}</div>
            )}
            {renderPolicyResults(latestExecution.execution?.policyResults)}
          </div>
        );
      }
    }

    if (latestExecution.requiresUserSignature) {
      return (
        <div className="border border-border p-2 text-xs space-y-1">
          <div className="text-[color:var(--warn,var(--accent))]">
            {t("bsctradepanel.RequiresWalletSign")}
          </div>
          {latestExecution.unsignedApprovalTx && (
            <Button
              variant="outline"
              size="sm"
              data-testid="wallet-copy-approve-tx"
              className="h-6 px-2 py-0.5 text-2xs font-mono shadow-sm hover:border-accent"
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
              className="h-6 px-2 py-0.5 text-2xs font-mono shadow-sm hover:border-accent"
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
        <span
          className={
            tradeReady
              ? "text-status-success"
              : "text-[color:var(--warn,var(--accent))]"
          }
        >
          {tradeReady
            ? t("bsctradepanel.TradeReady")
            : t("bsctradepanel.TradeNotReady")}
        </span>
        {stewardConnected && (
          <span
            data-testid="steward-trade-indicator"
            className="text-purple-400 flex items-center gap-0.5"
            title="Trades routed through Steward vault policy enforcement"
          >
            <StewardLogo size={14} className="inline-block" /> Steward
          </span>
        )}
        <span className="text-muted">
          {t("bsctradepanel.BNB")} {formatBalance(String(bnbBalance))}
        </span>
        {getBscTradePreflight && (
          <Button
            variant="outline"
            size="sm"
            data-testid="wallet-token-preflight"
            className="h-6 px-2 py-0.5 text-2xs font-mono shadow-sm hover:border-accent"
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
            className="h-6 px-2 py-0.5 text-2xs font-mono shadow-sm hover:border-accent"
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
              ? "border-status-success/40 text-status-success"
              : tradeFeedback.tone === "info"
                ? "border-accent/40 text-txt"
                : "border-status-danger/40 text-status-danger"
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
            className="h-8 px-2 py-1 text-2xs font-mono shadow-sm hover:border-accent"
            onClick={handleAddToken}
          >
            {t("secretsview.Add")}
          </Button>
        </div>

        <div className="flex items-center gap-1.5">
          {AMOUNT_PRESETS.map((amt) => (
            <Button
              key={amt}
              variant="outline"
              size="sm"
              data-testid={`wallet-quick-amount-${amt}`}
              className={`px-2 py-0.5 text-2xs font-mono cursor-pointer ${
                quickAmount === String(amt)
                  ? "border-accent text-txt"
                  : "border-border bg-bg hover:border-accent"
              }`}
              onClick={() => setQuickAmount(String(amt))}
            >
              {amt} {t("bsctradepanel.BNB1")}
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="wallet-quick-buy"
            className="h-8 px-3 py-1 text-xs font-mono text-ok border-ok hover:bg-ok hover:text-white shadow-sm"
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
            className="h-8 px-3 py-1 text-xs font-mono text-danger border-danger hover:bg-danger hover:text-white shadow-sm"
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
              {latestQuote.side === "buy"
                ? t("bsctradepanel.Buy")
                : t("bsctradepanel.Sell")}{" "}
              {latestQuote.quoteOut?.amount ?? ""}{" "}
              {latestQuote.quoteOut?.symbol ?? ""}
            </div>
            {latestQuote.routeProvider && (
              <div className="text-2xs text-muted mt-0.5">
                Route: {latestQuote.routeProvider}
                {latestQuote.routeProviderFallbackUsed && (
                  <span className="text-[color:var(--warn,var(--accent))] ml-1">
                    (fallback from {latestQuote.routeProviderRequested})
                  </span>
                )}
              </div>
            )}
            {latestQuote.routeProviderNotes?.length ? (
              <div className="text-2xs text-muted mt-0.5">
                {latestQuote.routeProviderNotes.join("; ")}
              </div>
            ) : null}
            {pendingTrade ? (
              <div className="mt-1 flex items-center gap-2">
                <span className="font-bold text-[color:var(--warn,var(--accent))]">
                  {t("bsctradepanel.ConfirmTrade", {
                    side:
                      pendingTrade.side === "buy"
                        ? t("bsctradepanel.Buy")
                        : t("bsctradepanel.Sell"),
                  })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="wallet-quote-confirm"
                  className="h-7 px-3 py-1 text-2xs font-mono text-ok border-ok hover:bg-ok hover:text-white shadow-sm"
                  onClick={handleConfirmExecute}
                >
                  {t("onboarding.confirm")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="wallet-quote-cancel"
                  className="h-7 px-3 py-1 text-2xs font-mono text-muted border-border hover:border-danger hover:text-danger shadow-sm"
                  onClick={handleCancelExecute}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            ) : (
              <Button
                variant="default"
                size="sm"
                data-testid="wallet-quote-execute"
                className="mt-1 h-7 px-3 py-1 text-2xs font-mono shadow-sm"
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
