/**
 * Cloud publication detail tabs for both routed console pages and an embedded
 * project panel. Routed callers persist the active tab in `?tab=`; embedded
 * callers control it directly while reusing the same management components.
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
import { Button } from "../../../components/ui/button";
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
import { AppSettings, type AppSettingsProps } from "./app-settings";
import { AppUsers } from "./app-users";

export interface AppDetailsTabsProps {
  app: App;
  showApiKey?: string;
  activeTab?: AppDetailsTabValue;
  onTabChange?: (tab: AppDetailsTabValue) => void;
  settingsProps?: Omit<AppSettingsProps, "app">;
}

export type AppDetailsTabValue =
  | "overview"
  | "hosting"
  | "domains"
  | "promote"
  | "analytics"
  | "earnings"
  | "monetization"
  | "users"
  | "settings";

export function AppDetailsTabs({
  app,
  showApiKey,
  activeTab: controlledTab,
  onTabChange,
  settingsProps,
}: AppDetailsTabsProps) {
  const t = useCloudT();
  const tabs: {
    value: AppDetailsTabValue;
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
  const requestedTab = searchParams.get("tab");
  const routeTab = tabs.some((tab) => tab.value === requestedTab)
    ? (requestedTab as AppDetailsTabValue)
    : "overview";
  const activeTab = controlledTab ?? routeTab;

  const handleTabChange = (value: AppDetailsTabValue) => {
    if (onTabChange) {
      onTabChange(value);
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    params.delete("showApiKey");
    params.set("tab", value);
    navigate(`/dashboard/apps/${app.id}?${params.toString()}`, {
      preventScrollReset: true,
    });
  };

  return (
    <div className="space-y-3 sm:space-y-6">
      <div className="grid grid-cols-2 gap-1 rounded-sm border border-border bg-bg-accent p-1 sm:grid-cols-3 xl:grid-cols-9">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <Button
              variant="ghost"
              type="button"
              key={tab.value}
              onClick={() => handleTabChange(tab.value)}
              className={cn(
                "flex min-w-0 items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium transition-colors sm:text-sm",
                activeTab === tab.value
                  ? "bg-card text-txt"
                  : "text-muted hover:bg-bg-hover hover:text-txt",
              )}
            >
              <Icon className="h-4 w-4 hidden sm:block" />
              <span className="truncate">{tab.label}</span>
            </Button>
          );
        })}
      </div>

      <div className="min-w-0">
        {activeTab === "overview" && (
          <AppOverview
            app={app}
            showApiKey={showApiKey}
            onNavigateTab={handleTabChange}
          />
        )}
        {activeTab === "hosting" && <AppFrontendHosting appId={app.id} />}
        {activeTab === "domains" && <AppDomains appId={app.id} />}
        {activeTab === "promote" && <AppPromote app={app} />}
        {activeTab === "analytics" && <AppAnalytics appId={app.id} />}
        {activeTab === "earnings" && (
          <AppEarningsDashboard
            appId={app.id}
            onNavigateTab={handleTabChange}
          />
        )}
        {activeTab === "monetization" && (
          <AppMonetizationSettings app={app} onNavigateTab={handleTabChange} />
        )}
        {activeTab === "users" && <AppUsers appId={app.id} />}
        {activeTab === "settings" && (
          <AppSettings app={app} {...settingsProps} />
        )}
      </div>
    </div>
  );
}
