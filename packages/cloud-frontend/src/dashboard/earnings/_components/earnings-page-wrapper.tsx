"use client";

import { DashboardRoutePage } from "@elizaos/ui";
import { EarningsPageClient } from "./earnings-page-client";

export function EarningsPageWrapper() {
  return (
    <DashboardRoutePage
      title="Earnings & Redemptions"
      description="View your earnings and redeem for elizaOS tokens"
    >
      <EarningsPageClient />
    </DashboardRoutePage>
  );
}
