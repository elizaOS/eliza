import { DashboardErrorState, DashboardLoadingState } from "@elizaos/ui";
import { Helmet } from "react-helmet-async";
import { useSearchParams } from "react-router-dom";
import { useT } from "@/providers/I18nProvider";
import { useUserProfile } from "../../lib/data/user";
import { BillingPageWrapper } from "./_components/billing-page-wrapper";

/** /dashboard/billing */
export default function BillingPage() {
  const t = useT();
  const { user, isLoading, isReady, isAuthenticated, isError, error } =
    useUserProfile();
  const [params] = useSearchParams();
  const canceled = params.get("canceled") ?? undefined;

  return (
    <>
      <Helmet>
        <title>
          {t("cloud.billing.metaTitle", { defaultValue: "Billing" })}
        </title>
        <meta
          name="description"
          content={t("cloud.billing.metaDescription", {
            defaultValue: "Add funds and manage your billing",
          })}
        />
      </Helmet>
      {!isReady || (isAuthenticated && isLoading) ? (
        <DashboardLoadingState
          label={t("cloud.billing.loading", {
            defaultValue: "Loading billing",
          })}
        />
      ) : isError ? (
        <DashboardErrorState
          message={
            (error as Error)?.message ??
            t("cloud.billing.loadError", {
              defaultValue: "Failed to load billing",
            })
          }
        />
      ) : !user ? (
        <DashboardLoadingState
          label={t("cloud.billing.loading", {
            defaultValue: "Loading billing",
          })}
        />
      ) : !user.organization || !user.organization_id ? (
        <DashboardErrorState
          message={t("cloud.billing.noOrganization", {
            defaultValue: "No organization associated with this account",
          })}
        />
      ) : (
        <BillingPageWrapper
          user={{
            organization_id: user.organization_id,
            wallet_address: user.wallet_address,
            organization: user.organization,
          }}
          canceled={canceled}
        />
      )}
    </>
  );
}
