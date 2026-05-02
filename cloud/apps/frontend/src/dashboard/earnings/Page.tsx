import { DashboardLoadingState } from "@elizaos/cloud-ui";
import { Helmet } from "react-helmet-async";
import { EarningsPageWrapper } from "@/packages/ui/src/components/earnings/earnings-page-wrapper";
import { useRequireAuth } from "../../lib/auth-hooks";

/**
 * /dashboard/earnings — `EarningsPageWrapper` already drives its own
 * `/api/v1/redemptions/*` fetches, so the SPA shell only needs to gate on
 * auth.
 */
export default function EarningsPage() {
  const { ready, authenticated } = useRequireAuth();

  return (
    <>
      <Helmet>
        <title>Earnings & Redemptions</title>
        <meta name="description" content="View your earnings and redeem for elizaOS tokens" />
      </Helmet>
      {!ready || !authenticated ? (
        <DashboardLoadingState label="Loading earnings" />
      ) : (
        <EarningsPageWrapper />
      )}
    </>
  );
}
