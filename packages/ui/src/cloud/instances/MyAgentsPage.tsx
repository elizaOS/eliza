/**
 * "My Agent" page (`/dashboard/my-agents`) — the character library + agent
 * console.
 */

import {
  DashboardLoadingState,
  EnsurePageHeaderProvider,
} from "@elizaos/ui/cloud-ui";
import { useDocumentTitle } from "../lib/use-document-title";
import { useRequireAuth } from "../lib/use-session-auth";
import { MyAgentsClient } from "./components/my-agents";
import { useT } from "./lib/i18n";

export default function MyAgentsPage() {
  const t = useT();
  const session = useRequireAuth();

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
