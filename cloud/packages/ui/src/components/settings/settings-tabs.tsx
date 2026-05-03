/**
 * Settings tabs navigation component with responsive design.
 * Supports desktop tab list and mobile dropdown selection.
 *
 * @param props - Settings tabs configuration
 * @param props.activeTab - Currently active tab
 * @param props.onTabChange - Callback when tab changes
 */

"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@elizaos/cloud-ui";
import { BarChart3, Building2, CreditCard, Key, Link2, PieChart, User } from "lucide-react";
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

  const activeTabData = tabs.find((tab) => tab.id === activeTab);

  return (
    <>
      {/* Mobile Dropdown */}
      <div className="block md:hidden w-full mb-6">
        <Select value={activeTab} onValueChange={(value) => onTabChange(value as SettingsTab)}>
          <SelectTrigger className="w-full h-12 rounded-sm border border-brand-surface bg-[rgba(0,0,0,0.4)] backdrop-blur-sm text-white">
            <SelectValue>
              <div className="flex items-center gap-2">
                {activeTabData && (
                  <>
                    <activeTabData.icon className="h-4 w-4" />
                    {activeTabData.label}
                  </>
                )}
              </div>
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="bg-[#1A1A1A] border-brand-surface">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <SelectItem
                  key={tab.id}
                  value={tab.id}
                  className="text-white cursor-pointer hover:bg-[rgba(255,255,255,0.07)] focus:bg-[rgba(255,255,255,0.07)]"
                >
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4" />
                    {tab.label}
                  </div>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop Tabs */}
      <div className="hidden md:flex border-l border-t border-brand-surface items-start w-full overflow-x-auto">
        {tabs.map((tab, index) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          const _isLast = index === tabs.length - 1;

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
                  ? "bg-[rgba(255,255,255,0.07)] border-b-2 border-b-white"
                  : "hover:bg-[rgba(255,255,255,0.03)]",
              )}
            >
              <Icon className={cn("h-4 w-4", isActive ? "text-white" : "text-[#A2A2A2]")} />
              <span
                className={cn(
                  "text-sm font-medium font-mono tracking-tight",
                  isActive ? "text-white" : "text-[#A2A2A2]",
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
