/**
 * Canonical billing entry — the body that both the in-app settings billing
 * section (Wave-3) and the standalone billing route mount.
 *
 * Fetches the current user/org (the `BillingTab` needs `organization_id`,
 * `wallet_address`, and the seed `credit_balance`), then renders the lifted
 * `BillingTab`. Wraps the subtree in {@link ConditionalWalletProviders} so the
 * crypto direct-payment wallet stack (wagmi/RainbowKit/Solana) is available on
 * the billing route but never enters the entry bundle elsewhere.
 *
 * Replaces the cloud-frontend `BillingPage` + `BillingPageWrapper` pair; the
 * `DashboardRoutePage` chrome and `from=canceled` banner are preserved.
 */

import {
  DashboardErrorState,
  DashboardLoadingState,
  DashboardRoutePage,
} from "@elizaos/ui/cloud-ui";
import { useSearchParams } from "react-router-dom";
import { useCloudT } from "../shell/CloudI18nProvider";
import { BillingTab } from "./components/billing-tab";
import { useBillingUser } from "./data/billing-data";
import { ConditionalWalletProviders } from "./wallet/ConditionalWalletProviders";

/** Billing body without route chrome — for embedding in a settings section. */
export function BillingSectionBody() {
  const t = useCloudT();
  const { user, isLoading, isAuthenticated, isError, error } = useBillingUser();

  if (!isAuthenticated || isLoading) {
    return (
      <DashboardLoadingState
        label={t("cloud.billing.loading", { defaultValue: "Loading billing" })}
      />
    );
  }

  if (isError) {
    return (
      <DashboardErrorState
        message={
          error instanceof Error
            ? error.message
            : t("cloud.billing.loadError", {
                defaultValue: "Failed to load billing",
              })
        }
      />
    );
  }

  if (!user) {
    return (
      <DashboardErrorState
        message={t("cloud.billing.noOrganization", {
          defaultValue: "No organization associated with this account",
        })}
      />
    );
  }

  return (
    <ConditionalWalletProviders>
      <BillingTab user={user} />
    </ConditionalWalletProviders>
  );
}

/** Full billing route page (chrome + canceled banner + body). */
export default function BillingSection() {
  const t = useCloudT();
  const [params] = useSearchParams();
  const canceled = params.get("canceled") ?? undefined;

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
      <BillingSectionBody />
    </DashboardRoutePage>
  );
}
