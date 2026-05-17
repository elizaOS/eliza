import { DashboardLoadingState } from "@elizaos/ui";
import { Helmet } from "react-helmet-async";
import type { ElizaCharacter } from "@/lib/types";
import { useRequireAuth } from "../../lib/auth-hooks";
import { useMyAgents } from "../../lib/data/agents";
import { DocumentsPageClient } from "./_components/documents-page-client";

export default function DocumentsPage() {
  const { ready, authenticated } = useRequireAuth();
  const agentsQuery = useMyAgents();

  // Render Helmet unconditionally so the title is set even while auth
  // resolves; otherwise the homepage <title> bleeds through.
  const head = (
    <Helmet>
      <title>Knowledge</title>
      <meta
        name="description"
        content="Upload and manage documents for your agents to enhance AI responses with custom knowledge."
      />
    </Helmet>
  );

  if (!ready || !authenticated)
    return (
      <>
        {head}
        <DashboardLoadingState label="Loading Knowledge" />
      </>
    );

  const characters: ElizaCharacter[] =
    agentsQuery.data?.map((a) => ({
      id: a.id,
      name: a.name,
      bio:
        typeof a.bio === "string" || Array.isArray(a.bio)
          ? (a.bio as string | string[])
          : "",
    })) ?? [];

  return (
    <>
      {head}
      {agentsQuery.isLoading ? (
        <DashboardLoadingState label="Loading Knowledge" />
      ) : (
        <DocumentsPageClient initialCharacters={characters} />
      )}
    </>
  );
}
