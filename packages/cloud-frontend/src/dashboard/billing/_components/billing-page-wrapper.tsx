"use client";

import { DashboardRoutePage } from "@elizaos/ui";
import type { BillingUser } from "../../settings/_components/tabs/billing-tab";
import { BillingTab } from "../../settings/_components/tabs/billing-tab";

interface BillingPageWrapperProps {
  user: BillingUser;
  canceled?: string;
}

export function BillingPageWrapper({
  user,
  canceled,
}: BillingPageWrapperProps) {
  return (
    <DashboardRoutePage
      title="Billing"
      container={{ className: "max-w-7xl" }}
      banner={canceled ? "Payment canceled. No charges were made." : undefined}
      bannerTone="error"
    >
      <BillingTab user={user} />
    </DashboardRoutePage>
  );
}
