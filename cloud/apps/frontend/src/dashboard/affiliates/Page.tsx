import { DashboardLoadingState } from "@elizaos/cloud-ui";
import { Helmet } from "react-helmet-async";
import { useRequireAuth } from "../../lib/auth-hooks";
import { AffiliatesPageWrapper } from "./_components/affiliates-page-wrapper";

/**
 * /dashboard/affiliates — the existing `AffiliatesPageClient` self-fetches
 * `/api/v1/affiliates` and the referral hook. We gate on auth and let it
 * mount as-is.
 */
export default function AffiliatesPage() {
  const { ready, authenticated } = useRequireAuth();

  return (
    <>
      <Helmet>
        <title>Affiliates</title>
        <meta name="description" content="Manage your affiliate link and markup percentage" />
      </Helmet>
      {!ready || !authenticated ? (
        <DashboardLoadingState label="Loading affiliates" />
      ) : (
        <AffiliatesPageWrapper />
      )}
    </>
  );
}
