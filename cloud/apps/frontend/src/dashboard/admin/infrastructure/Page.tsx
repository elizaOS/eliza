import { Helmet } from "react-helmet-async";
import { InfrastructureDashboard } from "../_components/infrastructure-dashboard";

/** /dashboard/admin/infrastructure — Docker nodes, containers, Headscale mesh. */
export default function AdminInfrastructurePage() {
  return (
    <>
      <Helmet>
        <title>Admin: Infrastructure</title>
        <meta
          name="description"
          content="Docker nodes, containers, and Headscale mesh management"
        />
      </Helmet>
      <InfrastructureDashboard />
    </>
  );
}
