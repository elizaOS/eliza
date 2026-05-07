import { DashboardLoadingState } from "@elizaos/cloud-ui";
import { Helmet } from "react-helmet-async";
import { MyAgentsClient } from "@elizaos/cloud-ui/components/my-agents/my-agents";
import { useRequireAuth } from "../../lib/auth-hooks";

/** /dashboard/my-agents */
export default function MyAgentsPage() {
  const session = useRequireAuth();

  return (
    <>
      <Helmet>
        <title>My Agents</title>
        <meta
          name="description"
          content="Manage the agents you have created or saved on Eliza Cloud."
        />
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      {!session.ready ? <DashboardLoadingState label="Loading agents" /> : <MyAgentsClient />}
    </>
  );
}
