/**
 * Application detail — tab bar + tab content router.
 * The active tab is the `?tab=` search param (so deep links + the create flow's
 * `?tab=monetization` redirect work).
 */

import {
  BarChart3,
  DollarSign,
  Globe,
  Grid3x3,
  Megaphone,
  Rocket,
  Settings,
  TrendingUp,
  Users,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { cn } from "../../../lib/utils";
import { useCloudT } from "../../shell/CloudI18nProvider";
import type { App } from "../lib/apps";
import { AppAnalytics } from "./app-analytics";
import { AppDomains } from "./app-domains";
import { AppEarningsDashboard } from "./app-earnings-dashboard";
import { AppFrontendHosting } from "./app-frontend-hosting";
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
  | "hosting"
  | "domains"
  | "promote"
  | "analytics"
  | "earnings"
  | "monetization"
  | "users"
  | "settings";

export function AppDetailsTabs({ app, showApiKey }: AppDetailsTabsProps) {
  const t = useCloudT();
  const tabs: {
    value: TabValue;
    label: string;
    icon: typeof Grid3x3;
  }[] = [
    {
      value: "overview",
      label: t("cloud.apps.tab.overview", { defaultValue: "Overview" }),
      icon: Grid3x3,
    },
    {
      value: "monetization",
      label: t("cloud.apps.tab.monetize", { defaultValue: "Monetize" }),
      icon: DollarSign,
    },
    {
      value: "earnings",
      label: t("cloud.apps.tab.earnings", { defaultValue: "Earnings" }),
      icon: TrendingUp,
    },
    {
      value: "hosting",
      label: t("cloud.apps.tab.hosting", { defaultValue: "Hosting" }),
      icon: Rocket,
    },
    {
      value: "domains",
      label: t("cloud.apps.tab.domains", { defaultValue: "Domains" }),
      icon: Globe,
    },
    {
      value: "analytics",
      label: t("cloud.apps.tab.analytics", { defaultValue: "Analytics" }),
      icon: BarChart3,
    },
    {
      value: "promote",
      label: t("cloud.apps.tab.promote", { defaultValue: "Promote" }),
      icon: Megaphone,
    },
    {
      value: "users",
      label: t("cloud.apps.tab.users", { defaultValue: "Users" }),
      icon: Users,
    },
    {
      value: "settings",
      label: t("cloud.apps.tab.settings", { defaultValue: "Settings" }),
      icon: Settings,
    },
  ];
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const activeTab = (searchParams.get("tab") || "overview") as TabValue;

  const handleTabChange = (value: TabValue) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("showApiKey");
    params.set("tab", value);
    navigate(`/dashboard/apps/${app.id}?${params.toString()}`, {
      preventScrollReset: true,
    });
  };

  return (
    <div className="space-y-3 sm:space-y-6">
      {/* Tabs */}
      <div className="grid grid-cols-2 gap-1 rounded-sm border border-border bg-bg-accent p-1 sm:grid-cols-3 xl:grid-cols-9">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              type="button"
              key={tab.value}
              onClick={() => handleTabChange(tab.value)}
              className={cn(
                "flex min-w-0 items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium transition-colors sm:text-sm",
                activeTab === tab.value
                  ? "bg-card text-txt"
                  : "text-muted hover:bg-surface hover:text-txt",
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
        {activeTab === "overview" && (
          <AppOverview app={app} showApiKey={showApiKey} />
        )}
        {activeTab === "hosting" && <AppFrontendHosting appId={app.id} />}
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
