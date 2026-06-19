/**
 * Affiliates & Referrals cloud route entry.
 *
 * Lifted from `@elizaos/cloud-frontend/src/dashboard/affiliates/Page.tsx` +
 * `_components/affiliates-page-wrapper.tsx`. Gates on the Steward session, sets
 * the document title (no Helmet), and renders {@link AffiliatesPageClient}. The
 * client self-fetches `/api/v1/affiliates` + `/api/v1/referrals`.
 *
 * Two surfaces:
 * - {@link AffiliatesSurface} — bare (no DashboardRoutePage chrome) for
 *   embedding in the merged Monetization settings section.
 * - default `AffiliatesRoute` — wraps the surface in `DashboardRoutePage` for
 *   the registered standalone `/dashboard/affiliates` route.
 */

import { DashboardLoadingState } from "../../../cloud-ui/components/dashboard/route-placeholders";
import { DashboardRoutePage } from "../../../cloud-ui/components/layout/dashboard-route-page";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { useRequireAuth } from "../auth-gate";
import { useDocumentTitle } from "../use-document-title";
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

/** Default export consumed by the cloud-route registry. */
export default function AffiliatesRoute() {
  const t = useCloudT();
  return (
    <DashboardRoutePage
      title={t("cloud.affiliates.pageTitle", {
        defaultValue: "Affiliates & Referrals",
      })}
      description={t("cloud.affiliates.pageDescription", {
        defaultValue: "Share your invite link and manage your affiliate markup",
      })}
    >
      <AffiliatesSurface />
    </DashboardRoutePage>
  );
}
