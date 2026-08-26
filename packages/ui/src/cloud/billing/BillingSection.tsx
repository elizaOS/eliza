/**
 * Canonical billing surface — the body mounted by the `cloud-billing` Settings
 * section (`/settings#cloud-billing`) and the standalone `dashboard/billing`
 * console page.
 *
 * Fetches the current user/account (the `BillingTab` needs a freshly confirmed
 * billing identity), then renders the consumer billing controls. Balance and
 * active compute come from the canonical billing snapshot v2. Internal
 * infrastructure quotas remain available to their owning diagnostics surfaces;
 * they are not part of the normal billing experience.
 * Wraps the subtree in {@link ConditionalWalletProviders} so the crypto
 * direct-payment wallet stack (wagmi/RainbowKit/Solana) never enters the entry
 * bundle elsewhere.
 *
 * The Stripe Checkout cancel URL points back here with `?canceled=true` (it
 * targets `/cloud/billing`, the standalone console page that mounts this
 * same body), so the canceled banner renders at the top of the body.
 */

import {
  DashboardErrorState,
  DashboardLoadingState,
} from "@elizaos/ui/cloud-ui";
import { Alert } from "../../components/ui/alert";
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
  const {
    user,
    isLoading,
    isFetching,
    isPaused,
    isFetchedAfterMount,
    isAuthenticated,
    isError,
    error,
  } = useBillingUser({ requireFreshOrganization: true });

  if (
    !isAuthenticated ||
    isLoading ||
    isFetching ||
    isPaused ||
    !isFetchedAfterMount
  ) {
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
        <Alert variant="dashboardError" className="mb-4">
          {t("cloud.billing.paymentCanceled", {
            defaultValue: "Payment canceled. No charges were made.",
          })}
        </Alert>
      ) : null}
      <BillingTab user={user} />
    </ConditionalWalletProviders>
  );
}
