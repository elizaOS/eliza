/**
 * Security surface — SOC2 user-facing overview. Working controls (plugin
 * grants, API keys, privacy switches, account deletion, incident report) stay
 * live. Sessions / MFA / audit-log reading / data export stay behind one
 * honest availability notice until #22873 ships them. Mounted by the
 * `cloud-security` Settings section (`/settings#cloud-security`).
 */

import { DashboardPageContainer, useSetPageHeader } from "../../cloud-ui";
import { useDocumentTitle } from "../lib/use-document-title";
import { useCloudT } from "../shell/CloudI18nProvider";
import {
  type AccountSecurityCapabilities,
  DEFAULT_ACCOUNT_SECURITY_CAPABILITIES,
  listUnavailableAccountSecurityCapabilities,
} from "./account-security-capabilities";
import { ActiveSessionsPanel } from "./components/active-sessions-panel";
import { ApiKeysLink } from "./components/api-keys-link";
import { IncidentReportPanel } from "./components/incident-report-panel";
import { MfaPanel } from "./components/mfa-panel";
import { PluginPermissionsLink } from "./components/plugin-permissions-link";
import { PrivacyPanel } from "./components/privacy-panel";
import { RecentAuditEvents } from "./components/recent-audit-events";
import { UnavailableAccountSecurityNotice } from "./components/unavailable-account-security-notice";

/** The security surface. Assumes a `PageHeaderProvider` ancestor. */
export function SecuritySurface({
  capabilities = DEFAULT_ACCOUNT_SECURITY_CAPABILITIES,
}: {
  capabilities?: AccountSecurityCapabilities;
} = {}) {
  const t = useCloudT();
  useSetPageHeader({
    title: "Security",
    description:
      "Privacy controls, account deletion, and related security settings for your account.",
  });
  useDocumentTitle(
    t("cloud.security.metaTitle", { defaultValue: "Security · Eliza Cloud" }),
  );

  const unavailable = listUnavailableAccountSecurityCapabilities(capabilities);

  return (
    <DashboardPageContainer>
      <div className="space-y-6">
        <PluginPermissionsLink />
        {capabilities.sessions ? <ActiveSessionsPanel /> : null}
        <ApiKeysLink />
        {capabilities.mfa ? <MfaPanel /> : null}
        <PrivacyPanel />
        {capabilities.auditLog ? <RecentAuditEvents /> : null}
        {unavailable.length > 0 ? (
          <UnavailableAccountSecurityNotice unavailable={unavailable} />
        ) : null}
        <IncidentReportPanel />
      </div>
    </DashboardPageContainer>
  );
}
