/**
 * Settings-section wrapper for the plugin-permissions surface (Wave-3 mount
 * point).
 *
 * Zero-prop adapter for
 * `registerSettingsSection({ id: "plugin-permissions", Component: PermissionsSection, ... })`.
 * Reuses {@link PermissionsSurface} and provides a local `PageHeaderProvider`
 * (the surface sets the page header).
 */

import { PageHeaderProvider } from "../../cloud-ui";
import { PermissionsSurface } from "./PermissionsRoute";

export function PermissionsSection() {
  return (
    <PageHeaderProvider>
      <PermissionsSurface />
    </PageHeaderProvider>
  );
}
