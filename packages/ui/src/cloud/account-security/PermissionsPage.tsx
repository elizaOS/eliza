/**
 * Standalone Plugin-grants console page mounted by the cloud router shell at
 * `dashboard/security/permissions` — cloud plugin-permission grants on the
 * apex console (elizacloud.ai), where the in-app Settings view never mounts.
 * Thin wrapper around the self-loading {@link PermissionsSurface} (the same
 * body the `cloud-plugin-grants` Settings section renders in the app).
 *
 * Default export for `React.lazy` code-splitting from the route registration.
 */

import { useDocumentTitle } from "../lib/use-document-title";
import { useCloudT } from "../shell/CloudI18nProvider";
import { PermissionsSurface } from "./PermissionsSurface";

export function PermissionsPage() {
  const t = useCloudT();
  useDocumentTitle(
    t("cloud.permissions.metaTitle", { defaultValue: "Plugin Permissions" }),
  );
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6 md:py-8">
      <PermissionsSurface />
    </div>
  );
}

export default PermissionsPage;
