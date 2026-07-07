/**
 * Canonical billing surface — the body mounted by the `cloud-billing` Settings
 * section (`/settings#cloud-billing`) and the standalone `dashboard/billing`
 * console page.
 *
 * Fetches the current user/org (the `BillingTab` needs `organization_id`,
 * `wallet_address`, and the seed `credit_balance`), then renders `BillingTab`.
 * Wraps the subtree in {@link ConditionalWalletProviders} so the crypto
 * direct-payment wallet stack (wagmi/RainbowKit/Solana) never enters the entry
 * bundle elsewhere.
 *
 * The Stripe Checkout cancel URL points back here with `?canceled=true` (it
 * targets `/dashboard/billing`, the standalone console page that mounts this
 * same body), so the canceled banner renders at the top of the body.
 */

import {
  DashboardErrorState,
  DashboardLoadingState,
} from "@elizaos/ui/cloud-ui";
import { useCloudT } from "../shell/CloudI18nProvider";
import { BillingTab } from "./components/billing-tab";
import { useBillingUser } from "./data/billing-data";
import { ConditionalWalletProviders } from "./wallet/ConditionalWalletProviders";

function wasCheckoutCanceled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("canceled") !== null;
}

/** The billing surface, rendered by the Settings → Cloud billing section. */
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
        message={t("cloud.billing.noAccount", {
          defaultValue: "No account found for billing",
        })}
      />
    );
  }

  return (
    <ConditionalWalletProviders>
      {wasCheckoutCanceled() ? (
        <div className="mb-4 border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {t("cloud.billing.paymentCanceled", {
            defaultValue: "Payment canceled. No charges were made.",
          })}
        </div>
      ) : null}
      <BillingTab user={user} />
    </ConditionalWalletProviders>
  );
}
