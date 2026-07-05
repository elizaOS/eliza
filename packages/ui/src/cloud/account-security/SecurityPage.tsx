/**
 * Standalone Security console page mounted by the cloud router shell at
 * `dashboard/security` — sessions / privacy-DSR / audit surface on the apex
 * console (elizacloud.ai), where the in-app Settings view never mounts. Thin
 * wrapper around the self-loading {@link SecuritySurface} (the same body the
 * `cloud-security` Settings section renders in the app).
 *
 * Default export for `React.lazy` code-splitting from the route registration.
 */

import { ConsolePage } from "../shell/ConsolePage";
import { SecuritySurface } from "./SecuritySurface";

export function SecurityPage() {
  return (
    <ConsolePage titleKey="cloud.security.metaTitle" titleDefault="Security">
      <SecuritySurface />
    </ConsolePage>
  );
}

export default SecurityPage;
