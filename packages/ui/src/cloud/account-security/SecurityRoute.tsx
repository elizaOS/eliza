/**
 * Security cloud route entry — the SOC2 user-facing overview.
 *
 * Lifted from `@elizaos/cloud-frontend/src/dashboard/security/Page.tsx`. Renders
 * the sessions / API-keys link / MFA / privacy / audit / incident panels. Page
 * title is set via {@link useDocumentTitle} (no Helmet).
 *
 * `SecuritySurface` is the embeddable body (used by the Wave-3 settings
 * section); the default export wraps it in a `PageHeaderProvider` for the
 * standalone `/dashboard/security` route (the body calls `useSetPageHeader`).
 */

import { Link } from "react-router-dom";
import {
  DashboardPageContainer,
  PageHeaderProvider,
  useSetPageHeader,
} from "../../cloud-ui";
import { useCloudT } from "../shell/CloudI18nProvider";
import { ActiveSessionsPanel } from "./components/active-sessions-panel";
import { ApiKeysLink } from "./components/api-keys-link";
import { IncidentReportPanel } from "./components/incident-report-panel";
import { MfaPanel } from "./components/mfa-panel";
import { PrivacyPanel } from "./components/privacy-panel";
import { RecentAuditEvents } from "./components/recent-audit-events";
import { useDocumentTitle } from "./use-document-title";

/**
 * The security surface. Embeddable: handed to the Wave-3 settings section and
 * wrapped by {@link SecurityRoute} for the standalone route. Assumes a
 * `PageHeaderProvider` ancestor (it sets the page header).
 */
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
          <Link
            to="/dashboard/security/permissions"
            className="rounded-sm bg-white/5 px-3 py-1 text-white/70 hover:bg-white/10"
          >
            {t("cloud.security.pluginPermissionsLink", {
              defaultValue: "Plugin permissions →",
            })}
          </Link>
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

/** Default export consumed by the cloud-route registry. */
export default function SecurityRoute() {
  return (
    <PageHeaderProvider>
      <SecuritySurface />
    </PageHeaderProvider>
  );
}
