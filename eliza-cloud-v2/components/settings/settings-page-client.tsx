/**
 * Settings page client component managing settings tabs and content.
 * Provides tab navigation and renders appropriate tab content based on selection.
 *
 * @param props - Settings page client configuration
 * @param props.user - User data with organization information
 */

"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useSetPageHeader } from "@/components/layout/page-header-context";
import type { UserWithOrganization } from "@/lib/types";
import { SettingsTabs } from "./settings-tabs";
import {
  GeneralTab,
  AccountTab,
  UsageTab,
  BillingTab,
  ApisTab,
  AnalyticsTab,
  OrganizationTab,
  ConnectionsTab,
} from "./tabs";

interface SettingsPageClientProps {
  user: UserWithOrganization;
}

export type SettingsTab =
  | "general"
  | "account"
  | "usage"
  | "billing"
  | "apis"
  | "analytics"
  | "organization"
  | "connections";

export function SettingsPageClient({ user }: SettingsPageClientProps) {
  const searchParams = useSearchParams();
  const tabFromUrl = searchParams.get("tab") as SettingsTab | null;

  const [activeTab, setActiveTab] = useState<SettingsTab>(
    tabFromUrl || "general",
  );

  useEffect(() => {
    if (tabFromUrl) {
      // Schedule state update to avoid synchronous setState in effect
      const rafId = requestAnimationFrame(() => setActiveTab(tabFromUrl));
      return () => cancelAnimationFrame(rafId);
    }
  }, [tabFromUrl]);

  useSetPageHeader({
    title: "Settings",
    description: `Welcome back, ${user.name || user.email || "User"}!`,
  });

  const renderTabContent = () => {
    switch (activeTab) {
      case "general":
        return <GeneralTab user={user} />;
      case "account":
        return <AccountTab user={user} onTabChange={setActiveTab} />;
      case "usage":
        return <UsageTab user={user} onTabChange={setActiveTab} />;
      case "billing":
        return <BillingTab user={user} />;
      case "apis":
        return <ApisTab user={user} />;
      case "analytics":
        return <AnalyticsTab user={user} />;
      case "organization":
        return <OrganizationTab user={user} />;
      case "connections":
        return <ConnectionsTab />;
      default:
        return <GeneralTab user={user} />;
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-7xl">
      {/* Tab Navigation */}
      <SettingsTabs activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Tab Content */}
      <div className="w-full">{renderTabContent()}</div>
    </div>
  );
}
