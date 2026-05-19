"use client";

import { DashboardRoutePage } from "@elizaos/ui";
import { useT } from "@/providers/I18nProvider";
import { AffiliatesPageClient } from "./affiliates-page-client";

export function AffiliatesPageWrapper() {
  const t = useT();
  return (
    <DashboardRoutePage
      title={t("cloud.affiliates.pageTitle", {
        defaultValue: "Affiliates & Referrals",
      })}
      description={t("cloud.affiliates.pageDescription", {
        defaultValue: "Share your invite link and manage your affiliate markup",
      })}
    >
      <AffiliatesPageClient />
    </DashboardRoutePage>
  );
}
