import { Helmet } from "react-helmet-async";
import { AdminMetricsWrapper } from "../_components/admin-metrics-wrapper";

/** /dashboard/admin/metrics — engagement KPIs across platforms. */
export default function AdminMetricsPage() {
  return (
    <>
      <Helmet>
        <title>Admin: Engagement Metrics</title>
        <meta name="description" content="User engagement KPIs across all platforms" />
      </Helmet>
      <AdminMetricsWrapper />
    </>
  );
}
