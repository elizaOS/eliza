"use client";

import { DashboardRoutePage } from "@elizaos/ui";
import { useT } from "@/providers/I18nProvider";
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
  const t = useT();
  return (
    <DashboardRoutePage
      title={t("cloud.billing.pageTitle", { defaultValue: "Billing" })}
      container={{ className: "max-w-7xl" }}
      banner={
        canceled
          ? t("cloud.billing.paymentCanceled", {
              defaultValue: "Payment canceled. No charges were made.",
            })
          : undefined
      }
      bannerTone="error"
    >
      <BillingTab user={user} />
    </DashboardRoutePage>
  );
}
