import { DashboardLoadingState } from "@elizaos/ui";
import { Helmet } from "react-helmet-async";
import { useT } from "@/providers/I18nProvider";
import { useRequireAuth } from "../../lib/auth-hooks";
import { AffiliatesPageWrapper } from "./_components/affiliates-page-wrapper";

/**
 * /dashboard/affiliates — the existing `AffiliatesPageClient` self-fetches
 * `/api/v1/affiliates` and the referral hook. We gate on auth and let it
 * mount as-is.
 */
export default function AffiliatesPage() {
  const t = useT();
  const { ready, authenticated } = useRequireAuth();

  return (
    <>
      <Helmet>
        <title>
          {t("cloud.affiliates.metaTitle", { defaultValue: "Affiliates" })}
        </title>
        <meta
          name="description"
          content={t("cloud.affiliates.metaDescription", {
            defaultValue: "Manage your affiliate link and markup percentage",
          })}
        />
      </Helmet>
      {!ready || !authenticated ? (
        <DashboardLoadingState
          label={t("cloud.affiliates.loading", {
            defaultValue: "Loading affiliates",
          })}
        />
      ) : (
        <AffiliatesPageWrapper />
      )}
    </>
  );
}
