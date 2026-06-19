/**
 * Standalone Organization page mounted by the cloud router shell at
 * `dashboard/organization`. Thin wrapper around the self-loading
 * {@link OrganizationSection}; the shell supplies the QueryClient,
 * CloudI18nProvider, and Steward auth context.
 *
 * Default export so it can be `React.lazy`-loaded for code-splitting from the
 * route registration module.
 */

import { OrganizationSection } from "./OrganizationSection";

export function OrganizationPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6 md:py-8">
      <OrganizationSection />
    </div>
  );
}

export default OrganizationPage;
