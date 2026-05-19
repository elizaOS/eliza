import { Helmet } from "react-helmet-async";
import { useT } from "@/providers/I18nProvider";
import { InfrastructureDashboard } from "../_components/infrastructure-dashboard";

/** /dashboard/admin/infrastructure — Docker nodes, containers, Headscale mesh. */
export default function AdminInfrastructurePage() {
  const t = useT();
  return (
    <>
      <Helmet>
        <title>
          {t("cloud.admin.infraPage.metaTitle", {
            defaultValue: "Admin: Infrastructure",
          })}
        </title>
        <meta
          name="description"
          content={t("cloud.admin.infraPage.metaDescription", {
            defaultValue:
              "Docker nodes, containers, and Headscale mesh management",
          })}
        />
      </Helmet>
      <InfrastructureDashboard />
    </>
  );
}
