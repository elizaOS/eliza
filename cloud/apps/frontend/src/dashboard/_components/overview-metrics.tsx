/**
 * Overview metrics component displaying credit balance.
 * Shows wallet icon and formatted balance amount.
 *
 * @param props - Overview metrics configuration
 * @param props.creditBalance - Current credit balance
 * @param props.className - Additional CSS classes
 */

"use client";

import { BrandCard } from "@elizaos/cloud-ui";
import { Wallet } from "lucide-react";
import { cn } from "@/lib/utils";

interface OverviewMetricsProps {
  creditBalance: number;
  className?: string;
}

export function OverviewMetrics({ creditBalance, className }: OverviewMetricsProps) {
  return (
    <div className={cn("", className)}>
      <BrandCard
        corners={false}
        className="group hover:border-white/20 transition-all duration-200"
      >
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex-shrink-0 inline-flex p-2 rounded-sm border bg-gradient-to-br",
              "from-[#FF5800]/20 to-orange-600/20 border-[#FF5800]/30",
            )}
          >
            <Wallet className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-medium text-white/40 uppercase tracking-wide mb-0.5">
              Balance
            </p>
            <p className="text-2xl font-semibold text-white tracking-tight">
              ${creditBalance.toFixed(2)}
            </p>
          </div>
        </div>
      </BrandCard>
    </div>
  );
}

// Skeleton loader for overview metrics
export function OverviewMetricsSkeleton() {
  return (
    <BrandCard corners={false}>
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 inline-flex p-2.5 rounded-sm border border-white/10 bg-white/5">
          <div className="h-5 w-5 bg-white/10 animate-pulse rounded" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="h-3 w-16 bg-white/10 animate-pulse rounded mb-2" />
          <div className="h-8 w-20 bg-white/10 animate-pulse rounded" />
        </div>
      </div>
    </BrandCard>
  );
}
