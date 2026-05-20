import { DashboardLoadingState } from "@elizaos/ui";
import { Helmet } from "react-helmet-async";
import type { ElizaCharacter } from "@/lib/types";
import { useT } from "@/providers/I18nProvider";
import { useRequireAuth } from "../../lib/auth-hooks";
import { useMyAgents } from "../../lib/data/agents";
import { DocumentsPageClient } from "./_components/documents-page-client";

export default function DocumentsPage() {
  const t = useT();
  const { ready, authenticated } = useRequireAuth();
  const agentsQuery = useMyAgents();

  // Render Helmet unconditionally so the title is set even while auth
  // resolves; otherwise the homepage <title> bleeds through.
  const head = (
    <Helmet>
      <title>
        {t("cloud.documents.metaTitle", { defaultValue: "Knowledge" })}
      </title>
      <meta
        name="description"
        content={t("cloud.documents.metaDescription", {
          defaultValue:
            "Upload and manage documents for your agents to enhance AI responses with custom knowledge.",
        })}
      />
    </Helmet>
  );

  if (!ready || !authenticated)
    return (
      <>
        {head}
        <DashboardLoadingState
          label={t("cloud.documents.loading", {
            defaultValue: "Loading Knowledge",
          })}
        />
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
        <DashboardLoadingState
          label={t("cloud.documents.loading", {
            defaultValue: "Loading Knowledge",
          })}
        />
      ) : (
        <DocumentsPageClient initialCharacters={characters} />
      )}
    </>
  );
}
