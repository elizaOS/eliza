/**
 * Standalone Organization page mounted by the cloud router shell at
 * `dashboard/organization`. Thin wrapper around the self-loading
 * {@link OrganizationSection}; the shell supplies the QueryClient,
 * CloudI18nProvider, and Steward auth context.
 *
 * Default export so it can be `React.lazy`-loaded for code-splitting from the
 * route registration module.
 */

import { ConsolePage } from "../shell/ConsolePage";
import { OrganizationSection } from "./OrganizationSection";

export function OrganizationPage() {
  return (
    <ConsolePage>
      <OrganizationSection />
    </ConsolePage>
  );
}

export default OrganizationPage;
