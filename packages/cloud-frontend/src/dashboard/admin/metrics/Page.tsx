import { Helmet } from "react-helmet-async";
import { useT } from "@/providers/I18nProvider";
import { AdminMetricsWrapper } from "../_components/admin-metrics-wrapper";

/** /dashboard/admin/metrics — engagement KPIs across platforms. */
export default function AdminMetricsPage() {
  const t = useT();
  return (
    <>
      <Helmet>
        <title>
          {t("cloud.admin.metricsPage.metaTitle", {
            defaultValue: "Admin: Engagement Metrics",
          })}
        </title>
        <meta
          name="description"
          content={t("cloud.admin.metricsPage.metaDescription", {
            defaultValue: "User engagement KPIs across all platforms",
          })}
        />
      </Helmet>
      <AdminMetricsWrapper />
    </>
  );
}
