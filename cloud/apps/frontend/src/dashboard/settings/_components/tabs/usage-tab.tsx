/**
 * Usage settings tab component displaying credit usage and quota information.
 * Shows daily burn rate, session statistics, and quota usage by model.
 *
 * @param props - Usage tab configuration
 * @param props.user - User data with organization information
 * @param props.onTabChange - Callback to switch to other settings tabs
 */

"use client";

import { BrandCard, CornerBrackets } from "@elizaos/cloud-ui";
import { DollarSign, Info, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { UserWithOrganizationDto } from "@/types/cloud-api";
import type { SettingsTab } from "../types";

interface UsageTabProps {
  user: UserWithOrganizationDto;
  onTabChange: (tab: SettingsTab) => void;
}

interface SessionStats {
  credits_used: number;
  requests_made: number;
  tokens_consumed: number;
}

interface QuotaUsage {
  global: {
    used: number;
    limit: number | null;
    periodEnd: string | null;
  };
  modelSpecific: Record<
    string,
    {
      used: number;
      limit: number;
      periodEnd: string;
    }
  >;
}

export function UsageTab({ user, onTabChange }: UsageTabProps) {
  const [loading, setLoading] = useState(false);
  const [dailyBurn, setDailyBurn] = useState(0);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [quotaUsage, setQuotaUsage] = useState<QuotaUsage | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);

  const creditsRemaining = Number(user.organization?.credit_balance || 0);

  useEffect(() => {
    const fetchDailyBurn = async () => {
      setLoading(true);

      try {
        const response = await fetch("/api/credits/transactions?hours=24");

        if (!response.ok) {
          throw new Error("Failed to fetch transactions");
        }

        const data = await response.json();

        interface Transaction {
          amount: string | number;
        }
        const transactions: Transaction[] = Array.isArray(data.transactions)
          ? data.transactions.filter(
              (t: unknown): t is Transaction =>
                typeof t === "object" &&
                t !== null &&
                "amount" in t &&
                (typeof (t as { amount: unknown }).amount === "string" ||
                  typeof (t as { amount: unknown }).amount === "number"),
            )
          : [];
        const burn = transactions
          .filter((t) => Number(t.amount) < 0)
          .reduce((sum: number, t: Transaction) => sum + Math.abs(Number(t.amount)), 0);

        setDailyBurn(burn);
      } catch (error) {
        console.error("Error fetching daily burn:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchDailyBurn();
  }, []);

  useEffect(() => {
    const fetchSessionStats = async () => {
      setSessionLoading(true);

      const response = await fetch("/api/sessions/current");

      if (!response.ok) {
        throw new Error("Failed to fetch session stats");
      }

      const data = await response.json();

      if (data.success && data.data) {
        setSessionStats(data.data);
      }
      setSessionLoading(false);
    };

    fetchSessionStats();

    const interval = setInterval(fetchSessionStats, 30000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const fetchQuotaUsage = async () => {
      setQuotaLoading(true);

      const response = await fetch("/api/quotas/usage");

      if (!response.ok) {
        throw new Error("Failed to fetch quota usage");
      }

      const data = await response.json();

      if (data.success && data.data) {
        setQuotaUsage(data.data);
      }
      setQuotaLoading(false);
    };

    fetchQuotaUsage();

    const interval = setInterval(fetchQuotaUsage, 60000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col gap-4 md:gap-6 pb-6 md:pb-8">
      {/* Credits Overview Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-4 md:space-y-6">
          {/* Header */}
          <div className="flex flex-col gap-3 md:gap-2 w-full">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                  Build, deploy, and monitor your ai agents
                </h3>
              </div>
              <p className="text-xs font-mono text-[#858585] tracking-tight">
                Monitor how your team is consuming credits and track associated costs.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Info className="h-4 w-4 text-[#848484] flex-shrink-0" />
              <p className="text-xs md:text-sm text-[#848484]">Last updated: just now</p>
            </div>
          </div>

          {/* Credits Section */}
          <div className="space-y-0 w-full">
            {/* Credits Remaining */}
            <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border border-brand-surface p-3 md:p-4 space-y-3 md:space-y-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 w-full">
                <p className="text-sm md:text-base font-mono text-white">Credits Remaining</p>
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[#FF5800]" />
                ) : (
                  <p className="text-xs text-[#FF5800]">${dailyBurn.toFixed(2)} daily burn</p>
                )}
              </div>

              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <div className="bg-[rgba(255,88,0,0.25)] flex items-center justify-center size-7">
                    <DollarSign className="h-[13px] w-[13px] text-[#FF5800]" />
                  </div>
                  <p className="text-2xl font-mono text-white tracking-tight">
                    ${creditsRemaining.toFixed(2)}
                  </p>
                </div>
                <p className="text-sm text-white/60">Current organization&apos;s credit balance</p>
              </div>
            </div>

            {/* Current Session */}
            <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-t-0 border border-brand-surface p-3 md:p-4 space-y-3 md:space-y-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
                <p className="text-sm md:text-base font-mono text-white">Current Session</p>
                {sessionLoading && !sessionStats ? (
                  <Loader2 className="h-4 w-4 animate-spin text-[#FF5800]" />
                ) : (
                  <p className="text-xs text-[#848484]">Updates every 30 seconds</p>
                )}
              </div>

              {sessionStats ? (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
                  <div className="space-y-1">
                    <p className="text-xs text-white/60 font-mono">Credits Used</p>
                    <p className="text-base md:text-lg font-mono text-white">
                      ${sessionStats.credits_used.toFixed(2)}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-white/60 font-mono">Requests</p>
                    <p className="text-base md:text-lg font-mono text-white">
                      {sessionStats.requests_made.toLocaleString()}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-white/60 font-mono">Tokens</p>
                    <p className="text-base md:text-lg font-mono text-white">
                      {sessionStats.tokens_consumed.toLocaleString()}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-xs md:text-sm text-white/60">
                  No active session data available.
                </p>
              )}
            </div>
          </div>
        </div>
      </BrandCard>

      {/* Weekly Limits Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-4 md:space-y-6">
          {/* Header */}
          <div className="flex flex-col gap-3 md:gap-2 w-full">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                  Weekly limits
                </h3>
              </div>
              <p className="text-xs font-mono text-[#858585] tracking-tight">
                Configure weekly credit limits to control spending across all models or specific
                models.
              </p>
            </div>

            <div className="flex items-center gap-2">
              {quotaLoading && !quotaUsage ? (
                <Loader2 className="h-4 w-4 animate-spin text-[#FF5800]" />
              ) : (
                <>
                  <Info className="h-4 w-4 text-[#848484] flex-shrink-0" />
                  <p className="text-xs md:text-sm text-[#848484]">Updates every 60 seconds</p>
                </>
              )}
            </div>
          </div>

          {/* Limits Section */}
          <div className="space-y-0 w-full">
            {/* All models */}
            <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border border-brand-surface p-3 md:p-4 space-y-3 md:space-y-4">
              <p className="text-sm md:text-base font-mono text-white">All models</p>

              <div className="space-y-1">
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 w-full">
                  <div className="flex-1 w-full relative h-[21px] border border-[#e1e1e1] border-[0.5px]">
                    <div
                      className="absolute inset-0 bg-[#FF5800]/20"
                      style={{
                        width: quotaUsage?.global.limit
                          ? `${Math.min(100, (quotaUsage.global.used / quotaUsage.global.limit) * 100)}%`
                          : "0%",
                      }}
                    />
                  </div>
                  <p className="text-xs sm:text-sm md:text-base font-mono text-white tracking-tight whitespace-nowrap">
                    {quotaUsage?.global.limit
                      ? `$${quotaUsage.global.used.toFixed(2)} / $${quotaUsage.global.limit.toFixed(2)}`
                      : "No limit set"}
                  </p>
                </div>
                <p className="text-xs md:text-sm text-white/60">
                  {quotaUsage?.global.limit
                    ? `${((quotaUsage.global.used / quotaUsage.global.limit) * 100).toFixed(1)}% of weekly limit used`
                    : "Weekly usage limits not configured"}
                </p>
              </div>
            </div>

            {/* Model-specific limits */}
            {quotaUsage && Object.keys(quotaUsage.modelSpecific).length > 0 ? (
              Object.entries(quotaUsage.modelSpecific).map(([modelName, modelQuota]) => (
                <div
                  key={modelName}
                  className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-t-0 border border-brand-surface p-3 md:p-4 space-y-3 md:space-y-4"
                >
                  <div className="flex items-center gap-2">
                    <p className="text-sm md:text-base font-mono text-white capitalize">
                      {modelName}
                    </p>
                    <Info className="h-4 w-4 text-[#FF5800]/60 flex-shrink-0" />
                  </div>

                  <div className="space-y-1">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 w-full">
                      <div className="flex-1 w-full relative h-[21px] border border-[#e1e1e1] border-[0.5px]">
                        <div
                          className="absolute inset-0 bg-[#FF5800]/20"
                          style={{
                            width: `${Math.min(100, (modelQuota.used / modelQuota.limit) * 100)}%`,
                          }}
                        />
                      </div>
                      <p className="text-xs sm:text-sm md:text-base font-mono text-white tracking-tight whitespace-nowrap">
                        ${modelQuota.used.toFixed(2)} / ${modelQuota.limit.toFixed(2)}
                      </p>
                    </div>
                    <p className="text-xs md:text-sm text-white/60">
                      {((modelQuota.used / modelQuota.limit) * 100).toFixed(1)}% of weekly limit
                      used
                    </p>
                  </div>
                </div>
              ))
            ) : !quotaUsage?.global.limit ? (
              <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-t-0 border border-brand-surface p-3 md:p-4">
                <p className="text-xs md:text-sm text-white/60">
                  No model-specific limits configured. Contact your administrator to set up weekly
                  quotas.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </BrandCard>

      {/* Usage Signals Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-4 md:space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between w-full">
            <div className="flex flex-col gap-2 flex-1">
              <div className="flex items-center gap-2 w-full">
                <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase flex-1">
                  Usage Signals
                </h3>
              </div>
              <p className="text-xs font-mono text-[#858585] tracking-tight">
                Key items from spend automations, quota monitors, and provider health.
              </p>
            </div>
          </div>

          {/* Status Card */}
          <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border border-brand-surface p-3 md:p-4 space-y-2">
            <div className="flex items-center gap-2">
              <p className="text-sm md:text-base font-mono text-white">
                {creditsRemaining > 10 ? "All systems operational" : "Low credit balance"}
              </p>
              <Info
                className={`h-4 w-4 flex-shrink-0 ${creditsRemaining > 10 ? "text-[#FF5800]" : "text-yellow-500"}`}
              />
            </div>

            <p className="text-xs md:text-sm text-white/60">
              {creditsRemaining > 10
                ? "Your infrastructure is running smoothly. All providers are healthy and credit balance is sufficient."
                : "Your credit balance is low. Consider adding more credits to ensure uninterrupted service."}
            </p>

            {creditsRemaining <= 10 && (
              <button
                type="button"
                onClick={() => onTabChange("billing")}
                className="relative bg-[#e1e1e1] px-4 py-2.5 overflow-hidden hover:bg-white transition-colors mt-2 w-full sm:w-auto"
              >
                <div
                  className="absolute inset-0 opacity-20 bg-repeat pointer-events-none"
                  style={{
                    backgroundImage: `url(/assets/settings/pattern-6px-flip.png)`,
                    backgroundSize: "2.915576934814453px 2.915576934814453px",
                  }}
                />
                <span className="relative z-10 text-black font-mono font-medium text-sm whitespace-nowrap">
                  Add Credits
                </span>
              </button>
            )}
          </div>
        </div>
      </BrandCard>
    </div>
  );
}
