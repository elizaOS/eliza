/**
 * Settings page client component managing settings tabs and content.
 * Provides tab navigation and renders appropriate tab content based on selection.
 *
 * @param props - Settings page client configuration
 * @param props.user - User data with organization information
 */

"use client";

import { DashboardPageContainer, useSetPageHeader } from "@elizaos/cloud-ui";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { UserWithOrganizationDto } from "@/types/cloud-api";
import { SettingsTabs } from "./settings-tabs";
import { AccountTab } from "./tabs/account-tab";
import { AnalyticsTab } from "./tabs/analytics-tab";
import { ApisTab } from "./tabs/apis-tab";
import { BillingTab } from "./tabs/billing-tab";
import { ConnectionsTab } from "./tabs/connections-tab";
import { GeneralTab } from "./tabs/general-tab";
import { OrganizationTab } from "./tabs/organization-tab";
import { UsageTab } from "./tabs/usage-tab";
import type { SettingsTab } from "./types";

interface SettingsPageClientProps {
  user: UserWithOrganizationDto;
}

export function SettingsPageClient({ user }: SettingsPageClientProps) {
  const [searchParams] = useSearchParams();
  const tabFromUrl = searchParams.get("tab") as SettingsTab | null;

  const [activeTab, setActiveTab] = useState<SettingsTab>(tabFromUrl || "general");

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
    <DashboardPageContainer className="flex flex-col gap-6">
      {/* Tab Navigation */}
      <SettingsTabs activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Tab Content */}
      <div className="w-full">{renderTabContent()}</div>
    </DashboardPageContainer>
  );
}
