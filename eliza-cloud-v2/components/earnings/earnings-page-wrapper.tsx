"use client";

import { useSetPageHeader } from "@/components/layout/page-header-context";
import { EarningsPageClient } from "./earnings-page-client";

export function EarningsPageWrapper() {
  useSetPageHeader({
    title: "Earnings & Redemptions",
    description: "View your earnings and redeem for elizaOS tokens",
  });

  return <EarningsPageClient />;
}
