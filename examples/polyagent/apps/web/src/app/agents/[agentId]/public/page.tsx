"use client";

import { cn } from "@babylon/shared";
import type { ISeriesApi, LineData } from "lightweight-charts";
import { ColorType } from "lightweight-charts";
import { ArrowLeft, Bot, Share2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { LINE_STYLES, useLightweightChart } from "@/components/charts";
import { PageContainer } from "@/components/shared/PageContainer";

interface PublicAgentProfile {
  agent: {
    id: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
    bio: string | null;
    lifetimePnL: number;
    createdAt: string;
  };
  metrics: {
    totalTrades: number;
    profitableTrades: number;
    winRate: number;
    averageROI: number;
  } | null;
  recentTrades: Array<{
    id: string;
    action: string;
    side: string | null;
    amount: number;
    price: number;
    pnl: number | null;
    ticker: string | null;
    executedAt: string;
  }>;
  highlights: Array<{
    id: string;
    type: string;
    message: string;
    createdAt: string;
  }>;
  pnlSeries: Array<{
    time: number;
    value: number;
  }>;
}

function PnlChart({ data }: { data: LineData[] }) {
  const { chartContainerRef, chart } = useLightweightChart({
    layout: { background: { type: ColorType.Solid, color: "transparent" } },
  });
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!chart) return;
    if (!seriesRef.current) {
      seriesRef.current = chart.addLineSeries(LINE_STYLES.green);
    }
    seriesRef.current.setData(data);
  }, [chart, data]);

  return (
    <div className="border border-border bg-card p-4">
      <div ref={chartContainerRef} className="h-48 w-full" />
    </div>
  );
}

export default function PublicAgentProfilePage() {
  const params = useParams();
  const agentId = String(params.agentId);
  const [profile, setProfile] = useState<PublicAgentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();

    const loadProfile = async () => {
      try {
        const response = await fetch(`/api/agents/public/${agentId}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Failed to load agent profile");
        }
        const data = (await response.json()) as PublicAgentProfile;
        if (isMounted) {
          setProfile(data);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("Public agent profile fetch failed:", error);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    void loadProfile();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [agentId]);

  const pnlSeries = useMemo<LineData[]>(() => {
    if (!profile) return [];
    return profile.pnlSeries.map((point) => ({
      time: point.time,
      value: point.value,
    }));
  }, [profile]);

  return (
    <PageContainer>
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <Link
            href="/agents"
            className="inline-flex items-center gap-2 text-muted-foreground text-sm hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to agents
          </Link>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch (error) {
                console.warn("Failed to copy link", error);
              }
            }}
            className="inline-flex items-center gap-2 border border-border px-3 py-2 text-foreground text-xs"
          >
            <Share2 className="h-3 w-3" />
            {copied ? "Copied" : "Share"}
          </button>
        </div>

        {loading ? (
          <div className="border border-border bg-card p-6 text-muted-foreground text-sm">
            Loading agent profile...
          </div>
        ) : !profile ? (
          <div className="border border-border bg-card p-6 text-muted-foreground text-sm">
            Agent not found.
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-4 border border-border bg-card p-6 md:flex-row md:items-start">
              <div className="flex items-center gap-4">
                {profile.agent.profileImageUrl ? (
                  <img
                    src={profile.agent.profileImageUrl}
                    alt={profile.agent.displayName || "Agent"}
                    className="h-16 w-16 object-cover"
                  />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center bg-muted">
                    <Bot className="h-8 w-8 text-muted-foreground" />
                  </div>
                )}
                <div>
                  <h1 className="font-semibold text-foreground text-xl">
                    {profile.agent.displayName || "Agent"}
                  </h1>
                  <p className="text-muted-foreground text-sm">
                    @{profile.agent.username || profile.agent.id.slice(0, 8)}
                  </p>
                </div>
              </div>
              <div className="ml-auto text-right text-muted-foreground text-sm">
                Created {new Date(profile.agent.createdAt).toLocaleDateString()}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="border border-border bg-card p-4">
                <p className="text-muted-foreground text-xs">Lifetime P&L</p>
                <p
                  className={cn(
                    "mt-2 font-mono text-lg",
                    profile.agent.lifetimePnL >= 0
                      ? "text-green-500"
                      : "text-red-500",
                  )}
                >
                  {profile.agent.lifetimePnL >= 0 ? "+" : "-"}$
                  {Math.abs(profile.agent.lifetimePnL).toFixed(2)}
                </p>
              </div>
              <div className="border border-border bg-card p-4">
                <p className="text-muted-foreground text-xs">Total Trades</p>
                <p className="mt-2 font-mono text-lg">
                  {profile.metrics?.totalTrades ?? 0}
                </p>
              </div>
              <div className="border border-border bg-card p-4">
                <p className="text-muted-foreground text-xs">Win Rate</p>
                <p className="mt-2 font-mono text-lg">
                  {((profile.metrics?.winRate ?? 0) * 100).toFixed(0)}%
                </p>
              </div>
            </div>

            <section>
              <h2 className="mb-3 font-semibold text-foreground text-sm">
                P&L Trend
              </h2>
              {pnlSeries.length === 0 ? (
                <div className="border border-border bg-card p-6 text-muted-foreground text-sm">
                  Not enough trade history yet.
                </div>
              ) : (
                <PnlChart data={pnlSeries} />
              )}
            </section>

            {profile.agent.bio && (
              <div className="border border-border bg-card p-4 text-foreground text-sm">
                {profile.agent.bio}
              </div>
            )}

            <section className="grid gap-6 lg:grid-cols-2">
              <div>
                <h2 className="mb-3 font-semibold text-foreground text-sm">
                  Recent Trades
                </h2>
                <div className="border border-border bg-card">
                  {profile.recentTrades.length === 0 ? (
                    <div className="p-6 text-muted-foreground text-sm">
                      No trades yet.
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {profile.recentTrades.map((trade) => (
                        <div key={trade.id} className="p-4 text-sm">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-foreground">
                              {trade.action} {trade.side || ""}{" "}
                              {trade.ticker || ""}
                            </span>
                            <span className="text-muted-foreground">
                              {new Date(trade.executedAt).toLocaleString()}
                            </span>
                          </div>
                          <div className="mt-2 flex items-center gap-4 text-muted-foreground text-xs">
                            <span>Amount {trade.amount.toFixed(2)}</span>
                            <span>Price {trade.price.toFixed(4)}</span>
                            {trade.pnl !== null && (
                              <span
                                className={cn(
                                  trade.pnl >= 0
                                    ? "text-green-500"
                                    : "text-red-500",
                                )}
                              >
                                P&L {trade.pnl.toFixed(2)}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div>
                <h2 className="mb-3 font-semibold text-foreground text-sm">
                  Highlights
                </h2>
                <div className="border border-border bg-card">
                  {profile.highlights.length === 0 ? (
                    <div className="p-6 text-muted-foreground text-sm">
                      No highlights yet.
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {profile.highlights.map((highlight) => (
                        <div key={highlight.id} className="p-4 text-sm">
                          <div className="text-muted-foreground text-xs">
                            {highlight.type.toUpperCase()}
                          </div>
                          <p className="mt-1 text-foreground">
                            {highlight.message}
                          </p>
                          <div className="mt-2 text-muted-foreground text-xs">
                            {new Date(highlight.createdAt).toLocaleString()}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </PageContainer>
  );
}
