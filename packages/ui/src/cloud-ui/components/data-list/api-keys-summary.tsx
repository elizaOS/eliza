import { CalendarClock, KeyRound, ShieldCheck, Signal } from "lucide-react";

import { StatSummary } from "./stat-summary";

export interface ApiKeysSummaryData {
  totalKeys: number;
  activeKeys: number;
  monthlyUsage: number;
  rateLimit: number;
  lastGeneratedAt?: string | null;
}

export interface ApiKeysSummaryProps {
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
      icon: KeyRound,
    },
    {
      title: "Active keys",
      value: summary.activeKeys,
      icon: ShieldCheck,
    },
    {
      title: "Monthly usage",
      value: summary.monthlyUsage,
      description: `Requests this month - ${summary.rateLimit.toLocaleString()} rpm`,
      icon: Signal,
    },
    {
      title: "Last generated",
      value: summary.lastGeneratedAt
        ? new Date(summary.lastGeneratedAt).toLocaleDateString()
        : "Not yet",
      icon: CalendarClock,
    },
  ] as const;

  return (
    <StatSummary
      items={items}
      formatValue={(value) =>
        typeof value === "number" ? numberFormatter.format(value) : value
      }
    />
  );
}
