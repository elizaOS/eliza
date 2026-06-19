"use client";

import { DashboardRoutePage } from "@elizaos/ui";
import { useT } from "@/providers/I18nProvider";
import { EarningsPageClient } from "./earnings-page-client";

export function EarningsPageWrapper() {
  const t = useT();
  return (
    <DashboardRoutePage
      title={t("cloud.earnings.pageTitle", {
        defaultValue: "Earnings & Redemptions",
      })}
      description={t("cloud.earnings.pageDescription", {
        defaultValue: "View your earnings and redeem for elizaOS tokens",
      })}
    >
      <EarningsPageClient />
    </DashboardRoutePage>
  );
}
