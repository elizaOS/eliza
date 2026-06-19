/**
 * Settings-section wrapper for the Account surface (Wave-3 mount point).
 *
 * The settings-section registry renders a zero-prop `Component`, so this is the
 * adapter Wave 3 hands to
 * `registerSettingsSection({ id: "account", Component: AccountSection, ... })`.
 * It reuses the exact same {@link AccountSurface} as the standalone route and
 * provides a local `PageHeaderProvider` (the surface sets the page header) so it
 * is safe to mount regardless of the settings shell's own header context.
 */

import { PageHeaderProvider } from "../../cloud-ui";
import { AccountSurface } from "./AccountRoute";

export function AccountSection() {
  return (
    <PageHeaderProvider>
      <AccountSurface />
    </PageHeaderProvider>
  );
}
