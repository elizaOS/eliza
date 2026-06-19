/**
 * Merged Monetization standalone route (`dashboard/monetization`).
 *
 * Wraps the tabbed {@link MonetizationView} (Earnings + Affiliates) in
 * `DashboardRoutePage` chrome. The same view is also exposed as a zero-prop
 * settings section via {@link MonetizationSection}.
 */

import { DashboardRoutePage } from "../../cloud-ui/components/layout/dashboard-route-page";
import { useCloudT } from "../shell/CloudI18nProvider";
import { MonetizationView } from "./MonetizationSection";

export default function MonetizationRoute() {
  const t = useCloudT();
  return (
    <DashboardRoutePage
      title={t("cloud.monetization.pageTitle", {
        defaultValue: "Monetization",
      })}
      description={t("cloud.monetization.pageDescription", {
        defaultValue:
          "Redeem your earnings for elizaOS tokens and manage your affiliate program",
      })}
    >
      <MonetizationView />
    </DashboardRoutePage>
  );
}
