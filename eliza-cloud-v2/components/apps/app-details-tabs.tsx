"use client";

import { useSearchParams, useRouter } from "next/navigation";
import {
  Grid3x3,
  Settings,
  BarChart3,
  Users,
  DollarSign,
  TrendingUp,
  Sparkles,
  Globe,
  Megaphone,
  ExternalLink,
} from "lucide-react";
import { AppOverview } from "./app-overview";
import { AppSettings } from "./app-settings";
import { AppAnalytics } from "./app-analytics";
import { AppUsers } from "./app-users";
import { AppMonetizationSettings } from "./app-monetization-settings";
import { AppEarningsDashboard } from "./app-earnings-dashboard";
import { AppDomains } from "./app-domains";
import { AppPromote } from "./app-promote";
import type { App } from "@/db/schemas";
import { cn } from "@/lib/utils";

interface AppDetailsTabsProps {
  app: App;
  showApiKey?: string;
}

type TabValue =
  | "overview"
  | "build"
  | "domains"
  | "promote"
  | "analytics"
  | "earnings"
  | "monetization"
  | "users"
  | "settings";

const tabs: {
  value: TabValue;
  label: string;
  icon: typeof Grid3x3;
  external?: boolean;
}[] = [
  { value: "overview", label: "Overview", icon: Grid3x3 },
  { value: "build", label: "Build", icon: Sparkles, external: true },
  { value: "domains", label: "Domains", icon: Globe },
  { value: "promote", label: "Promote", icon: Megaphone },
  { value: "analytics", label: "Analytics", icon: BarChart3 },
  { value: "earnings", label: "Earnings", icon: TrendingUp },
  { value: "monetization", label: "Monetize", icon: DollarSign },
  { value: "users", label: "Users", icon: Users },
  { value: "settings", label: "Settings", icon: Settings },
];

export function AppDetailsTabs({ app, showApiKey }: AppDetailsTabsProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const activeTab = (searchParams.get("tab") || "overview") as TabValue;

  const handleTabChange = (value: TabValue) => {
    // Redirect "build" tab to the unified App Creator page
    if (value === "build") {
      router.push(`/dashboard/apps/create?appId=${app.id}`);
      return;
    }

    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", value);
    router.push(`/dashboard/apps/${app.id}?${params.toString()}`, {
      scroll: false,
    });
  };

  return (
    <div className="space-y-3 sm:space-y-6">
      {/* Tabs */}
      <div className="grid grid-cols-3 lg:grid-cols-5 xl:grid-cols-9 gap-1 p-1 bg-neutral-900 rounded-lg">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.value}
              onClick={() => handleTabChange(tab.value)}
              className={cn(
                "flex items-center justify-center gap-1.5 px-2 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap",
                activeTab === tab.value
                  ? "bg-white/10 text-white"
                  : "text-neutral-400 hover:text-white",
              )}
            >
              <Icon className="h-4 w-4 hidden sm:block" />
              <span>{tab.label}</span>
              {tab.external && <ExternalLink className="h-3 w-3 opacity-50" />}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="min-w-0">
        {activeTab === "overview" && (
          <AppOverview app={app} showApiKey={showApiKey} />
        )}
        {activeTab === "domains" && <AppDomains appId={app.id} />}
        {activeTab === "promote" && <AppPromote app={app} />}
        {activeTab === "analytics" && <AppAnalytics appId={app.id} />}
        {activeTab === "earnings" && <AppEarningsDashboard appId={app.id} />}
        {activeTab === "monetization" && (
          <AppMonetizationSettings appId={app.id} />
        )}
        {activeTab === "users" && <AppUsers appId={app.id} />}
        {activeTab === "settings" && <AppSettings app={app} />}
      </div>
    </div>
  );
}
