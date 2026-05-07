import { Helmet } from "react-helmet-async";
import { useSearchParams } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import { BuildPageClient } from "../../components/chat/build-page-client";

/**
 * /dashboard/build — free-mode character builder. Auth is optional; the
 * client component fetches the user's characters when authenticated and
 * scaffolds a draft character locally otherwise.
 */
export default function BuildPage() {
  const { authenticated, user } = useSessionAuth();
  const [params] = useSearchParams();
  const initialCharacterId = params.get("characterId") ?? undefined;

  return (
    <>
      <Helmet>
        <title>Build an Agent</title>
        <meta
          name="description"
          content="Build and customize AI agents using the elizaOS runtime with intelligent assistance."
        />
      </Helmet>
      <BuildPageClient
        initialCharacters={[]}
        isAuthenticated={authenticated}
        userId={user?.id ?? null}
        initialCharacterId={initialCharacterId}
      />
    </>
  );
}
