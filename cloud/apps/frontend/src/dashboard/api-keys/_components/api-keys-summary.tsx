/**
 * API keys summary component displaying key statistics in a grid layout.
 * Shows total keys, active keys, monthly usage, and last generated timestamp.
 *
 * @param props - API keys summary configuration
 * @param props.summary - Summary data including key counts and usage statistics
 */

import { BrandCard } from "@elizaos/cloud-ui";
import { CalendarClock, KeyRound, ShieldCheck, Signal } from "lucide-react";
import type { ApiKeysSummaryData } from "./types";

interface ApiKeysSummaryProps {
  summary: ApiKeysSummaryData;
}

const numberFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function ApiKeysSummary({ summary }: ApiKeysSummaryProps) {
  const items = [
    {
      title: "Total keys",
      value: summary.totalKeys,
      description: "Across your organization",
      icon: KeyRound,
    },
    {
      title: "Active keys",
      value: summary.activeKeys,
      description: "Currently enabled",
      icon: ShieldCheck,
    },
    {
      title: "Monthly usage",
      value: summary.monthlyUsage,
      description: `Requests this month • ${summary.rateLimit.toLocaleString()} rpm`,
      icon: Signal,
    },
    {
      title: "Last generated",
      value: summary.lastGeneratedAt
        ? new Date(summary.lastGeneratedAt).toLocaleDateString()
        : "Not yet",
      description: "Creation activity",
      icon: CalendarClock,
    },
  ] as const;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => (
        <BrandCard key={item.title} corners={false} className="p-4">
          <div className="flex flex-row items-center justify-between space-y-0 pb-2">
            <h4 className="text-sm font-medium text-white/50 uppercase tracking-wide">
              {item.title}
            </h4>
            <item.icon className="h-5 w-5 text-[#FF5800]" />
          </div>
          <div>
            <div className="text-2xl font-semibold text-white mt-2">
              {typeof item.value === "string" ? item.value : numberFormatter.format(item.value)}
            </div>
            <p className="text-xs text-white/60 mt-1">{item.description}</p>
          </div>
        </BrandCard>
      ))}
    </div>
  );
}
