/**
 * "My Agent" page (`/dashboard/my-agents`) — the character library + agent
 * console. Ported from
 * `@elizaos/cloud-frontend/src/dashboard/my-agents/Page.tsx`.
 */

import { DashboardLoadingState } from "@elizaos/ui/cloud-ui";
import { MyAgentsClient } from "./components/my-agents";
import { useT } from "./lib/i18n";
import { useDocumentTitle } from "./lib/use-document-title";
import { useRequireAuth } from "./lib/use-session-auth";

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

  return <MyAgentsClient />;
}
