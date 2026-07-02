/**
 * Plugin-grants surface (`GET/DELETE /api/v1/me/plugin-grants`). Mounted by
 * the `cloud-plugin-grants` Settings section (`/settings#cloud-plugin-grants`).
 */

import { useDocumentTitle } from "../lib/use-document-title";
import { useCloudT } from "../shell/CloudI18nProvider";
import { PluginPermissionsPageClient } from "./components/plugin-permissions-page-client";

/** The plugin-permissions surface. Assumes a `PageHeaderProvider` ancestor. */
export function PermissionsSurface() {
  const t = useCloudT();
  useDocumentTitle(
    t("cloud.pluginPermissions.pageTitle", {
      defaultValue: "Plugin permissions · Eliza Cloud",
    }),
  );
  return <PluginPermissionsPageClient />;
}
