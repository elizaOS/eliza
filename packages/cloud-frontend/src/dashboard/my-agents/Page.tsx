import { DashboardLoadingState } from "@elizaos/ui";
import { Helmet } from "react-helmet-async";
import { MyAgentsClient } from "../../components/my-agents/my-agents";
import { useRequireAuth } from "../../lib/auth-hooks";

/** /dashboard/my-agents */
export default function MyAgentsPage() {
  const session = useRequireAuth();

  return (
    <>
      <Helmet>
        <title>My Agent</title>
        <meta
          name="description"
          content="Administer your running Eliza Cloud agent."
        />
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      {!session.ready ? (
        <DashboardLoadingState label="Loading agents" />
      ) : (
        <MyAgentsClient />
      )}
    </>
  );
}
