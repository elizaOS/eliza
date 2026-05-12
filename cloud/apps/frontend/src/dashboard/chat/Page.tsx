import { Helmet } from "react-helmet-async";
import { useSearchParams } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import { ElizaPageClient } from "../../components/chat/eliza-page-client";

/**
 * /dashboard/chat — free-mode chat page. Auth is optional; the underlying
 * client component handles anonymous-session bootstrap and character loading
 * over fetch. URL params (`roomId`, `characterId`) are forwarded as initial
 * selection hints.
 */
export default function ChatPage() {
  const { authenticated, user } = useSessionAuth();
  const [params] = useSearchParams();
  const initialRoomId = params.get("roomId") ?? undefined;
  const initialCharacterId = params.get("characterId") ?? undefined;

  return (
    <>
      <Helmet>
        <title>Chat with Eliza</title>
        <meta
          name="description"
          content="Chat with AI agents on Eliza Cloud. Anonymous sessions are supported — sign in to save your conversations."
        />
      </Helmet>
      <ElizaPageClient
        initialCharacters={[]}
        isAuthenticated={authenticated}
        userId={user?.id ?? null}
        initialRoomId={initialRoomId}
        initialCharacterId={initialCharacterId}
        sharedCharacter={null}
        isOwnerOfSelectedCharacter={false}
        accessError={undefined}
      />
    </>
  );
}
