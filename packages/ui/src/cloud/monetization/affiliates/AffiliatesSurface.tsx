/**
 * Affiliates & Referrals surface. Gates on the Steward session, sets the
 * document title, and renders {@link AffiliatesPageClient} (which self-fetches
 * `/api/v1/affiliates` + `/api/v1/referrals`). Rendered as the Affiliates tab
 * of the merged Monetization settings section.
 */

import { DashboardLoadingState } from "../../../cloud-ui/components/dashboard/route-placeholders";
import { useDocumentTitle } from "../../lib/use-document-title";
import { useRequireAuth } from "../../lib/use-session-auth";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { AffiliatesPageClient } from "./AffiliatesPageClient";

/** Bare affiliates surface — auth-gated, no page chrome. */
export function AffiliatesSurface() {
  const t = useCloudT();
  const { ready, authenticated } = useRequireAuth();

  useDocumentTitle(
    t("cloud.affiliates.metaTitle", { defaultValue: "Affiliates" }),
  );

  if (!ready || !authenticated) {
    return (
      <DashboardLoadingState
        label={t("cloud.affiliates.loading", {
          defaultValue: "Loading affiliates",
        })}
      />
    );
  }

  return <AffiliatesPageClient />;
}
