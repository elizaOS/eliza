/**
 * Earnings & Redemptions cloud route entry.
 *
 * Lifted from `@elizaos/cloud-frontend/src/dashboard/earnings/Page.tsx` +
 * `_components/earnings-page-wrapper.tsx`. Gates on the Steward session, sets
 * the document title (no Helmet), and renders {@link EarningsPageClient}. The
 * client self-fetches `/api/v1/redemptions/*`.
 *
 * Two surfaces:
 * - {@link EarningsSurface} — bare (no DashboardRoutePage chrome) for embedding
 *   in the merged Monetization settings section.
 * - default `EarningsRoute` — wraps the surface in `DashboardRoutePage` for the
 *   registered standalone `/dashboard/earnings` route.
 */

import { DashboardLoadingState } from "../../../cloud-ui/components/dashboard/route-placeholders";
import { DashboardRoutePage } from "../../../cloud-ui/components/layout/dashboard-route-page";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { useRequireAuth } from "../auth-gate";
import { useDocumentTitle } from "../use-document-title";
import { EarningsPageClient } from "./EarningsPageClient";

/** Bare earnings surface — auth-gated, no page chrome. */
export function EarningsSurface() {
  const t = useCloudT();
  const { ready, authenticated } = useRequireAuth();

  useDocumentTitle(
    t("cloud.earnings.metaTitle", {
      defaultValue: "Earnings & Redemptions",
    }),
  );

  if (!ready || !authenticated) {
    return (
      <DashboardLoadingState
        label={t("cloud.earnings.loading", {
          defaultValue: "Loading earnings",
        })}
      />
    );
  }

  return <EarningsPageClient />;
}

/** Default export consumed by the cloud-route registry. */
export default function EarningsRoute() {
  const t = useCloudT();
  return (
    <DashboardRoutePage
      title={t("cloud.earnings.pageTitle", {
        defaultValue: "Earnings & Redemptions",
      })}
      description={t("cloud.earnings.pageDescription", {
        defaultValue: "View your earnings and redeem for elizaOS tokens",
      })}
    >
      <EarningsSurface />
    </DashboardRoutePage>
  );
}
