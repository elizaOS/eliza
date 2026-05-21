import { DashboardPageContainer, useSetPageHeader } from "@elizaos/ui";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { ActiveSessionsPanel } from "./_components/active-sessions-panel";
import { ApiKeysLink } from "./_components/api-keys-link";
import { IncidentReportPanel } from "./_components/incident-report-panel";
import { MfaPanel } from "./_components/mfa-panel";
import { PrivacyPanel } from "./_components/privacy-panel";
import { RecentAuditEvents } from "./_components/recent-audit-events";

/** /dashboard/security — SOC2 user-facing overview page. */
export default function SecurityPage() {
  useSetPageHeader({
    title: "Security",
    description:
      "Sessions, keys, MFA, privacy controls, and audit visibility for your account.",
  });
  return (
    <>
      <Helmet>
        <title>Security · Eliza Cloud</title>
      </Helmet>
      <DashboardPageContainer>
        <div className="space-y-6">
          <nav className="flex flex-wrap gap-2 text-xs">
            <Link
              to="/dashboard/security/permissions"
              className="rounded-sm border border-white/15 bg-white/5 px-3 py-1 text-white/70 hover:bg-white/10"
            >
              Plugin permissions →
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
    </>
  );
}
