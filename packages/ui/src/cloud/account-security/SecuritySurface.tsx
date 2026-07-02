/**
 * Security surface — the SOC2 user-facing overview: sessions / API-keys link /
 * MFA / privacy / audit / incident panels. Mounted by the `cloud-security`
 * Settings section (`/settings#cloud-security`).
 */

import { DashboardPageContainer, useSetPageHeader } from "../../cloud-ui";
import { useDocumentTitle } from "../lib/use-document-title";
import { useCloudT } from "../shell/CloudI18nProvider";
import { ActiveSessionsPanel } from "./components/active-sessions-panel";
import { ApiKeysLink } from "./components/api-keys-link";
import { IncidentReportPanel } from "./components/incident-report-panel";
import { MfaPanel } from "./components/mfa-panel";
import { PrivacyPanel } from "./components/privacy-panel";
import { RecentAuditEvents } from "./components/recent-audit-events";

/** The security surface. Assumes a `PageHeaderProvider` ancestor. */
export function SecuritySurface() {
  const t = useCloudT();
  useSetPageHeader({
    title: "Security",
    description:
      "Sessions, keys, MFA, privacy controls, and audit visibility for your account.",
  });
  useDocumentTitle(
    t("cloud.security.metaTitle", { defaultValue: "Security · Eliza Cloud" }),
  );

  return (
    <DashboardPageContainer>
      <div className="space-y-6">
        <nav className="flex flex-wrap gap-2 text-xs">
          {/* Plain anchor: an in-settings hash change fires `hashchange`,
              which is what SettingsView listens to for section switches. */}
          <a
            href="#cloud-plugin-grants"
            className="rounded-sm bg-white/5 px-3 py-1 text-white/70 hover:bg-white/10"
          >
            {t("cloud.security.pluginPermissionsLink", {
              defaultValue: "Plugin permissions →",
            })}
          </a>
        </nav>
        <ActiveSessionsPanel />
        <ApiKeysLink />
        <MfaPanel />
        <PrivacyPanel />
        <RecentAuditEvents />
        <IncidentReportPanel />
      </div>
    </DashboardPageContainer>
  );
}
