"use client";

import { useSetPageHeader } from "@elizaos/cloud-ui";
import { EarningsPageClient } from "./earnings-page-client";

export function EarningsPageWrapper() {
  useSetPageHeader({
    title: "Earnings & Redemptions",
    description: "View your earnings and redeem for elizaOS tokens",
  });

  return <EarningsPageClient />;
}
