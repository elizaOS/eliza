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
 *  - {@link CloudApplicationsSection}  → cloud/applications (entry → /dashboard/apps view)
 *  - {@link CloudMonetizationSection}  → cloud/monetization (Earnings + Affiliates)
 *  - {@link CloudOrganizationSection}  → cloud/organization (OrganizationSection)
 *  - {@link CloudSecuritySection}      → cloud/account-security (SecuritySurface: sessions/privacy-DSR/audit)
 *  - {@link CloudPluginGrantsSection}  → cloud/account-security (PermissionsSurface: plugin grants)
 */

import { ExternalLink, Grid3x3 } from "lucide-react";
import { AccountSurface } from "../account-security/AccountRoute";
import { PermissionsSurface } from "../account-security/PermissionsRoute";
import { SecuritySurface } from "../account-security/SecurityRoute";
import { ApiKeysSurface } from "../api-keys/ApiKeysRoute";
import { BillingSectionBody } from "../billing/BillingSection";
import { MonetizationView } from "../monetization/MonetizationSection";
import { OrganizationSection } from "../organization/OrganizationSection";
import { useCloudT } from "../shell/CloudI18nProvider";
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
 * Applications is a standalone cloud VIEW (`/dashboard/apps`, 8-tab developer
 * surface), not an embeddable body — so this section is an entry that opens that
 * view (CloudRouterShell serves it on the web build). The cloud route registry
 * already registers the route at import time.
 */
function ApplicationsEntry(): React.JSX.Element {
  const t = useCloudT();
  const open = () => {
    if (typeof window !== "undefined") {
      window.location.assign("/dashboard/apps");
    }
  };
  return (
    <button
      type="button"
      onClick={open}
      className="group flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-4 text-left transition-colors hover:border-accent/40 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/12 text-accent ring-1 ring-accent/20">
        <Grid3x3 className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium leading-5 text-txt-strong">
          {t("cloud.applications.entryTitle", {
            defaultValue: "Manage applications",
          })}
        </span>
        <span className="text-xs leading-relaxed text-muted">
          {t("cloud.applications.entryDescription", {
            defaultValue:
              "Cloud OAuth applications: monetization, earnings, domains, analytics, users.",
          })}
        </span>
      </span>
      <ExternalLink
        className="h-4 w-4 shrink-0 text-muted/70 transition-colors group-hover:text-accent"
        aria-hidden
      />
    </button>
  );
}

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
