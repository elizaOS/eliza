import { Helmet } from "react-helmet-async";
import { PluginPermissionsPageClient } from "./_components/plugin-permissions-page-client";

/** /dashboard/security/permissions */
export default function PluginPermissionsPage() {
  return (
    <>
      <Helmet>
        <title>Plugin permissions · Eliza Cloud</title>
      </Helmet>
      <PluginPermissionsPageClient />
    </>
  );
}
