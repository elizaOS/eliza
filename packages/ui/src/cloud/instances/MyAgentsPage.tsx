/**
 * "My Agent" page (`/dashboard/my-agents`) — the character library + agent
 * console.
 */

import {
  DashboardLoadingState,
  PageHeaderProvider,
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

  // MyAgentsClient sets the page header; this standalone route has no ancestor
  // PageHeaderProvider, so supply one here.
  return (
    <PageHeaderProvider>
      <MyAgentsClient />
    </PageHeaderProvider>
  );
}
