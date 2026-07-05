/**
 * Standalone Plugin-grants console page mounted by the cloud router shell at
 * `dashboard/security/permissions` — cloud plugin-permission grants on the
 * apex console (elizacloud.ai), where the in-app Settings view never mounts.
 * Thin wrapper around the self-loading {@link PermissionsSurface} (the same
 * body the `cloud-plugin-grants` Settings section renders in the app).
 *
 * Default export for `React.lazy` code-splitting from the route registration.
 */

import { ConsolePage } from "../shell/ConsolePage";
import { PermissionsSurface } from "./PermissionsSurface";

export function PermissionsPage() {
  return (
    <ConsolePage
      titleKey="cloud.permissions.metaTitle"
      titleDefault="Plugin Permissions"
    >
      <PermissionsSurface />
    </ConsolePage>
  );
}

export default PermissionsPage;
