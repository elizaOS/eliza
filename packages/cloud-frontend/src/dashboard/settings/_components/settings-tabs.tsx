/**
 * Settings tabs navigation component with responsive design.
 * Desktop renders a bordered tab list; mobile renders a horizontally
 * scrollable pill strip exposing every tab without a dropdown.
 *
 * @param props - Settings tabs configuration
 * @param props.activeTab - Currently active tab
 * @param props.onTabChange - Callback when tab changes
 */

"use client";

import {
  BarChart3,
  Building2,
  CreditCard,
  Key,
  Link2,
  PieChart,
  User,
} from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import type { SettingsTab } from "./types";

interface SettingsTabsProps {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
}

const tabs = [
  { id: "general" as const, label: "General", icon: User },
  { id: "account" as const, label: "Account", icon: Building2 },
  { id: "connections" as const, label: "Connections", icon: Link2 },
  { id: "usage" as const, label: "Usage", icon: BarChart3 },
  { id: "billing" as const, label: "Billing", icon: CreditCard },
  { id: "apis" as const, label: "APIs", icon: Key },
  { id: "analytics" as const, label: "Analytics", icon: PieChart },
  { id: "organization" as const, label: "Organization", icon: Building2 },
];

export function SettingsTabs({ activeTab, onTabChange }: SettingsTabsProps) {
  const [isMounted, setIsMounted] = React.useState(false);

  React.useEffect(() => {
    setIsMounted(true);
  }, []);

  // Prevent hydration mismatch
  if (!isMounted) {
    return null;
  }

  return (
    <>
      {/* Mobile pill strip — horizontally scrollable, all tabs reachable */}
      <div className="flex md:hidden w-full mb-6 gap-2 overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-sm px-4 py-2",
                "border border-brand-surface",
                "transition-colors duration-200",
                isActive
                  ? "bg-white/10 text-white"
                  : "text-muted-foreground hover:bg-white/5",
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="text-sm font-medium font-mono tracking-tight whitespace-nowrap">
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Desktop Tabs */}
      <div className="hidden md:flex border-l border-t border-brand-surface items-start w-full overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={cn(
                "flex items-center justify-center gap-2 px-6 py-3",
                "border-b border-r border-brand-surface",
                "transition-all duration-200",
                isActive
                  ? "bg-white/10 border-b-2 border-b-white"
                  : "hover:bg-white/5",
              )}
            >
              <Icon
                className={cn(
                  "h-4 w-4",
                  isActive ? "text-white" : "text-muted-foreground",
                )}
              />
              <span
                className={cn(
                  "text-sm font-medium font-mono tracking-tight",
                  isActive ? "text-white" : "text-muted-foreground",
                )}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
