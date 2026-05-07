"use client";

import {
  BarChart3,
  DollarSign,
  Globe,
  Grid3x3,
  Megaphone,
  Settings,
  TrendingUp,
  Users,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { AppDto as App } from "@/types/cloud-api";
import { cn } from "@/lib/utils";
import { AppAnalytics } from "./app-analytics";
import { AppDomains } from "./app-domains";
import { AppEarningsDashboard } from "./app-earnings-dashboard";
import { AppMonetizationSettings } from "./app-monetization-settings";
import { AppOverview } from "./app-overview";
import { AppPromote } from "./app-promote";
import { AppSettings } from "./app-settings";
import { AppUsers } from "./app-users";

interface AppDetailsTabsProps {
  app: App;
  showApiKey?: string;
}

type TabValue =
  | "overview"
  | "domains"
  | "promote"
  | "analytics"
  | "earnings"
  | "monetization"
  | "users"
  | "settings";

// "Build" tab intentionally absent — the codebuilder it linked to
// (/dashboard/apps/create) is currently disabled and redirects back
// to the apps list, so a Build tab would loop. App creation happens
// through CreateAppDialog (manual) or the cloud SDK (agent path).
const tabs: {
  value: TabValue;
  label: string;
  icon: typeof Grid3x3;
}[] = [
  { value: "overview", label: "Overview", icon: Grid3x3 },
  { value: "monetization", label: "Monetize", icon: DollarSign },
  { value: "earnings", label: "Earnings", icon: TrendingUp },
  { value: "domains", label: "Domains", icon: Globe },
  { value: "analytics", label: "Analytics", icon: BarChart3 },
  { value: "promote", label: "Promote", icon: Megaphone },
  { value: "users", label: "Users", icon: Users },
  { value: "settings", label: "Settings", icon: Settings },
];

export function AppDetailsTabs({ app, showApiKey }: AppDetailsTabsProps) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const activeTab = (searchParams.get("tab") || "overview") as TabValue;

  const handleTabChange = (value: TabValue) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", value);
    navigate(`/dashboard/apps/${app.id}?${params.toString()}`, { preventScrollReset: true });
  };

  return (
    <div className="space-y-3 sm:space-y-6">
      {/* Tabs */}
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-neutral-900 p-1 sm:grid-cols-4 xl:grid-cols-8">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.value}
              onClick={() => handleTabChange(tab.value)}
              className={cn(
                "flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors sm:text-sm",
                activeTab === tab.value
                  ? "bg-white/10 text-white"
                  : "text-neutral-400 hover:text-white",
              )}
            >
              <Icon className="h-4 w-4 hidden sm:block" />
              <span className="truncate">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="min-w-0">
        {activeTab === "overview" && <AppOverview app={app} showApiKey={showApiKey} />}
        {activeTab === "domains" && <AppDomains appId={app.id} />}
        {activeTab === "promote" && <AppPromote app={app} />}
        {activeTab === "analytics" && <AppAnalytics appId={app.id} />}
        {activeTab === "earnings" && <AppEarningsDashboard appId={app.id} />}
        {activeTab === "monetization" && <AppMonetizationSettings appId={app.id} />}
        {activeTab === "users" && <AppUsers appId={app.id} />}
        {activeTab === "settings" && <AppSettings app={app} />}
      </div>
    </div>
  );
}
