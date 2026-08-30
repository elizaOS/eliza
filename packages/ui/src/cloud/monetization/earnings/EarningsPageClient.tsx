/**
 * Earnings & Redemptions client. Network marks are brand-neutral inline dots
 * (`@web3icons/react` is not a dependency of `@elizaos/ui`).
 *
 * Data: GET `/api/v1/redemptions/balance`, GET `/api/v1/redemptions?limit=10`,
 * GET `/api/v1/redemptions/status`, GET `/api/v1/redemptions/quote`, POST
 * `/api/v1/redemptions`.
 */

"use client";

import {
  type CreateRedemptionResponse,
  canonicalizeRedemptionNetwork,
  type ListRedemptionsResponse,
  REDEMPTION_EVM_SIGNATURE_THRESHOLD_POINTS,
  REDEMPTION_MAX_POINTS,
  REDEMPTION_MIN_POINTS,
  REDEMPTION_POINTS_PER_USD,
  type RedemptionListItem,
  type RedemptionNetwork,
  type RedemptionQuoteResponse,
  type RedemptionStatusResponse,
} from "@elizaos/cloud-sdk/redemption-contract";
import {
  AlertTriangle,
  AppWindow,
  ArrowRight,
  Bot,
  CheckCircle,
  Clock,
  Coins,
  ExternalLink,
  Info,
  RefreshCw,
  Server,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  // Deep primitive/brand imports per the packages/ui extension rules — the
  // root cloud-ui barrel would drag the entire kit into this chunk graph.
} from "../../../cloud-ui/components/primitives";
import { Alert } from "../../../components/ui/alert";
import { Card } from "../../../components/ui/card";
import { api } from "../../lib/api-client";
import { formatUsd as formatCurrency } from "../../lib/format-usd";
import { useCloudT } from "../../shell/CloudI18nProvider";
import {
  buildCreateRedemptionRequest,
  buildRedemptionQuotePath,
  ceilRedemptionUsdToPoints,
  createRedemptionIdempotencyKey,
  floorRedemptionUsdToPoints,
  isRedemptionQuoteExpired,
  parseRedemptionUsdToPoints,
  quoteMatchesRedemptionRequest,
} from "./redemption-client-contract";

type TFn = ReturnType<typeof useCloudT>;

interface BalanceData {
  balance: {
    totalEarned: number;
    availableBalance: number;
    pendingBalance: number;
    totalRedeemed: number;
    totalPending: number;
    totalConvertedToCredits: number;
  };
  bySource: Array<{
    source: "miniapp" | "agent" | "mcp";
    totalEarned: number;
    count: number;
  }>;
  recentEarnings: Array<{
    id: string;
    source: "miniapp" | "agent" | "mcp";
    sourceId: string;
    amount: number;
    description: string;
    createdAt: string;
  }>;
  limits: {
    minRedemptionUsd: number;
    maxSingleRedemptionUsd: number;
    userDailyLimitUsd: number;
    userHourlyLimitUsd: number;
  };
  eligibility: {
    canRedeem: boolean;
    reason?: string;
    cooldownEndsAt?: string;
    dailyLimitRemaining?: number;
  };
}

/**
 * Network options for the redemption payout. The original rendered branded
 * `@web3icons/react` marks; we keep colored dots so the selector works without
 * that (undeclared) dependency. `dotClass` uses the tokenized chain-brand
 * colors (`--color-chain-*`) — the one legitimate brand-hex exception in views.
 */
const NETWORKS: Array<{
  value: RedemptionNetwork;
  label: string;
  indicatorColor: string;
}> = [
  { value: "base", label: "Base", indicatorColor: "var(--color-chain-base)" },
  {
    value: "solana",
    label: "Solana",
    indicatorColor: "var(--color-chain-sol)",
  },
  {
    value: "ethereum",
    label: "Ethereum",
    indicatorColor: "var(--color-chain-eth)",
  },
  {
    value: "bnb",
    label: "BNB Chain",
    indicatorColor: "var(--color-chain-bsc)",
  },
];

const SOURCE_ICONS = {
  miniapp: AppWindow,
  agent: Bot,
  mcp: Server,
};

const buildSourceLabels = (t: TFn): Record<string, string> => ({
  miniapp: t("cloud.earnings.sourceApps", { defaultValue: "Apps" }),
  agent: t("cloud.earnings.sourceAgents", { defaultValue: "Agents" }),
  mcp: t("cloud.earnings.sourceMcps", { defaultValue: "MCPs" }),
});

const STATUS_VARIANTS: Record<
  string,
  "earningsPending" | "earningsNeutral" | "earningsCompleted" | "earningsFailed"
> = {
  pending: "earningsPending",
  approved: "earningsNeutral",
  processing: "earningsNeutral",
  completed: "earningsCompleted",
  failed: "earningsFailed",
  rejected: "earningsFailed",
};

export function EarningsPageClient() {
  const t = useCloudT();
  const SOURCE_LABELS = buildSourceLabels(t);
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [redemptions, setRedemptions] = useState<RedemptionListItem[]>([]);
  const [systemStatus, setSystemStatus] =
    useState<RedemptionStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [redemptionsLoading, setRedemptionsLoading] = useState(true);

  // Redemption form state
  const [showRedeemDialog, setShowRedeemDialog] = useState(false);
  const [redeemAmount, setRedeemAmount] = useState("");
  const [redeemNetwork, setRedeemNetwork] = useState<RedemptionNetwork>("base");
  const [redeemAddress, setRedeemAddress] = useState("");
  const [quote, setQuote] = useState<RedemptionQuoteResponse | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteRefreshNonce, setQuoteRefreshNonce] = useState(0);
  // A quote is absent during the initial render, so wall time is irrelevant
  // until the quote response arrives and advances this clock.
  const [quoteClock, setQuoteClock] = useState(0);
  const [redemptionIdempotencyKey, setRedemptionIdempotencyKey] = useState<
    string | null
  >(null);
  const [submitting, setSubmitting] = useState(false);
  const submissionInFlight = useRef(false);
  const parsedRedeemPoints = parseRedemptionUsdToPoints(redeemAmount);
  const redeemMinPoints = Math.max(
    REDEMPTION_MIN_POINTS,
    ceilRedemptionUsdToPoints(balance?.limits.minRedemptionUsd ?? 1),
  );
  const networkMaxPoints =
    redeemNetwork === "solana"
      ? REDEMPTION_MAX_POINTS
      : REDEMPTION_EVM_SIGNATURE_THRESHOLD_POINTS;
  const redeemMaxPoints = Math.min(
    REDEMPTION_MAX_POINTS,
    networkMaxPoints,
    floorRedemptionUsdToPoints(
      Math.max(
        0,
        Math.min(
          balance?.balance.availableBalance ?? 0,
          balance?.limits.maxSingleRedemptionUsd ?? 1_000,
          balance?.eligibility.dailyLimitRemaining ?? Number.POSITIVE_INFINITY,
        ),
      ),
    ),
  );
  const redeemAmountError =
    redeemAmount.length === 0
      ? null
      : parsedRedeemPoints === null
        ? t("cloud.earnings.amountInvalid", {
            defaultValue:
              "Enter a valid USD amount with at most two decimal places.",
          })
        : parsedRedeemPoints < redeemMinPoints
          ? t("cloud.earnings.amountBelowMinimum", {
              amount: formatCurrency(
                redeemMinPoints / REDEMPTION_POINTS_PER_USD,
              ),
              defaultValue: "Minimum redemption is {{amount}}.",
            })
          : parsedRedeemPoints > redeemMaxPoints
            ? t("cloud.earnings.amountAboveMaximum", {
                amount: formatCurrency(
                  redeemMaxPoints / REDEMPTION_POINTS_PER_USD,
                ),
                defaultValue: "Maximum available redemption is {{amount}}.",
              })
            : null;
  const redeemAmountInvalid = redeemAmountError !== null;
  const quoteExpired =
    quote?.success === true &&
    isRedemptionQuoteExpired(quote.quote.validUntil, quoteClock);
  const unavailableRedemptionNetworks = new Set(
    systemStatus?.networks
      .filter((network) => !network.available)
      .map((network) => network.network) ?? [],
  );

  const fetchBalance = useCallback(async () => {
    try {
      const data = await api<BalanceData>("/api/v1/redemptions/balance");
      setBalance(data);
    } catch {
      // leave balance null; the page renders empty/disabled state
    }
    setLoading(false);
  }, []);

  const fetchRedemptions = useCallback(async () => {
    try {
      const data = await api<ListRedemptionsResponse>(
        "/api/v1/redemptions?limit=10",
      );
      setRedemptions(data.redemptions || []);
    } catch {
      // leave existing redemptions
    }
    setRedemptionsLoading(false);
  }, []);

  const fetchSystemStatus = useCallback(async () => {
    try {
      const data = await api<RedemptionStatusResponse>(
        "/api/v1/redemptions/status",
      );
      setSystemStatus(data);
    } catch {
      // status banner stays hidden when unavailable
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (cancelled) return;
      await fetchBalance();
      await fetchRedemptions();
      await fetchSystemStatus();
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [fetchBalance, fetchRedemptions, fetchSystemStatus]);

  // quoteRefreshNonce intentionally retriggers the same request after expiry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit retry signal
  useEffect(() => {
    const pointsAmount = parseRedemptionUsdToPoints(redeemAmount);
    const shouldFetch =
      pointsAmount !== null &&
      pointsAmount >= redeemMinPoints &&
      pointsAmount <= redeemMaxPoints;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (shouldFetch) {
      timer = setTimeout(async () => {
        if (cancelled) return;
        setQuoteLoading(true);
        try {
          const data = await api<RedemptionQuoteResponse>(
            buildRedemptionQuotePath({ pointsAmount, network: redeemNetwork }),
          );
          if (cancelled) return;
          if (
            data.success &&
            !quoteMatchesRedemptionRequest(data, {
              pointsAmount,
              network: redeemNetwork,
            })
          ) {
            setQuote({
              success: false,
              error: t("cloud.earnings.quoteMismatch", {
                defaultValue:
                  "The quote did not match this request. Refresh it before continuing.",
              }),
            });
          } else {
            if (data.success) setQuoteClock(Date.now());
            setQuote(data);
          }
        } catch (error) {
          if (cancelled) return;
          const message =
            error instanceof Error
              ? error.message
              : t("cloud.earnings.quoteFailed", {
                  defaultValue: "Failed to get quote",
                });
          setQuote({ success: false, error: message });
        }
        if (!cancelled) setQuoteLoading(false);
      }, 500);
    } else {
      // Use microtask to avoid synchronous setState in effect
      queueMicrotask(() => {
        if (!cancelled) {
          setQuote(null);
          setQuoteLoading(false);
        }
      });
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    quoteRefreshNonce,
    redeemAmount,
    redeemMaxPoints,
    redeemMinPoints,
    redeemNetwork,
    t,
  ]);

  useEffect(() => {
    if (!quote?.success) return;
    const expiresAtMs = Date.parse(quote.quote.validUntil);
    const remainingMs = Number.isFinite(expiresAtMs)
      ? Math.max(0, expiresAtMs - Date.now())
      : 0;
    const timer = setTimeout(
      () => setQuoteClock(Date.now()),
      Math.min(remainingMs + 20, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [quote]);

  const invalidateQuote = () => {
    setQuote(null);
  };

  const rotateRedemptionIntent = () => {
    setRedemptionIdempotencyKey(createRedemptionIdempotencyKey());
  };

  const handleRedeemDialogOpenChange = (open: boolean) => {
    if (!open && submissionInFlight.current) return;
    setShowRedeemDialog(open);
    if (open) {
      rotateRedemptionIntent();
      invalidateQuote();
      setQuoteRefreshNonce((value) => value + 1);
    } else {
      setRedemptionIdempotencyKey(null);
    }
  };

  const handleRedeemAmountChange = (value: string) => {
    setRedeemAmount(value);
    rotateRedemptionIntent();
    invalidateQuote();
  };

  const handleRedeemNetworkChange = (value: RedemptionNetwork) => {
    setRedeemNetwork(value);
    rotateRedemptionIntent();
    invalidateQuote();
  };

  const handleRedeemAddressChange = (value: string) => {
    setRedeemAddress(value);
    rotateRedemptionIntent();
  };

  const handleRefreshQuote = () => {
    invalidateQuote();
    setQuoteRefreshNonce((value) => value + 1);
  };

  const handleSubmitRedemption = async () => {
    if (submissionInFlight.current) return;
    if (
      !quote?.success ||
      !quote.canRedeem ||
      !redeemAddress ||
      !redemptionIdempotencyKey
    ) {
      return;
    }

    const request = buildCreateRedemptionRequest({
      usdAmount: redeemAmount,
      network: redeemNetwork,
      payoutAddress: redeemAddress,
      idempotencyKey: redemptionIdempotencyKey,
    });
    if (!request) return;

    if (!quoteMatchesRedemptionRequest(quote, request)) {
      setQuote({
        success: false,
        error: t("cloud.earnings.quoteMismatch", {
          defaultValue:
            "The quote did not match this request. Refresh it before continuing.",
        }),
      });
      return;
    }

    if (isRedemptionQuoteExpired(quote.quote.validUntil)) {
      setQuoteClock(Date.now());
      return;
    }

    submissionInFlight.current = true;
    setSubmitting(true);
    try {
      const response = await api<CreateRedemptionResponse>(
        "/api/v1/redemptions",
        {
          method: "POST",
          json: request,
        },
      );
      if (!response.success) throw new Error(response.error);
      toast.success(
        t("cloud.earnings.submittedTitle", {
          defaultValue: "Redemption request submitted!",
        }),
        {
          description: response.message,
        },
      );
      // Release the close guard only after the server has durably accepted the
      // intent. Ambiguous in-flight dismissals keep the same retry UUID.
      submissionInFlight.current = false;
      handleRedeemDialogOpenChange(false);
      setRedeemAmount("");
      setRedeemAddress("");
      setQuote(null);
      setRedemptionIdempotencyKey(null);
      fetchBalance();
      fetchRedemptions();
    } catch (error) {
      const description =
        error instanceof Error
          ? error.message
          : t("cloud.earnings.tryAgain", { defaultValue: "Please try again." });
      toast.error(
        t("cloud.earnings.redemptionFailed", {
          defaultValue: "Redemption failed",
        }),
        { description },
      );
    } finally {
      submissionInFlight.current = false;
      setSubmitting(false);
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getExplorerUrl = (network: string, txHash: string) => {
    const explorers: Record<string, string> = {
      base: `https://basescan.org/tx/${txHash}`,
      ethereum: `https://etherscan.io/tx/${txHash}`,
      bnb: `https://bscscan.com/tx/${txHash}`,
      solana: `https://solscan.io/tx/${txHash}`,
    };
    return explorers[network] || "#";
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6 max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto">
      {/* System Status Banner */}
      {systemStatus && !systemStatus.operational && (
        <Alert variant="dashboardWarning">
          <div className="flex items-center gap-3">
            <AlertTriangle className="size-5 text-status-warning" />
            <div>
              <h4 className="font-semibold text-status-warning">
                {t("cloud.earnings.redemptionsLimited", {
                  defaultValue: "Redemptions Limited",
                })}
              </h4>
              <p className="text-sm text-status-warning">
                {systemStatus.message}
              </p>
            </div>
          </div>
        </Alert>
      )}

      {/* Balance Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Available Balance */}
        <Card variant="brand" className="relative">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-muted mb-1">
                {t("cloud.earnings.availableToRedeem", {
                  defaultValue: "Available to Redeem",
                })}
              </p>
              <p className="text-3xl font-bold text-accent">
                {formatCurrency(balance?.balance.availableBalance || 0)}
              </p>
              <p className="text-xs text-muted mt-1">
                {t("cloud.earnings.elizaAtCurrentPrice", {
                  defaultValue: "≈ elizaOS tokens at current price",
                })}
              </p>
            </div>
            <Card surface="accentSubtle" padding="compact">
              <Wallet className="size-6 text-accent" />
            </Card>
          </div>
          <Button
            className="w-full mt-4"
            disabled={!balance?.eligibility.canRedeem}
            onClick={() => handleRedeemDialogOpenChange(true)}
          >
            <Coins className="mr-2 size-4" />
            {t("cloud.earnings.redeemForEliza", {
              defaultValue: "Redeem for elizaOS",
            })}
          </Button>
          {balance?.eligibility?.reason && !balance.eligibility?.canRedeem && (
            <p className="text-xs text-muted mt-2 text-center">
              {balance.eligibility?.reason}
            </p>
          )}
        </Card>

        {/* Total Earned */}
        <Card variant="brand" className="relative">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-muted mb-1">
                {t("cloud.earnings.totalEarned", {
                  defaultValue: "Total Earned",
                })}
              </p>
              <p className="text-3xl font-bold text-txt-strong">
                {formatCurrency(balance?.balance.totalEarned || 0)}
              </p>
              <p className="text-xs text-muted mt-1">
                {t("cloud.earnings.lifetimeEarnings", {
                  defaultValue: "Lifetime earnings",
                })}
              </p>
            </div>
            <Card surface="raised" padding="compact">
              <TrendingUp className="size-6 text-status-success" />
            </Card>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {balance?.bySource.map((source) => {
              const Icon = SOURCE_ICONS[source.source];
              return (
                <div key={source.source} className="text-center">
                  <Icon className="size-4 mx-auto text-muted mb-1" />
                  <p className="text-xs text-muted">
                    {SOURCE_LABELS[source.source]}
                  </p>
                  <p className="text-sm font-semibold text-txt-strong">
                    {formatCurrency(source.totalEarned)}
                  </p>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Already Redeemed */}
        <Card variant="brand" className="relative">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-muted mb-1">
                {t("cloud.earnings.alreadyRedeemed", {
                  defaultValue: "Already Redeemed",
                })}
              </p>
              <p className="text-3xl font-bold text-txt-strong">
                {formatCurrency(balance?.balance.totalRedeemed || 0)}
              </p>
              <p className="text-xs text-muted mt-1">
                {t("cloud.earnings.allPayoutAssets", {
                  defaultValue: "Across all payout assets",
                })}
              </p>
            </div>
            <Card
              border="none"
              className="p-2"
              visualStyle={{ backgroundColor: "var(--bg-muted)" }}
            >
              <CheckCircle className="size-6 text-muted-strong" />
            </Card>
          </div>
          <Card asChild variant="billingTopDivider">
            <div className="mt-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted">
                  {t("cloud.earnings.spentOnHosting", {
                    defaultValue: "Spent on hosting",
                  })}
                </span>
                <span
                  className="text-txt-strong"
                  title={t("cloud.earnings.autoConvertedTooltip", {
                    defaultValue: "Earnings auto-converted into org credits",
                  })}
                >
                  {formatCurrency(
                    balance?.balance.totalConvertedToCredits || 0,
                  )}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted">
                  {t("cloud.earnings.dailyLimitRemaining", {
                    defaultValue: "Daily limit remaining",
                  })}
                </span>
                <span className="text-txt-strong">
                  {formatCurrency(
                    balance?.eligibility.dailyLimitRemaining || 0,
                  )}
                </span>
              </div>
            </div>
          </Card>
        </Card>
      </div>

      {/* How it Works */}
      <Card variant="brand" className="relative">
        <div className="flex items-start gap-3">
          <Info className="size-4 text-accent mt-0.5 shrink-0" />
          <div>
            <h4 className="font-semibold text-txt-strong mb-1">
              {t("cloud.earnings.howItWorksTitle", {
                defaultValue: "How Token Redemption Works",
              })}
            </h4>
            <p className="text-sm text-muted">
              {t("cloud.earnings.howItWorksBody", {
                defaultValue:
                  "Earnings from your apps, agents, and MCPs can be redeemed for elizaOS tokens. The conversion rate is $1 = equivalent value in elizaOS at current market price. Tokens are sent to your wallet after every redemption request is reviewed.",
              })}
            </p>
          </div>
        </div>
      </Card>

      {/* Recent Earnings */}
      {balance?.recentEarnings && balance.recentEarnings.length > 0 && (
        <Card variant="brand">
          <h3 className="text-lg font-semibold text-txt-strong mb-4">
            {t("cloud.earnings.recentEarnings", {
              defaultValue: "Recent Earnings",
            })}
          </h3>
          <div className="space-y-3">
            {balance.recentEarnings.map((earning) => {
              const Icon = SOURCE_ICONS[earning.source];
              return (
                <Card
                  key={earning.id}
                  surface="raised"
                  flow="rowBetween"
                  padding="default"
                  className="min-h-touch"
                >
                  <div className="flex items-center gap-3">
                    <Card
                      border="none"
                      className="p-2"
                      visualStyle={{ backgroundColor: "var(--bg-muted)" }}
                    >
                      <Icon className="size-4 text-muted" />
                    </Card>
                    <div>
                      <p className="text-sm font-medium text-txt-strong">
                        {earning.description}
                      </p>
                      <p className="text-xs text-muted">
                        {formatDate(earning.createdAt)}
                      </p>
                    </div>
                  </div>
                  <p className="text-sm font-semibold text-status-success">
                    +{formatCurrency(earning.amount)}
                  </p>
                </Card>
              );
            })}
          </div>
        </Card>
      )}

      {/* Redemption History */}
      <Card variant="brand">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-txt-strong">
            {t("cloud.earnings.redemptionHistory", {
              defaultValue: "Redemption History",
            })}
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setRedemptionsLoading(true);
              fetchRedemptions();
            }}
          >
            <RefreshCw
              className={`size-4 ${redemptionsLoading ? "animate-spin" : ""}`}
            />
          </Button>
        </div>

        {redemptionsLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : redemptions.length === 0 ? (
          <div className="text-center py-8 text-muted">
            <Wallet className="size-12 mx-auto mb-3 opacity-50" />
            <p>
              {t("cloud.earnings.noRedemptionsYet", {
                defaultValue: "No redemptions yet",
              })}
            </p>
            <p className="text-sm">
              {t("cloud.earnings.historyWillAppear", {
                defaultValue: "Your redemption history will appear here",
              })}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-muted">
                  {t("cloud.earnings.colDate", { defaultValue: "Date" })}
                </TableHead>
                <TableHead className="text-muted">
                  {t("cloud.earnings.colAmount", { defaultValue: "Amount" })}
                </TableHead>
                <TableHead className="text-muted">
                  {t("cloud.earnings.colNetwork", { defaultValue: "Network" })}
                </TableHead>
                <TableHead className="text-muted">
                  {t("cloud.earnings.colStatus", { defaultValue: "Status" })}
                </TableHead>
                <TableHead className="text-muted">
                  {t("cloud.earnings.colTx", { defaultValue: "TX" })}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {redemptions.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-txt">
                    {formatDate(r.createdAt)}
                  </TableCell>
                  <TableCell>
                    <div>
                      <p className="text-txt-strong font-medium">
                        {formatCurrency(r.usdValue)}
                      </p>
                      <p className="text-xs text-muted">
                        {r.elizaAmount.toFixed(2)}{" "}
                        {r.asset === "usdc" ? "USDC" : "elizaOS"}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell className="capitalize text-txt">
                    {r.network}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={STATUS_VARIANTS[r.status] ?? "earningsPending"}
                    >
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {r.txHash ? (
                      <Button
                        asChild
                        variant="externalLink"
                        className="min-h-touch gap-1"
                      >
                        <a
                          href={getExplorerUrl(r.network, r.txHash)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t("cloud.earnings.view", { defaultValue: "View" })}{" "}
                          <ExternalLink className="size-3" />
                        </a>
                      </Button>
                    ) : (
                      <span className="text-muted">-</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Redeem Dialog */}
      <Dialog
        open={showRedeemDialog}
        onOpenChange={handleRedeemDialogOpenChange}
      >
        <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-txt-strong">
              {t("cloud.earnings.redeemDialogTitle", {
                defaultValue: "Redeem for elizaOS Tokens",
              })}
            </DialogTitle>
            <DialogDescription className="text-muted">
              {t("cloud.earnings.redeemDialogDescription", {
                defaultValue:
                  "Convert your earnings to elizaOS tokens. Tokens will be sent to your wallet.",
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 space-y-4 overflow-y-auto py-4 pr-1">
            {/* Amount Input */}
            <div>
              <label
                htmlFor="redeem-amount"
                className="text-sm text-muted mb-2 block"
              >
                {t("cloud.earnings.amountToRedeem", {
                  defaultValue: "Amount to Redeem (USD)",
                })}
              </label>
              <Input
                variant="muted"
                id="redeem-amount"
                type="number"
                inputMode="decimal"
                step="0.01"
                placeholder={t("cloud.earnings.enterAmount", {
                  defaultValue: "Enter amount",
                })}
                value={redeemAmount}
                onChange={(e) => handleRedeemAmountChange(e.target.value)}
                className="text-txt"
                min={redeemMinPoints / REDEMPTION_POINTS_PER_USD}
                max={redeemMaxPoints / REDEMPTION_POINTS_PER_USD}
                aria-invalid={redeemAmountInvalid}
                aria-describedby={
                  redeemAmountInvalid ? "redeem-amount-error" : undefined
                }
              />
              <div className="flex justify-between text-xs text-muted mt-1">
                <span>
                  {t("cloud.earnings.min", {
                    amount: formatCurrency(
                      redeemMinPoints / REDEMPTION_POINTS_PER_USD,
                    ),
                    defaultValue: "Min: {{amount}}",
                  })}
                </span>
                <span>
                  {t("cloud.earnings.max", {
                    amount: formatCurrency(
                      redeemMaxPoints / REDEMPTION_POINTS_PER_USD,
                    ),
                    defaultValue: "Max: {{amount}}",
                  })}
                </span>
              </div>
              {redeemAmountInvalid && (
                <p
                  id="redeem-amount-error"
                  className="mt-1 text-xs text-destructive"
                  role="alert"
                >
                  {redeemAmountError}
                </p>
              )}
            </div>

            {/* Network Select */}
            <div>
              <p className="text-sm text-muted mb-2">
                {t("cloud.earnings.networkLabel", { defaultValue: "Network" })}
              </p>
              <Select
                value={redeemNetwork}
                onValueChange={(value) =>
                  handleRedeemNetworkChange(value as RedemptionNetwork)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NETWORKS.map((network) => (
                    <SelectItem
                      key={network.value}
                      value={network.value}
                      className="text-txt"
                      disabled={unavailableRedemptionNetworks.has(
                        canonicalizeRedemptionNetwork(network.value),
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <Badge
                          variant="chainDot"
                          indicatorColor={network.indicatorColor}
                          aria-hidden="true"
                        />
                        <span>{network.label}</span>
                        {unavailableRedemptionNetworks.has(
                          canonicalizeRedemptionNetwork(network.value),
                        ) && (
                          <span className="text-xs text-destructive">
                            {t("cloud.earnings.unavailable", {
                              defaultValue: "(unavailable)",
                            })}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Wallet Address */}
            <div>
              <label
                htmlFor="redeem-wallet-address"
                className="text-sm text-muted mb-2 block"
              >
                {t("cloud.earnings.walletAddressLabel", {
                  network:
                    redeemNetwork === "solana"
                      ? t("cloud.earnings.solana", { defaultValue: "Solana" })
                      : t("cloud.earnings.evm", { defaultValue: "EVM" }),
                  defaultValue: "{{network}} Wallet Address",
                })}
              </label>
              <Input
                variant="muted"
                id="redeem-wallet-address"
                type="text"
                placeholder={
                  redeemNetwork === "solana"
                    ? t("cloud.earnings.enterSolanaAddress", {
                        defaultValue: "Enter Solana address",
                      })
                    : t("cloud.earnings.enterEvmAddress", {
                        defaultValue: "Enter 0x address",
                      })
                }
                value={redeemAddress}
                onChange={(e) => handleRedeemAddressChange(e.target.value)}
                className="font-mono text-sm text-txt"
              />
            </div>

            {/* Quote Display */}
            {quoteLoading && (
              <Card
                border="none"
                padding="comfortable"
                visualStyle={{ backgroundColor: "var(--bg-hover)" }}
                className="animate-pulse"
                role="status"
                aria-live="polite"
              >
                <p className="text-muted text-center">
                  {t("cloud.earnings.gettingQuote", {
                    defaultValue: "Getting quote...",
                  })}
                </p>
              </Card>
            )}

            {quote && !quoteLoading && (
              <Card
                border="none"
                padding="comfortable"
                className="space-y-2"
                visualStyle={{ backgroundColor: "var(--bg-hover)" }}
              >
                {quote.success ? (
                  <>
                    <div className="flex justify-between">
                      <span className="text-muted">
                        {t("cloud.earnings.youPay", {
                          defaultValue: "You pay",
                        })}
                      </span>
                      <span className="text-txt-strong font-semibold">
                        {formatCurrency(quote.quote.usdValue)}
                      </span>
                    </div>
                    <div className="flex justify-center py-2">
                      <ArrowRight className="size-4 text-muted" />
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">
                        {t("cloud.earnings.estimatedReceive", {
                          defaultValue: "Estimated amount",
                        })}
                      </span>
                      <span className="text-accent font-semibold">
                        {quote.quote.elizaAmount.toFixed(4)} elizaOS
                      </span>
                    </div>
                    <Card asChild variant="billingTopDivider">
                      <div className="text-xs text-muted">
                        <div className="flex justify-between">
                          <span>
                            {t("cloud.earnings.price", {
                              defaultValue: "Price",
                            })}
                          </span>
                          <span>
                            ${quote.quote.twapPriceUsd.toFixed(6)}
                            /token
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>
                            {t("cloud.earnings.expires", {
                              defaultValue: "Expires",
                            })}
                          </span>
                          <span>
                            <Clock className="inline size-3 mr-1" />
                            {new Date(
                              quote.quote.validUntil,
                            ).toLocaleTimeString()}
                          </span>
                        </div>
                      </div>
                    </Card>
                    <Card asChild variant="billingTopDivider">
                      <p className="text-xs text-muted">
                        {t("cloud.earnings.quotePreviewNotice", {
                          defaultValue:
                            "This is a preview. The final token amount is recalculated when you submit and may change with the market price.",
                        })}
                      </p>
                    </Card>
                    {!quote.canRedeem && (
                      <Card asChild variant="billingTopDivider">
                        <p className="text-sm text-destructive" role="alert">
                          {quote.message}
                        </p>
                      </Card>
                    )}
                    {quoteExpired && (
                      <Card asChild variant="billingTopDivider">
                        <div className="text-sm text-destructive" role="alert">
                          <p>
                            {t("cloud.earnings.quoteExpired", {
                              defaultValue:
                                "This quote has expired. Request a new quote to continue.",
                            })}
                          </p>
                          <Button
                            className="mt-2"
                            size="sm"
                            variant="outline"
                            onClick={handleRefreshQuote}
                          >
                            <RefreshCw className="size-3.5" />
                            {t("cloud.earnings.refreshQuote", {
                              defaultValue: "Refresh quote",
                            })}
                          </Button>
                        </div>
                      </Card>
                    )}
                  </>
                ) : (
                  <p
                    className="text-destructive text-sm text-center"
                    role="alert"
                  >
                    {quote.error}
                  </p>
                )}
              </Card>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              disabled={submitting}
              onClick={() => handleRedeemDialogOpenChange(false)}
            >
              {t("cloud.earnings.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button
              onClick={handleSubmitRedemption}
              disabled={
                !quote?.success ||
                !quote.canRedeem ||
                quoteExpired ||
                redeemAmountInvalid ||
                !redeemAddress ||
                !redemptionIdempotencyKey ||
                submitting ||
                !balance?.eligibility?.canRedeem
              }
            >
              {submitting ? (
                <>
                  <RefreshCw className="mr-2 size-4 animate-spin" />
                  {t("cloud.earnings.submitting", {
                    defaultValue: "Submitting...",
                  })}
                </>
              ) : (
                <>
                  <Coins className="mr-2 size-4" />
                  {t("cloud.earnings.redeemTokens", {
                    defaultValue: "Redeem Tokens",
                  })}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
