/**
 * Settings-section wrapper for the Security surface (Wave-3 mount point).
 *
 * Zero-prop adapter for
 * `registerSettingsSection({ id: "security", Component: SecuritySection, ... })`.
 * Reuses {@link SecuritySurface} and provides a local `PageHeaderProvider`
 * (the surface sets the page header).
 */

import { PageHeaderProvider } from "../../cloud-ui";
import { SecuritySurface } from "./SecurityRoute";

export function SecuritySection() {
  return (
    <PageHeaderProvider>
      <SecuritySurface />
    </PageHeaderProvider>
  );
}
