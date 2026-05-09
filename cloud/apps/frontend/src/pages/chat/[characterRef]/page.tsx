import { PageHeaderProvider } from "@elizaos/cloud-ui";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link, useParams } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import { ElizaPageClient } from "../../../components/chat/eliza-page-client";
import { api } from "../../../lib/api-client";

interface PublicCharacterInfo {
  id: string;
  name: string;
  username?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  creatorUsername?: string | null;
}

interface PublicCharacterResponse {
  success: boolean;
  data?: PublicCharacterInfo;
  error?: string;
}

function normalizeCharacterRef(ref: string | undefined): string | null {
  const trimmed = ref?.trim();
  if (!trimmed) return null;
  return trimmed;
}

export default function PublicChatPage() {
  const { characterRef } = useParams<{ characterRef: string }>();
  const normalizedRef = normalizeCharacterRef(characterRef);
  const { authenticated, user } = useSessionAuth();
  const [character, setCharacter] = useState<PublicCharacterInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!normalizedRef) {
      setLoading(false);
      setError("Missing agent identifier.");
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setCharacter(null);

    api<PublicCharacterResponse>(`/api/characters/${encodeURIComponent(normalizedRef)}/public`, {
      signal: controller.signal,
    })
      .then((payload) => {
        if (!payload.success || !payload.data) {
          throw new Error(payload?.error ?? "Agent not found.");
        }
        setCharacter(payload.data);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Agent not found.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [normalizedRef]);

  const title = useMemo(
    () => (character ? `Chat with ${character.name} | Eliza Cloud` : "Chat | Eliza Cloud"),
    [character],
  );

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-white">
        <Helmet>
          <title>{title}</title>
        </Helmet>
        <div className="flex items-center gap-3 text-white/70">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading agent...
        </div>
      </div>
    );
  }

  if (!character || error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black p-6 text-white">
        <Helmet>
          <title>Agent Not Found | Eliza Cloud</title>
          <meta name="robots" content="noindex" />
        </Helmet>
        <div className="max-w-md space-y-4 text-center">
          <h1 className="text-2xl font-semibold">Agent not found</h1>
          <p className="text-sm text-white/60">
            {error ?? "This shared agent link is unavailable or private."}
          </p>
          <Link className="text-sm text-[#FF5800] hover:text-[#FF5800]/80" to="/dashboard/chat">
            Open chat
          </Link>
        </div>
      </div>
    );
  }

  return (
    <PageHeaderProvider>
      <Helmet>
        <title>{title}</title>
        <meta name="description" content={`Chat with ${character.name} on Eliza Cloud.`} />
      </Helmet>
      <div className="dashboard-theme flex h-screen min-h-screen bg-neutral-950 text-white">
        <ElizaPageClient
          initialCharacters={[]}
          isAuthenticated={authenticated}
          userId={user?.id ?? null}
          initialCharacterId={character.id}
          sharedCharacter={{
            id: character.id,
            name: character.name,
            username: character.username,
            avatarUrl: character.avatarUrl,
            bio: character.bio ?? undefined,
            creatorUsername: character.creatorUsername,
          }}
          isOwnerOfSelectedCharacter={false}
          accessError={undefined}
        />
      </div>
    </PageHeaderProvider>
  );
}
