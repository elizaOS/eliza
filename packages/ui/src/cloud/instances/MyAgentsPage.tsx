/**
 * "My Agent" page (`/cloud/my-agents`) — the character library + agent
 * console.
 */

import { DashboardLoadingState } from "../../cloud-ui/components/dashboard/route-placeholders";
import { EnsurePageHeaderProvider } from "../../cloud-ui/components/layout/page-header-context";
import { useDocumentTitle } from "../lib/use-document-title";
import { useSessionAuth } from "../lib/use-session-auth";
import { useCloudT as useT } from "../shell/CloudI18nProvider";
import { MyAgentsClient } from "./components/my-agents";

export default function MyAgentsPage() {
  const t = useT();
  const session = useSessionAuth();

  useDocumentTitle(t("cloud.myAgents.metaTitle", { defaultValue: "My Agent" }));

  if (!session.ready) {
    return (
      <DashboardLoadingState
        label={t("cloud.myAgents.loading", {
          defaultValue: "Loading agents",
        })}
      />
    );
  }

  // MyAgentsClient sets the page header. When this route renders inside the
  // ConsoleShell, its provider already exists and drives the top-bar title;
  // EnsurePageHeaderProvider defers to it (and supplies one only for the
  // standalone/native mount) so the title reaches the shell header instead of
  // a shadowed inner provider.
  return (
    <EnsurePageHeaderProvider>
      <MyAgentsClient />
    </EnsurePageHeaderProvider>
  );
}
