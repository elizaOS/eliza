/**
 * Enhanced app earnings dashboard with animated counters, milestone tracking,
 * and celebratory withdrawal flow.
 */

"use client";

import {
  Badge,
  Button,
  DashboardStatCard,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/cloud-ui";
import { MilestoneProgress } from "@elizaos/cloud-ui/components/monetization";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  ArrowUpRight,
  BarChart3,
  Clock,
  Coins,
  DollarSign,
  FlaskConical,
  Loader2,
  TrendingUp,
  Wallet,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import { WithdrawDialog } from "./monetization/withdraw-dialog";

interface EarningsSummary {
  totalLifetimeEarnings: number;
  totalInferenceEarnings: number;
  totalPurchaseEarnings: number;
  pendingBalance: number;
  withdrawableBalance: number;
  totalWithdrawn: number;
  payoutThreshold: number;
}

interface EarningsBreakdown {
  period: string;
  inferenceEarnings: number;
  purchaseEarnings: number;
  total: number;
}

interface ChartDataPoint {
  date: string;
  inferenceEarnings: number;
  purchaseEarnings: number;
  total: number;
}

interface Transaction {
  id: string;
  type: string;
  amount: string;
  description: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

interface AppEarningsDashboardProps {
  appId: string;
}

const PAYOUT_THRESHOLD = 25;

export function AppEarningsDashboard({ appId }: AppEarningsDashboardProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const testDataParam = searchParams.get("testData") === "true";

  const [isLoading, setIsLoading] = useState(true);
  const [isTestData, setIsTestData] = useState(false);
  const [monetizationEnabled, setMonetizationEnabled] = useState<boolean | null>(null);
  const [period, setPeriod] = useState<"7" | "30" | "90">("30");
  const [summary, setSummary] = useState<EarningsSummary | null>(null);
  const [breakdown, setBreakdown] = useState<{
    today: EarningsBreakdown;
    thisWeek: EarningsBreakdown;
    thisMonth: EarningsBreakdown;
    allTime: EarningsBreakdown;
  } | null>(null);
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showWithdrawDialog, setShowWithdrawDialog] = useState(false);

  const fetchEarnings = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const url = new URL(`/api/v1/apps/${appId}/earnings`, window.location.origin);
      url.searchParams.set("days", period);

      if (testDataParam) {
        url.searchParams.set("testData", "true");
      }

      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();

      if (data.success) {
        setSummary(data.earnings.summary);
        setBreakdown(data.earnings.breakdown);
        setChartData(data.earnings.chartData);
        setTransactions(data.earnings.recentTransactions);
        setIsTestData(data.testData === true);
        if (data.monetization) {
          setMonetizationEnabled(data.monetization.enabled);
        }
      } else {
        setError(data.error || "Failed to load earnings data");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load earnings data");
    } finally {
      setIsLoading(false);
    }
  }, [appId, period, testDataParam]);

  useEffect(() => {
    fetchEarnings();
  }, [fetchEarnings]);

  const handleWithdrawSuccess = (newBalance: number) => {
    if (summary) {
      setSummary({
        ...summary,
        withdrawableBalance: newBalance,
      });
    }
    fetchEarnings();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-[#FF5800]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-neutral-900 rounded-xl p-8 text-center">
        <AlertCircle className="h-12 w-12 mx-auto mb-4 text-red-400" />
        <h3 className="text-lg font-medium text-white mb-2">Error loading earnings</h3>
        <p className="text-neutral-400 mb-4 text-sm">{error}</p>
        <Button
          onClick={fetchEarnings}
          variant="outline"
          className="border-white/10 hover:bg-white/10"
        >
          Try Again
        </Button>
      </div>
    );
  }

  const canWithdraw =
    summary && summary.withdrawableBalance >= (summary.payoutThreshold || PAYOUT_THRESHOLD);

  return (
    <div className="space-y-4">
      {isTestData && (
        <div className="flex items-center gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
          <FlaskConical className="h-4 w-4 text-amber-400" />
          <p className="text-sm text-amber-400">Test Data Mode - Showing sample earnings data</p>
        </div>
      )}

      {/* Period Selector */}
      <div className="flex justify-end">
        <Select value={period} onValueChange={(v) => setPeriod(v as typeof period)}>
          <SelectTrigger className="w-[140px] h-9 bg-neutral-900 border-white/10 rounded-lg">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-neutral-800 border-white/10 rounded-lg">
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Empty State */}
      {!summary && !isLoading && (
        <div className="bg-neutral-900 rounded-xl p-8 text-center">
          <TrendingUp className="h-12 w-12 mx-auto mb-4 text-neutral-600" />
          <h3 className="text-lg font-medium text-neutral-500 mb-2">No earnings yet</h3>
          {monetizationEnabled ? (
            <p className="text-neutral-500 text-sm">
              Earnings will appear here once users start using your app
            </p>
          ) : (
            <>
              <p className="text-neutral-500 text-sm mb-4">
                Enable monetization to start earning from your app
              </p>
              <Button
                onClick={() => {
                  navigate(`/dashboard/apps/${appId}?tab=monetization`);
                }}
                className="bg-[#FF5800] hover:bg-[#FF5800]/80 text-white"
              >
                Enable Monetization
              </Button>
            </>
          )}
        </div>
      )}

      {/* Hero Stats Card */}
      {summary && (
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
          {/* Total Earnings */}
          <div className="bg-neutral-900 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-neutral-500">Total Lifetime Earnings</p>
                <p className="text-2xl font-semibold text-white mt-1">
                  ${summary.totalLifetimeEarnings.toFixed(2)}
                </p>
                {breakdown && (
                  <p className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
                    <ArrowUpRight className="h-3 w-3" />${breakdown.thisWeek.total.toFixed(2)} this
                    week
                  </p>
                )}
              </div>
              <TrendingUp className="h-5 w-5 text-[#FF5800]" />
            </div>
          </div>

          {/* Withdrawable Balance */}
          <div
            className={cn(
              "bg-neutral-900 rounded-xl p-4",
              canWithdraw && "border border-emerald-500/30",
            )}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-neutral-500">Ready to Withdraw</p>
                <p className="text-2xl font-semibold text-emerald-400 mt-1">
                  ${summary.withdrawableBalance.toFixed(2)}
                </p>
              </div>
              <Wallet className="h-5 w-5 text-emerald-400" />
            </div>
            <div className="mt-3">
              {canWithdraw ? (
                <Button
                  onClick={() => setShowWithdrawDialog(true)}
                  size="sm"
                  className="w-full bg-emerald-600 hover:bg-emerald-500 text-white"
                >
                  <Wallet className="h-4 w-4 mr-2" />
                  Withdraw Now
                </Button>
              ) : (
                <MilestoneProgress
                  current={summary.withdrawableBalance}
                  target={summary.payoutThreshold || PAYOUT_THRESHOLD}
                  showAmount={false}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Stats Grid */}
      {summary && (
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          <DashboardStatCard
            label="Pending"
            value={`$${summary.pendingBalance.toFixed(2)}`}
            icon={<Clock className="h-5 w-5" />}
            accent="amber"
          />
          <DashboardStatCard
            label="Withdrawable"
            value={`$${summary.withdrawableBalance.toFixed(2)}`}
            icon={<Wallet className="h-5 w-5" />}
            accent="emerald"
          />
          <DashboardStatCard
            label="From Inference"
            value={`$${summary.totalInferenceEarnings.toFixed(2)}`}
            icon={<Zap className="h-5 w-5" />}
            accent="violet"
          />
          <DashboardStatCard
            label="From Purchases"
            value={`$${summary.totalPurchaseEarnings.toFixed(2)}`}
            icon={<Coins className="h-5 w-5" />}
            accent="orange"
          />
        </div>
      )}

      {/* Period Breakdown */}
      {breakdown && (
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          {[
            { label: "Today", data: breakdown.today },
            { label: "This Week", data: breakdown.thisWeek },
            { label: "This Month", data: breakdown.thisMonth },
            { label: "All Time", data: breakdown.allTime },
          ].map(({ label, data }) => (
            <div key={label} className="bg-neutral-900 rounded-xl p-3">
              <p className="text-xs text-neutral-500">{label}</p>
              <p className="text-lg font-semibold text-white mt-1">${data.total.toFixed(2)}</p>
              <div className="flex gap-3 text-xs mt-2">
                <span className="text-purple-400 flex items-center gap-1">
                  <Zap className="h-3 w-3" />${data.inferenceEarnings.toFixed(2)}
                </span>
                <span className="text-amber-400 flex items-center gap-1">
                  <Coins className="h-3 w-3" />${data.purchaseEarnings.toFixed(2)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Chart */}
      <div className="bg-neutral-900 rounded-xl p-4">
        <h3 className="text-sm font-medium text-white mb-4 flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-neutral-400" />
          Earnings Over Time
        </h3>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
              <XAxis dataKey="date" stroke="rgba(255,255,255,0.4)" style={{ fontSize: "11px" }} />
              <YAxis
                stroke="rgba(255,255,255,0.4)"
                style={{ fontSize: "11px" }}
                tickFormatter={(value) => `$${value.toFixed(2)}`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#171717",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "8px",
                  color: "white",
                  fontSize: "12px",
                }}
                formatter={(value) => {
                  const numericValue = Array.isArray(value)
                    ? Number(value[0] ?? 0)
                    : Number(value ?? 0);
                  return `$${numericValue.toFixed(4)}`;
                }}
              />
              <Legend />
              <Bar
                dataKey="inferenceEarnings"
                fill="#a855f7"
                name="Inference Markup"
                stackId="a"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="purchaseEarnings"
                fill="#f59e0b"
                name="Purchase Share"
                stackId="a"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="text-center text-neutral-500 py-8">
            <DollarSign className="h-10 w-10 mx-auto mb-3 text-neutral-600" />
            <p className="text-sm">No earnings data yet</p>
          </div>
        )}
      </div>

      {/* Recent Transactions */}
      <div className="bg-neutral-900 rounded-xl p-4">
        <h3 className="text-sm font-medium text-white mb-4 flex items-center gap-2">
          <Clock className="h-4 w-4 text-neutral-400" />
          Recent Earnings
        </h3>

        {transactions.length > 0 ? (
          <div className="space-y-2">
            {transactions.map((tx) => (
              <div
                key={tx.id}
                className="flex items-center justify-between p-3 bg-black/30 rounded-lg border border-white/5 hover:border-white/10 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <TransactionIcon type={tx.type} />
                  <div>
                    <p className="text-sm text-white">{tx.description}</p>
                    <p className="text-xs text-neutral-500">
                      {formatDistanceToNow(new Date(tx.created_at), {
                        addSuffix: true,
                      })}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <TransactionBadge type={tx.type} />
                  <span
                    className={cn(
                      "font-mono text-sm font-medium",
                      Number(tx.amount) >= 0 ? "text-emerald-400" : "text-red-400",
                    )}
                  >
                    {Number(tx.amount) >= 0 ? "+" : ""}${Math.abs(Number(tx.amount)).toFixed(4)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center text-neutral-500 py-8">
            <DollarSign className="h-10 w-10 mx-auto mb-3 text-neutral-600" />
            <p className="text-sm mb-1">No transactions yet</p>
            <p className="text-xs text-neutral-600">
              Transactions will appear here once you start earning
            </p>
          </div>
        )}
      </div>

      {/* Withdraw Dialog */}
      {summary && (
        <WithdrawDialog
          open={showWithdrawDialog}
          onOpenChange={setShowWithdrawDialog}
          appId={appId}
          withdrawableBalance={summary.withdrawableBalance}
          payoutThreshold={summary.payoutThreshold || PAYOUT_THRESHOLD}
          onSuccess={handleWithdrawSuccess}
        />
      )}
    </div>
  );
}

function TransactionIcon({ type }: { type: string }) {
  switch (type) {
    case "inference_markup":
      return <Zap className="h-4 w-4 text-purple-400" />;
    case "purchase_share":
      return <Coins className="h-4 w-4 text-yellow-400" />;
    case "withdrawal":
      return <ArrowUpRight className="h-4 w-4 text-red-400" />;
    default:
      return <DollarSign className="h-4 w-4 text-gray-400" />;
  }
}

function TransactionBadge({ type }: { type: string }) {
  switch (type) {
    case "inference_markup":
      return (
        <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30 text-[10px]">
          Inference
        </Badge>
      );
    case "purchase_share":
      return (
        <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[10px]">
          Purchase
        </Badge>
      );
    case "withdrawal":
      return (
        <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-[10px]">
          Withdrawal
        </Badge>
      );
    default:
      return (
        <Badge className="bg-white/10 text-neutral-400 border-white/20 text-[10px]">{type}</Badge>
      );
  }
}
