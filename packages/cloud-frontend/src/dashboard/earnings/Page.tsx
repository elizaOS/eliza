import { DashboardLoadingState } from "@elizaos/ui";
import { Helmet } from "react-helmet-async";
import { useT } from "@/providers/I18nProvider";
import { useRequireAuth } from "../../lib/auth-hooks";
import { EarningsPageWrapper } from "./_components/earnings-page-wrapper";

/**
 * /dashboard/earnings — `EarningsPageWrapper` already drives its own
 * `/api/v1/redemptions/*` fetches, so the SPA shell only needs to gate on
 * auth.
 */
export default function EarningsPage() {
  const t = useT();
  const { ready, authenticated } = useRequireAuth();

  return (
    <>
      <Helmet>
        <title>
          {t("cloud.earnings.metaTitle", {
            defaultValue: "Earnings & Redemptions",
          })}
        </title>
        <meta
          name="description"
          content={t("cloud.earnings.metaDescription", {
            defaultValue: "View your earnings and redeem for elizaOS tokens",
          })}
        />
      </Helmet>
      {!ready || !authenticated ? (
        <DashboardLoadingState
          label={t("cloud.earnings.loading", {
            defaultValue: "Loading earnings",
          })}
        />
      ) : (
        <EarningsPageWrapper />
      )}
    </>
  );
}
