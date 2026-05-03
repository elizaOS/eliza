import { DashboardLoadingState } from "@elizaos/cloud-ui";
import { Helmet } from "react-helmet-async";
import type { ElizaCharacter } from "@/lib/types";
import { KnowledgePageClient } from "@/packages/ui/src/components/knowledge/knowledge-page-client";
import { useRequireAuth } from "../../lib/auth-hooks";
import { useMyAgents } from "../../lib/data/agents";

export default function KnowledgePage() {
  const { ready, authenticated } = useRequireAuth();
  const agentsQuery = useMyAgents();

  if (!ready || !authenticated) return <DashboardLoadingState label="Loading Knowledge" />;

  const characters: ElizaCharacter[] =
    agentsQuery.data?.map((a) => ({
      id: a.id,
      name: a.name,
      bio: typeof a.bio === "string" || Array.isArray(a.bio) ? (a.bio as string | string[]) : "",
    })) ?? [];

  return (
    <>
      <Helmet>
        <title>Knowledge</title>
        <meta
          name="description"
          content="Upload and manage documents for your agents to enhance AI responses with custom knowledge."
        />
      </Helmet>
      {agentsQuery.isLoading ? (
        <DashboardLoadingState label="Loading Knowledge" />
      ) : (
        <KnowledgePageClient initialCharacters={characters} />
      )}
    </>
  );
}
