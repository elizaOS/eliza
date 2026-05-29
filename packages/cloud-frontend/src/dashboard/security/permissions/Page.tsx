import { Helmet } from "react-helmet-async";
import { useT } from "@/providers/I18nProvider";
import { PluginPermissionsPageClient } from "./_components/plugin-permissions-page-client";

/** /dashboard/security/permissions */
export default function PluginPermissionsPage() {
  const t = useT();
  return (
    <>
      <Helmet>
        <title>
          {t("cloud.pluginPermissions.pageTitle", {
            defaultValue: "Plugin permissions · Eliza Cloud",
          })}
        </title>
      </Helmet>
      <PluginPermissionsPageClient />
    </>
  );
}
