/**
 * Zero-arg settings-section components for the lifted Eliza Cloud surfaces.
 *
 * Each component wraps a domain body (from `cloud/<domain>/`) in
 * {@link CloudSettingsSectionShell} so it self-provides the cloud router /
 * query / i18n / Steward-auth / page-header stack the bodies expect, then
 * renders the canonical body. The settings registry renders these with no
 * props. Domain bodies self-load their data, while adapters inject app-owned
 * actions such as the platform-aware Cloud login flow.
 *
 * Account and Billing, opened from the hosted web shell, leave that shell for
 * `/cloud/account` and `/cloud/billing`. The settings hash is written with
 * `replaceState`, which does not update the cloud router, so those sections
 * would otherwise stay mounted beside the agent composer. Native settings have
 * no host router and keep the embedded bodies.
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

import { type ReactNode, useCallback, useEffect } from "react";
import { useInRouterContext, useLocation, useNavigate } from "react-router-dom";
import { useAppSelectorShallow } from "../../state/app-store";
import { claimCloudLoginWindow } from "../../state/cloud-login-launch";
import { runAsPrivilegedShell } from "../../surface-realm-channel";
import { AccountSurface } from "../account-security/AccountSurface";
import { PermissionsSurface } from "../account-security/PermissionsSurface";
import { SecuritySurface } from "../account-security/SecuritySurface";
import { ApiKeysSurface } from "../api-keys/ApiKeysSurface";
import { BillingSectionBody } from "../billing/BillingSection";
import { MonetizationView } from "../monetization/MonetizationSection";
import { OrganizationSection } from "../organization/OrganizationSection";
import { ApplicationsEntry } from "./applications-entry";
import { CloudSettingsSectionShell } from "./CloudSettingsSectionShell";

type HostedCloudSectionPath = "/cloud/account" | "/cloud/billing";

function HostedCloudSectionNavigate({
  to,
}: {
  to: HostedCloudSectionPath;
}): null {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    // This fixed host-shell transition leaves the settings view. Keep view
    // navigation gated while giving the shell router its existing identity.
    runAsPrivilegedShell(() =>
      navigate(`${to}${location.search}`, { replace: true }),
    );
  }, [navigate, to, location.search]);
  return null;
}

/** Hosted web settings sit inside CloudRouterShell. Native settings do not. */
function HostedCloudSectionRedirect({
  to,
  children,
}: {
  to: HostedCloudSectionPath;
  children: ReactNode;
}): React.JSX.Element {
  if (!useInRouterContext()) return <>{children}</>;
  return <HostedCloudSectionNavigate to={to} />;
}

export function CloudAccountSection(): React.JSX.Element {
  return (
    <HostedCloudSectionRedirect to="/cloud/account">
      <CloudAccountSectionBody />
    </HostedCloudSectionRedirect>
  );
}

function CloudAccountSectionBody(): React.JSX.Element {
  const {
    elizaCloudLoginBusy,
    elizaCloudLoginError,
    handleInteractiveCloudLogin,
    setActionNotice,
    t,
  } = useAppSelectorShallow((state) => ({
    elizaCloudLoginBusy: state.elizaCloudLoginBusy,
    elizaCloudLoginError: state.elizaCloudLoginError,
    handleInteractiveCloudLogin: state.handleInteractiveCloudLogin,
    setActionNotice: state.setActionNotice,
    t: state.t,
  }));
  const handleSignIn = useCallback(() => {
    claimCloudLoginWindow();
    // The Account session has resolved signed out. A connected agent or stale
    // renderer credential cannot satisfy this explicit browser sign-in.
    void handleInteractiveCloudLogin({
      requireClientAuth: true,
      forceReauth: true,
    }).catch((error) => {
      // error-policy:J4 Sign-in launch failures remain visible as an error notice.
      setActionNotice(
        error instanceof Error
          ? error.message
          : t("cloud.account.signInError", {
              defaultValue: "Could not start Eliza Cloud sign-in.",
            }),
        "error",
        5000,
      );
    });
  }, [handleInteractiveCloudLogin, setActionNotice, t]);

  return (
    <CloudSettingsSectionShell>
      <AccountSurface
        onSignIn={handleSignIn}
        signInBusy={elizaCloudLoginBusy}
        signInError={elizaCloudLoginError}
      />
    </CloudSettingsSectionShell>
  );
}

export function CloudBillingSection(): React.JSX.Element {
  return (
    <HostedCloudSectionRedirect to="/cloud/billing">
      <CloudBillingSectionBody />
    </HostedCloudSectionRedirect>
  );
}

function CloudBillingSectionBody(): React.JSX.Element {
  const {
    elizaCloudLoginBusy,
    elizaCloudLoginError,
    handleInteractiveCloudLogin,
    setActionNotice,
    t,
  } = useAppSelectorShallow((state) => ({
    elizaCloudLoginBusy: state.elizaCloudLoginBusy,
    elizaCloudLoginError: state.elizaCloudLoginError,
    handleInteractiveCloudLogin: state.handleInteractiveCloudLogin,
    setActionNotice: state.setActionNotice,
    t: state.t,
  }));
  const handleSignIn = useCallback(() => {
    claimCloudLoginWindow();
    void handleInteractiveCloudLogin({
      requireClientAuth: true,
      forceReauth: true,
    }).catch((error) => {
      // error-policy:J4 Sign-in launch failures remain visible and retryable.
      setActionNotice(
        error instanceof Error
          ? error.message
          : t("cloud.billing.signInError", {
              defaultValue: "Could not start Eliza Cloud sign-in.",
            }),
        "error",
        5000,
      );
    });
  }, [handleInteractiveCloudLogin, setActionNotice, t]);

  return (
    <CloudSettingsSectionShell>
      <BillingSectionBody
        onSignIn={handleSignIn}
        signInBusy={elizaCloudLoginBusy}
        signInError={elizaCloudLoginError}
      />
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
