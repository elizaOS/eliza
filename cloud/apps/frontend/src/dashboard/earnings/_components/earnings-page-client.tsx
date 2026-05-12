"use client";

import {
  Badge,
  BrandCard,
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
} from "@elizaos/cloud-ui";
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
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

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

interface QuoteData {
  success: boolean;
  quote?: {
    pointsToRedeem: number;
    usdValue: number;
    elizaPriceUsd: string;
    elizaAmount: string;
    network: string;
    expiresAt: string;
    safetySpread: number;
    priceSource: string;
  };
  error?: string;
}

interface RedemptionData {
  id: string;
  status: string;
  usd_value: string;
  eliza_amount: string;
  network: string;
  payout_address: string;
  created_at: string;
  completed_at?: string;
  tx_hash?: string;
}

interface SystemStatus {
  operational: boolean;
  networks: Record<string, { available: boolean; reason?: string }>;
  message?: string;
}

const NETWORKS = [
  { value: "base", label: "Base", icon: "🔵" },
  { value: "solana", label: "Solana", icon: "🟣" },
  { value: "ethereum", label: "Ethereum", icon: "⬛" },
  { value: "bnb", label: "BNB Chain", icon: "🟡" },
];

const SOURCE_ICONS = {
  miniapp: AppWindow,
  agent: Bot,
  mcp: Server,
};

const SOURCE_LABELS = {
  miniapp: "Apps",
  agent: "Agents",
  mcp: "MCPs",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  approved: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  processing: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  completed: "bg-green-500/20 text-green-400 border-green-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
  rejected: "bg-red-500/20 text-red-400 border-red-500/30",
};

export function EarningsPageClient() {
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [redemptions, setRedemptions] = useState<RedemptionData[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [redemptionsLoading, setRedemptionsLoading] = useState(true);

  // Redemption form state
  const [showRedeemDialog, setShowRedeemDialog] = useState(false);
  const [redeemAmount, setRedeemAmount] = useState("");
  const [redeemNetwork, setRedeemNetwork] = useState("base");
  const [redeemAddress, setRedeemAddress] = useState("");
  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Fetch balance
  const fetchBalance = useCallback(async () => {
    const res = await fetch("/api/v1/redemptions/balance");
    if (res.ok) {
      const data = await res.json();
      setBalance(data);
    }
    setLoading(false);
  }, []);

  // Fetch redemptions
  const fetchRedemptions = useCallback(async () => {
    const res = await fetch("/api/v1/redemptions?limit=10");
    if (res.ok) {
      const data = await res.json();
      setRedemptions(data.redemptions || []);
    }
    setRedemptionsLoading(false);
  }, []);

  // Fetch system status
  const fetchSystemStatus = useCallback(async () => {
    const res = await fetch("/api/v1/redemptions/status");
    if (res.ok) {
      const data = await res.json();
      setSystemStatus(data);
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

  // Fetch quote when amount or network changes
  useEffect(() => {
    const amount = parseFloat(redeemAmount);
    const shouldFetch = amount > 0 && redeemNetwork;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (shouldFetch) {
      timer = setTimeout(async () => {
        if (cancelled) return;
        setQuoteLoading(true);
        const res = await fetch(
          `/api/v1/redemptions/quote?amount=${amount}&network=${redeemNetwork}`,
        );
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          setQuote(data);
        } else {
          const error = await res.json();
          setQuote({
            success: false,
            error: error.error || "Failed to get quote",
          });
        }
        setQuoteLoading(false);
      }, 500);
    } else {
      // Use microtask to avoid synchronous setState in effect
      queueMicrotask(() => {
        if (!cancelled) setQuote(null);
      });
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [redeemAmount, redeemNetwork]);

  const handleSubmitRedemption = async () => {
    if (!quote?.quote || !redeemAddress) return;

    setSubmitting(true);
    const res = await fetch("/api/v1/redemptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: parseFloat(redeemAmount),
        network: redeemNetwork,
        payoutAddress: redeemAddress,
      }),
    });

    if (res.ok) {
      toast.success("Redemption request submitted!", {
        description: "Your request is being processed.",
      });
      setShowRedeemDialog(false);
      setRedeemAmount("");
      setRedeemAddress("");
      setQuote(null);
      fetchBalance();
      fetchRedemptions();
    } else {
      const error = await res.json();
      toast.error("Redemption failed", {
        description: error.error || "Please try again.",
      });
    }
    setSubmitting(false);
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value);
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
            <Skeleton key={i} className="h-32 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto">
      {/* System Status Banner */}
      {systemStatus && !systemStatus.operational && (
        <BrandCard className="border-yellow-500/40 bg-yellow-500/10" corners={false}>
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-yellow-400" />
            <div>
              <h4 className="font-semibold text-yellow-400">Redemptions Limited</h4>
              <p className="text-sm text-yellow-400/80">{systemStatus.message}</p>
            </div>
          </div>
        </BrandCard>
      )}

      {/* Balance Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Available Balance */}
        <BrandCard className="relative" corners={false}>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-white/60 mb-1">Available to Redeem</p>
              <p className="text-3xl font-bold text-[#FF5800]">
                {formatCurrency(balance?.balance.availableBalance || 0)}
              </p>
              <p className="text-xs text-white/40 mt-1">≈ elizaOS tokens at current price</p>
            </div>
            <div className="p-2 rounded-lg bg-[#FF5800]/20">
              <Wallet className="h-6 w-6 text-[#FF5800]" />
            </div>
          </div>
          <Button
            className="w-full mt-4 bg-[#FF5800] hover:bg-[#FF5800]/90"
            disabled={!balance?.eligibility.canRedeem}
            onClick={() => setShowRedeemDialog(true)}
          >
            <Coins className="mr-2 h-4 w-4" />
            Redeem for elizaOS
          </Button>
          {balance?.eligibility.reason && !balance.eligibility.canRedeem && (
            <p className="text-xs text-white/40 mt-2 text-center">{balance.eligibility.reason}</p>
          )}
        </BrandCard>

        {/* Total Earned */}
        <BrandCard className="relative" corners={false}>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-white/60 mb-1">Total Earned</p>
              <p className="text-3xl font-bold text-white">
                {formatCurrency(balance?.balance.totalEarned || 0)}
              </p>
              <p className="text-xs text-white/40 mt-1">Lifetime earnings</p>
            </div>
            <div className="p-2 rounded-lg bg-green-500/20">
              <TrendingUp className="h-6 w-6 text-green-400" />
            </div>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {balance?.bySource.map((source) => {
              const Icon = SOURCE_ICONS[source.source];
              return (
                <div key={source.source} className="text-center">
                  <Icon className="h-4 w-4 mx-auto text-white/40 mb-1" />
                  <p className="text-xs text-white/60">{SOURCE_LABELS[source.source]}</p>
                  <p className="text-sm font-semibold text-white">
                    {formatCurrency(source.totalEarned)}
                  </p>
                </div>
              );
            })}
          </div>
        </BrandCard>

        {/* Already Redeemed */}
        <BrandCard className="relative" corners={false}>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-white/60 mb-1">Already Redeemed</p>
              <p className="text-3xl font-bold text-white">
                {formatCurrency(balance?.balance.totalRedeemed || 0)}
              </p>
              <p className="text-xs text-white/40 mt-1">Converted to elizaOS tokens</p>
            </div>
            <div className="p-2 rounded-lg bg-purple-500/20">
              <CheckCircle className="h-6 w-6 text-purple-400" />
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-white/10 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-white/60">Spent on hosting</span>
              <span className="text-white" title="Earnings auto-converted into org credits">
                {formatCurrency(balance?.balance.totalConvertedToCredits || 0)}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-white/60">Daily limit remaining</span>
              <span className="text-white">
                {formatCurrency(balance?.eligibility.dailyLimitRemaining || 0)}
              </span>
            </div>
          </div>
        </BrandCard>
      </div>

      {/* How it Works */}
      <BrandCard className="relative" corners={false}>
        <div className="flex items-start gap-3">
          <Info className="h-4 w-4 text-[#FF5800] mt-0.5 shrink-0" />
          <div>
            <h4 className="font-semibold text-white mb-1">How Token Redemption Works</h4>
            <p className="text-sm text-white/60">
              Earnings from your apps, agents, and MCPs can be redeemed for elizaOS tokens. The
              conversion rate is $1 = equivalent value in elizaOS at current market price. Tokens
              are sent directly to your wallet on your chosen network (Base, Solana, Ethereum, or
              BNB). Large redemptions ({">"} $1,000) require admin approval for security.
            </p>
          </div>
        </div>
      </BrandCard>

      {/* Recent Earnings */}
      {balance?.recentEarnings && balance.recentEarnings.length > 0 && (
        <BrandCard corners={false}>
          <h3 className="text-lg font-semibold text-white mb-4">Recent Earnings</h3>
          <div className="space-y-3">
            {balance.recentEarnings.map((earning) => {
              const Icon = SOURCE_ICONS[earning.source];
              return (
                <div
                  key={earning.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-white/5"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-white/10">
                      <Icon className="h-4 w-4 text-white/60" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-white">{earning.description}</p>
                      <p className="text-xs text-white/40">{formatDate(earning.createdAt)}</p>
                    </div>
                  </div>
                  <p className="text-sm font-semibold text-green-400">
                    +{formatCurrency(earning.amount)}
                  </p>
                </div>
              );
            })}
          </div>
        </BrandCard>
      )}

      {/* Redemption History */}
      <BrandCard corners={false}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">Redemption History</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setRedemptionsLoading(true);
              fetchRedemptions();
            }}
          >
            <RefreshCw className={`h-4 w-4 ${redemptionsLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {redemptionsLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : redemptions.length === 0 ? (
          <div className="text-center py-8 text-white/40">
            <Wallet className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>No redemptions yet</p>
            <p className="text-sm">Your redemption history will appear here</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-white/10">
                <TableHead className="text-white/60">Date</TableHead>
                <TableHead className="text-white/60">Amount</TableHead>
                <TableHead className="text-white/60">Network</TableHead>
                <TableHead className="text-white/60">Status</TableHead>
                <TableHead className="text-white/60">TX</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {redemptions.map((r) => (
                <TableRow key={r.id} className="border-white/10">
                  <TableCell className="text-white/80">{formatDate(r.created_at)}</TableCell>
                  <TableCell>
                    <div>
                      <p className="text-white font-medium">
                        {formatCurrency(parseFloat(r.usd_value))}
                      </p>
                      <p className="text-xs text-white/40">
                        {parseFloat(r.eliza_amount).toFixed(2)} elizaOS
                      </p>
                    </div>
                  </TableCell>
                  <TableCell className="capitalize text-white/80">{r.network}</TableCell>
                  <TableCell>
                    <Badge className={STATUS_COLORS[r.status] || STATUS_COLORS.pending}>
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {r.tx_hash ? (
                      <a
                        href={getExplorerUrl(r.network, r.tx_hash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#FF5800] hover:underline flex items-center gap-1"
                      >
                        View <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-white/40">-</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </BrandCard>

      {/* Redeem Dialog */}
      <Dialog open={showRedeemDialog} onOpenChange={setShowRedeemDialog}>
        <DialogContent className="sm:max-w-lg bg-zinc-900 border-white/10">
          <DialogHeader>
            <DialogTitle className="text-white">Redeem for elizaOS Tokens</DialogTitle>
            <DialogDescription className="text-white/60">
              Convert your earnings to elizaOS tokens. Tokens will be sent to your wallet.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Amount Input */}
            <div>
              <label className="text-sm text-white/60 mb-2 block">Amount to Redeem (USD)</label>
              <Input
                type="number"
                placeholder="Enter amount"
                value={redeemAmount}
                onChange={(e) => setRedeemAmount(e.target.value)}
                className="bg-white/5 border-white/10 text-white"
                min={balance?.limits.minRedemptionUsd || 1}
                max={Math.min(
                  balance?.balance.availableBalance || 0,
                  balance?.limits.maxSingleRedemptionUsd || 10000,
                )}
              />
              <div className="flex justify-between text-xs text-white/40 mt-1">
                <span>Min: {formatCurrency(balance?.limits.minRedemptionUsd || 1)}</span>
                <span>
                  Max:{" "}
                  {formatCurrency(
                    Math.min(
                      balance?.balance.availableBalance || 0,
                      balance?.limits.maxSingleRedemptionUsd || 10000,
                    ),
                  )}
                </span>
              </div>
            </div>

            {/* Network Select */}
            <div>
              <label className="text-sm text-white/60 mb-2 block">Network</label>
              <Select value={redeemNetwork} onValueChange={setRedeemNetwork}>
                <SelectTrigger className="bg-white/5 border-white/10 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-zinc-900 border-white/10">
                  {NETWORKS.map((network) => (
                    <SelectItem
                      key={network.value}
                      value={network.value}
                      className="text-white"
                      disabled={systemStatus?.networks?.[network.value]?.available === false}
                    >
                      <span className="flex items-center gap-2">
                        <span>{network.icon}</span>
                        <span>{network.label}</span>
                        {systemStatus?.networks?.[network.value]?.available === false && (
                          <span className="text-xs text-red-400">(unavailable)</span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Wallet Address */}
            <div>
              <label className="text-sm text-white/60 mb-2 block">
                {redeemNetwork === "solana" ? "Solana" : "EVM"} Wallet Address
              </label>
              <Input
                type="text"
                placeholder={
                  redeemNetwork === "solana" ? "Enter Solana address" : "Enter 0x address"
                }
                value={redeemAddress}
                onChange={(e) => setRedeemAddress(e.target.value)}
                className="bg-white/5 border-white/10 text-white font-mono text-sm"
              />
            </div>

            {/* Quote Display */}
            {quoteLoading && (
              <div className="p-4 rounded-lg bg-white/5 animate-pulse">
                <p className="text-white/40 text-center">Getting quote...</p>
              </div>
            )}

            {quote && !quoteLoading && (
              <div className="p-4 rounded-lg bg-white/5 space-y-2">
                {quote.success && quote.quote ? (
                  <>
                    <div className="flex justify-between">
                      <span className="text-white/60">You pay</span>
                      <span className="text-white font-semibold">
                        {formatCurrency(quote.quote.usdValue)}
                      </span>
                    </div>
                    <div className="flex justify-center py-2">
                      <ArrowRight className="h-4 w-4 text-white/40" />
                    </div>
                    <div className="flex justify-between">
                      <span className="text-white/60">You receive</span>
                      <span className="text-[#FF5800] font-semibold">
                        {parseFloat(quote.quote.elizaAmount).toFixed(4)} elizaOS
                      </span>
                    </div>
                    <div className="pt-2 border-t border-white/10 text-xs text-white/40">
                      <div className="flex justify-between">
                        <span>Price</span>
                        <span>
                          ${parseFloat(quote.quote.elizaPriceUsd).toFixed(6)}
                          /token
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Expires</span>
                        <span>
                          <Clock className="inline h-3 w-3 mr-1" />
                          {new Date(quote.quote.expiresAt).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="text-red-400 text-sm text-center">{quote.error}</p>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setShowRedeemDialog(false)}
              className="text-white/60"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmitRedemption}
              disabled={
                !quote?.success || !redeemAddress || submitting || !balance?.eligibility.canRedeem
              }
              className="bg-[#FF5800] hover:bg-[#FF5800]/90"
            >
              {submitting ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Submitting...
                </>
              ) : (
                <>
                  <Coins className="mr-2 h-4 w-4" />
                  Redeem Tokens
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
