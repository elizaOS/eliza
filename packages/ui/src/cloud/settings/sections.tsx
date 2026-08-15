/**
 * Zero-arg settings-section components for the lifted Eliza Cloud surfaces.
 *
 * Each component wraps a domain body (from `cloud/<domain>/`) in
 * {@link CloudSettingsSectionShell} so it self-provides the cloud router /
 * query / i18n / Steward-auth / page-header stack the bodies expect, then
 * renders the canonical body. The settings registry renders these with no
 * props — the bodies self-load (`useUserProfile`, `useApiKeys`, `useBillingUser`,
 * `useOrganizationUser`, …) so there is nothing to thread in.
 *
 * Section → source domain:
 *  - {@link CloudAccountSection}       → cloud/account-security (AccountSurface)
 *  - {@link CloudBillingSection}       → cloud/billing (BillingSectionBody + invoices route)
 *  - {@link CloudApiKeysSection}       → cloud/api-keys (ApiKeysSurface)
 *  - {@link CloudApplicationsSection}  → cloud/applications (entry → /cloud/apps view)
 *  - {@link CloudMonetizationSection}  → cloud/monetization (Earnings + Affiliates)
 *  - {@link CloudOrganizationSection}  → cloud/organization (OrganizationSection)
 *  - {@link CloudSecuritySection}      → cloud/account-security (SecuritySurface: sessions/privacy-DSR/audit)
 *  - {@link CloudPluginGrantsSection}  → cloud/account-security (PermissionsSurface: plugin grants)
 */

import { AccountSurface } from "../account-security/AccountSurface";
import { PermissionsSurface } from "../account-security/PermissionsSurface";
import { SecuritySurface } from "../account-security/SecuritySurface";
import { ApiKeysSurface } from "../api-keys/ApiKeysSurface";
import { BillingSectionBody } from "../billing/BillingSection";
import { MonetizationView } from "../monetization/MonetizationSection";
import { OrganizationSection } from "../organization/OrganizationSection";
import { ApplicationsEntry } from "./applications-entry";
import { CloudSettingsSectionShell } from "./CloudSettingsSectionShell";

export function CloudAccountSection(): React.JSX.Element {
  return (
    <CloudSettingsSectionShell>
      <AccountSurface />
    </CloudSettingsSectionShell>
  );
}

export function CloudBillingSection(): React.JSX.Element {
  return (
    <CloudSettingsSectionShell>
      <BillingSectionBody />
    </CloudSettingsSectionShell>
  );
}

export function CloudApiKeysSection(): React.JSX.Element {
  return (
    <CloudSettingsSectionShell>
      <ApiKeysSurface />
    </CloudSettingsSectionShell>
  );
}

/**
 * Applications is a standalone cloud VIEW (`/cloud/apps`, 8-tab developer
 * surface), not an embeddable body — so this section is an entry that opens that
 * view (CloudRouterShell serves it on the web build). The cloud route registry
 * already registers the route at import time.
 */
export { ApplicationsEntry };

export function CloudApplicationsSection(): React.JSX.Element {
  return (
    <CloudSettingsSectionShell>
      <ApplicationsEntry />
    </CloudSettingsSectionShell>
  );
}

export function CloudMonetizationSection(): React.JSX.Element {
  return (
    <CloudSettingsSectionShell>
      <MonetizationView />
    </CloudSettingsSectionShell>
  );
}

export function CloudOrganizationSection(): React.JSX.Element {
  return (
    <CloudSettingsSectionShell>
      <OrganizationSection />
    </CloudSettingsSectionShell>
  );
}

export function CloudSecuritySection(): React.JSX.Element {
  return (
    <CloudSettingsSectionShell>
      <SecuritySurface />
    </CloudSettingsSectionShell>
  );
}

export function CloudPluginGrantsSection(): React.JSX.Element {
  return (
    <CloudSettingsSectionShell>
      <PermissionsSurface />
    </CloudSettingsSectionShell>
  );
}
