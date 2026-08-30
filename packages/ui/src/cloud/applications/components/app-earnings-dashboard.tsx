/**
 * Application detail — Earnings tab.
 * GET `/api/v1/apps/:id/earnings` goes through the typed `api` client.
 */

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
import { DashboardStatCard } from "../../../cloud-ui/components/brand";
import { MilestoneProgress } from "../../../cloud-ui/components/monetization";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { cn } from "../../../lib/utils";
import { api } from "../../lib/api-client";
import { WithdrawDialog } from "./withdraw-dialog";

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

interface EarningsResponse {
  success?: boolean;
  error?: string;
  testData?: boolean;
  monetization?: { enabled: boolean };
  earnings?: {
    summary: EarningsSummary;
    breakdown: {
      today: EarningsBreakdown;
      thisWeek: EarningsBreakdown;
      thisMonth: EarningsBreakdown;
      allTime: EarningsBreakdown;
    };
    chartData: ChartDataPoint[];
    recentTransactions: Transaction[];
  };
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
  const [monetizationEnabled, setMonetizationEnabled] = useState<
    boolean | null
  >(null);
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
      const query = new URLSearchParams({ days: period });
      if (testDataParam) query.set("testData", "true");

      const data = await api<EarningsResponse>(
        `/api/v1/apps/${appId}/earnings?${query.toString()}`,
      );

      if (data.success && data.earnings) {
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
      setError(
        err instanceof Error ? err.message : "Failed to load earnings data",
      );
    } finally {
      setIsLoading(false);
    }
  }, [appId, period, testDataParam]);

  useEffect(() => {
    fetchEarnings();
  }, [fetchEarnings]);

  const handleWithdrawSuccess = (newBalance: number) => {
    if (summary) {
      setSummary({ ...summary, withdrawableBalance: newBalance });
    }
    fetchEarnings();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-8 animate-spin text-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-card rounded-sm p-8 text-center">
        <AlertCircle className="size-12 mx-auto mb-4 text-destructive" />
        <h3 className="text-lg font-medium text-txt-strong mb-2">
          Error loading earnings
        </h3>
        <p className="text-neutral-400 mb-4 text-sm">{error}</p>
        <Button onClick={fetchEarnings} variant="outline">
          Try Again
        </Button>
      </div>
    );
  }

  const canWithdraw =
    summary &&
    summary.withdrawableBalance >=
      (summary.payoutThreshold || PAYOUT_THRESHOLD);

  return (
    <div className="space-y-4">
      {isTestData && (
        <Card flow="row" gap="compact" variant="insetPadded">
          <FlaskConical className="size-4 text-muted" />
          <p className="text-sm text-muted">
            Test Data Mode - Showing sample earnings data
          </p>
        </Card>
      )}

      {/* Period Selector */}
      <div className="flex justify-end">
        <Select
          value={period}
          onValueChange={(v) => setPeriod(v as typeof period)}
        >
          <SelectTrigger className="w-[140px] h-9 bg-card border-border rounded-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-card border-border rounded-sm">
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Empty State */}
      {!summary && !isLoading && (
        <div className="bg-card rounded-sm p-8 text-center">
          <TrendingUp className="size-12 mx-auto mb-4 text-neutral-600" />
          <h3 className="text-lg font-medium text-neutral-500 mb-2">
            No earnings yet
          </h3>
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
                  navigate(`/cloud/apps/${appId}?tab=monetization`);
                }}
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
          <Card variant="flatPadded">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-neutral-500">
                  Total Lifetime Earnings
                </p>
                <p className="text-2xl font-semibold text-txt-strong mt-1">
                  ${summary.totalLifetimeEarnings.toFixed(2)}
                </p>
                {breakdown && (
                  <p className="text-xs text-status-success mt-1 flex items-center gap-1">
                    <ArrowUpRight className="size-3" />$
                    {breakdown.thisWeek.total.toFixed(2)} this week
                  </p>
                )}
              </div>
              <TrendingUp className="size-5 text-muted" />
            </div>
          </Card>

          {/* Withdrawable Balance */}
          <div
            className={cn(
              "bg-card rounded-sm p-4",
              canWithdraw && "border border-status-success/30",
            )}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-neutral-500">Ready to Withdraw</p>
                <p className="text-2xl font-semibold text-status-success mt-1">
                  ${summary.withdrawableBalance.toFixed(2)}
                </p>
              </div>
              <Wallet className="size-5 text-status-success" />
            </div>
            <div className="mt-3">
              {canWithdraw ? (
                <Button
                  onClick={() => setShowWithdrawDialog(true)}
                  size="sm"
                  className="w-full"
                >
                  <Wallet className="size-4 mr-2" />
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
            icon={<Clock className="size-5" />}
            accent="amber"
          />
          <DashboardStatCard
            label="Withdrawable"
            value={`$${summary.withdrawableBalance.toFixed(2)}`}
            icon={<Wallet className="size-5" />}
            accent="emerald"
          />
          <DashboardStatCard
            label="From Inference"
            value={`$${summary.totalInferenceEarnings.toFixed(2)}`}
            icon={<Zap className="size-5" />}
            accent="violet"
          />
          <DashboardStatCard
            label="From Purchases"
            value={`$${summary.totalPurchaseEarnings.toFixed(2)}`}
            icon={<Coins className="size-5" />}
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
            <div key={label} className="bg-card rounded-sm p-3">
              <p className="text-xs text-neutral-500">{label}</p>
              <p className="text-lg font-semibold text-txt-strong mt-1">
                ${data.total.toFixed(2)}
              </p>
              <div className="flex gap-3 text-xs mt-2">
                <span className="text-accent flex items-center gap-1">
                  <Zap className="size-3" />${data.inferenceEarnings.toFixed(2)}
                </span>
                <span className="text-muted flex items-center gap-1">
                  <Coins className="size-3" />$
                  {data.purchaseEarnings.toFixed(2)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Chart */}
      <Card variant="flatPadded">
        <h3 className="text-sm font-medium text-txt mb-4 flex items-center gap-2">
          <BarChart3 className="size-4 text-neutral-400" />
          Earnings Over Time
        </h3>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={chartData}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(255,255,255,0.1)"
              />
              <XAxis
                dataKey="date"
                stroke="rgba(255,255,255,0.4)"
                style={{ fontSize: "12px" }}
              />
              <YAxis
                stroke="rgba(255,255,255,0.4)"
                style={{ fontSize: "12px" }}
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
                  const raw = Array.isArray(value) ? value[0] : value;
                  const numericValue = Number(raw);
                  if (!Number.isFinite(numericValue)) return "—";
                  return `$${numericValue.toFixed(4)}`;
                }}
              />
              <Legend />
              <Bar
                dataKey="inferenceEarnings"
                fill="var(--accent)"
                name="Inference Markup"
                stackId="a"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="purchaseEarnings"
                fill="var(--muted)"
                name="Purchase Share"
                stackId="a"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="text-center text-neutral-500 py-8">
            <DollarSign className="size-10 mx-auto mb-3 text-neutral-600" />
            <p className="text-sm">No earnings data yet</p>
          </div>
        )}
      </Card>

      {/* Recent Transactions */}
      <Card variant="flatPadded">
        <h3 className="text-sm font-medium text-txt mb-4 flex items-center gap-2">
          <Clock className="size-4 text-neutral-400" />
          Recent Earnings
        </h3>

        {transactions.length > 0 ? (
          <div className="space-y-2">
            {transactions.map((tx) => (
              <Card key={tx.id} flow="rowBetween" variant="insetPadded">
                <div className="flex items-center gap-3">
                  <TransactionIcon type={tx.type} />
                  <div>
                    <p className="text-sm text-txt">{tx.description}</p>
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
                      Number(tx.amount) >= 0
                        ? "text-status-success"
                        : "text-destructive",
                    )}
                  >
                    {Number(tx.amount) >= 0 ? "+" : ""}$
                    {Math.abs(Number(tx.amount)).toFixed(4)}
                  </span>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <div className="text-center text-neutral-500 py-8">
            <DollarSign className="size-10 mx-auto mb-3 text-neutral-600" />
            <p className="text-sm mb-1">No transactions yet</p>
            <p className="text-xs text-neutral-600">
              Transactions will appear here once you start earning
            </p>
          </div>
        )}
      </Card>

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
      return <Zap className="size-4 text-accent" />;
    case "purchase_share":
      return <Coins className="size-4 text-status-warning" />;
    case "withdrawal":
      return <ArrowUpRight className="size-4 text-destructive" />;
    default:
      return <DollarSign className="size-4 text-muted" />;
  }
}

function TransactionBadge({ type }: { type: string }) {
  switch (type) {
    case "inference_markup":
      return <Badge variant="default">Inference</Badge>;
    case "purchase_share":
      return <Badge variant="secondary">Purchase</Badge>;
    case "withdrawal":
      return <Badge variant="destructive">Withdrawal</Badge>;
    default:
      return <Badge variant="outline">{type}</Badge>;
  }
}
