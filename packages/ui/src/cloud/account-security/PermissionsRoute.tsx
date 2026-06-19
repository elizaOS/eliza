/**
 * Plugin permissions cloud route entry.
 *
 * Lifted from
 * `@elizaos/cloud-frontend/src/dashboard/security/permissions/Page.tsx` +
 * `_components/plugin-permissions-page-client.tsx`. Page title is set via
 * {@link useDocumentTitle} (no Helmet).
 *
 * `PermissionsSurface` is the embeddable body; the default export wraps it in a
 * `PageHeaderProvider` for the standalone `/dashboard/security/permissions`
 * route (the body calls `useSetPageHeader`).
 */

import { PageHeaderProvider } from "../../cloud-ui";
import { useCloudT } from "../shell/CloudI18nProvider";
import { PluginPermissionsPageClient } from "./components/plugin-permissions-page-client";
import { useDocumentTitle } from "./use-document-title";

/**
 * The plugin-permissions surface. Embeddable: handed to the Wave-3 settings
 * section and wrapped by {@link PermissionsRoute} for the standalone route.
 * Assumes a `PageHeaderProvider` ancestor (it sets the page header).
 */
export function PermissionsSurface() {
  const t = useCloudT();
  useDocumentTitle(
    t("cloud.pluginPermissions.pageTitle", {
      defaultValue: "Plugin permissions · Eliza Cloud",
    }),
  );
  return <PluginPermissionsPageClient />;
}

/** Default export consumed by the cloud-route registry. */
export default function PermissionsRoute() {
  return (
    <PageHeaderProvider>
      <PermissionsSurface />
    </PageHeaderProvider>
  );
}
