/**
 * Earnings & Redemptions surface. Gates on the Steward session, sets the
 * document title, and renders {@link EarningsPageClient} (which self-fetches
 * `/api/v1/redemptions/*`). Rendered as the Earnings tab of the merged
 * Monetization settings section.
 */

import { DashboardLoadingState } from "../../../cloud-ui/components/dashboard/route-placeholders";
import { useDocumentTitle } from "../../lib/use-document-title";
import { useRequireAuth } from "../../lib/use-session-auth";
import { useCloudT } from "../../shell/CloudI18nProvider";
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
