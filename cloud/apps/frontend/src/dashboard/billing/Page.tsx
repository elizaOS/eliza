import { DashboardErrorState, DashboardLoadingState } from "@elizaos/cloud-ui";
import { Helmet } from "react-helmet-async";
import { useSearchParams } from "react-router-dom";
import { useUserProfile } from "../../lib/data/user";
import { BillingPageWrapper } from "./_components/billing-page-wrapper";

/** /dashboard/billing */
export default function BillingPage() {
  const { user, isLoading, isReady, isAuthenticated, isError, error } = useUserProfile();
  const [params] = useSearchParams();
  const canceled = params.get("canceled") ?? undefined;

  return (
    <>
      <Helmet>
        <title>Billing</title>
        <meta name="description" content="Add funds and manage your billing" />
      </Helmet>
      {!isReady || (isAuthenticated && isLoading) ? (
        <DashboardLoadingState label="Loading billing" />
      ) : isError ? (
        <DashboardErrorState message={(error as Error)?.message ?? "Failed to load billing"} />
      ) : !user ? (
        <DashboardLoadingState label="Loading billing" />
      ) : (
        <BillingPageWrapper user={user} canceled={canceled} />
      )}
    </>
  );
}
