import { CalendarClock, KeyRound, ShieldCheck, Signal } from "lucide-react";

import { type KeyMetric, KeyMetricsGrid } from "../brand/key-metrics-grid";

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
  const metrics: KeyMetric[] = [
    {
      label: "Total keys",
      value: numberFormatter.format(summary.totalKeys),
      icon: KeyRound,
    },
    {
      label: "Active keys",
      value: numberFormatter.format(summary.activeKeys),
      icon: ShieldCheck,
    },
    {
      label: "Monthly usage",
      value: numberFormatter.format(summary.monthlyUsage),
      helper: `Requests this month - ${summary.rateLimit.toLocaleString()} rpm`,
      icon: Signal,
    },
    {
      label: "Last generated",
      value: summary.lastGeneratedAt
        ? new Date(summary.lastGeneratedAt).toLocaleDateString()
        : "Not yet",
      icon: CalendarClock,
    },
  ];

  return <KeyMetricsGrid metrics={metrics} />;
}
