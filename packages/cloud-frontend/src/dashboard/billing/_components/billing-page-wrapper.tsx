"use client";

import { useSetPageHeader } from "@elizaos/ui";
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
  useSetPageHeader({
    title: "Billing",
  });

  return (
    <div className="max-w-7xl mx-auto">
      {canceled && (
        <div className="mb-4 border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          Payment canceled. No charges were made.
        </div>
      )}
      <BillingTab user={user} />
    </div>
  );
}
