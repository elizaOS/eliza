/**
 * Standalone Account console page mounted by the cloud router shell at
 * `dashboard/account` — profile/identity management on the apex console
 * (`cloud.eliza.app`). Thin wrapper
 * around the self-loading {@link AccountSurface} (the same body the
 * `cloud-account` Settings section renders in the app).
 *
 * Default export for `React.lazy` code-splitting from the route registration.
 */

import { ConsolePage } from "../shell/ConsolePage";
import { AccountSurface } from "./AccountSurface";

export function AccountPage() {
  // No titleKey and no local PageHeaderProvider: the surface's useSetPageHeader
  // must reach ConsoleShell's provider or the top bar shows no title (a local
  // provider is a dead context nothing reads). Document title is set by
  // AccountSurface.
  return (
    <ConsolePage>
      <AccountSurface />
    </ConsolePage>
  );
}

export default AccountPage;
