/**
 * Public shared-chat landing for a character. Fetches the redacted public
 * character from /api/characters/:ref/public (no-login funnel) and presents it
 * with a CTA into the full Eliza chat experience. Renders WITHOUT app-shell
 * chrome.
 *
 * This page intentionally does NOT mount a chat tree: the full chat
 * experience is the app shell's own continuous-chat surface, so this page only
 * resolves + presents the shared character and links into the app chat.
 */

import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../../lib/api-client";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { useMetaTag, usePageTitle } from "../../lib/use-page-title";

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
  return trimmed ? trimmed : null;
}

export default function PublicChatPage() {
  const t = useCloudT();
  const { characterRef } = useParams<{ characterRef: string }>();
  const normalizedRef = normalizeCharacterRef(characterRef);
  const [character, setCharacter] = useState<PublicCharacterInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!normalizedRef) {
      setLoading(false);
      setError(
        t("cloud.publicChat.missingIdentifier", {
          defaultValue: "Missing agent identifier.",
        }),
      );
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setCharacter(null);

    api<PublicCharacterResponse>(
      `/api/characters/${encodeURIComponent(normalizedRef)}/public`,
      { signal: controller.signal },
    )
      .then((payload) => {
        if (!payload.success || !payload.data) {
          throw new Error(
            payload?.error ??
              t("cloud.publicChat.notFound", {
                defaultValue: "Agent not found.",
              }),
          );
        }
        setCharacter(payload.data);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(
          err instanceof Error
            ? err.message
            : t("cloud.publicChat.notFound", {
                defaultValue: "Agent not found.",
              }),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [normalizedRef, t]);

  const title = useMemo(
    () =>
      character
        ? t("cloud.publicChat.titleWithName", {
            name: character.name,
            defaultValue: "Chat with {{name}} | Eliza Cloud",
          })
        : t("cloud.publicChat.title", { defaultValue: "Chat | Eliza Cloud" }),
    [character, t],
  );

  usePageTitle(
    loading || character
      ? title
      : t("cloud.publicChat.notFoundTitle", {
          defaultValue: "Agent Not Found | Eliza Cloud",
        }),
  );
  useMetaTag("robots", !loading && (!character || error) ? "noindex" : null);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-white">
        <div className="flex items-center gap-3 text-white/70">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t("cloud.publicChat.loadingAgent", {
            defaultValue: "Loading agent...",
          })}
        </div>
      </div>
    );
  }

  if (!character || error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black p-6 text-white">
        <div className="max-w-md space-y-4 text-center">
          <h1 className="text-2xl font-semibold">
            {t("cloud.publicChat.notFoundHeading", {
              defaultValue: "Agent not found",
            })}
          </h1>
          <p className="text-sm text-white/60">
            {error ??
              t("cloud.publicChat.unavailableOrPrivate", {
                defaultValue:
                  "This shared agent link is unavailable or private.",
              })}
          </p>
          <Link
            className="text-sm text-white/70 hover:text-white transition-colors"
            to="/"
          >
            {t("cloud.publicChat.openChat", { defaultValue: "Open chat" })}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-black p-6 text-white">
      <div className="w-full max-w-md space-y-6 text-center">
        {character.avatarUrl ? (
          <img
            src={character.avatarUrl}
            alt=""
            className="mx-auto h-20 w-20 rounded-full border border-white/10 object-cover"
          />
        ) : (
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border border-white/10 bg-white/5 text-2xl font-semibold text-white/70">
            {character.name.slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">{character.name}</h1>
          {character.creatorUsername ? (
            <p className="text-sm text-white/50">
              @{character.creatorUsername}
            </p>
          ) : null}
          {character.bio ? (
            <p className="text-sm leading-relaxed text-white/70">
              {character.bio}
            </p>
          ) : null}
        </div>
        <Link
          to={`/?characterId=${encodeURIComponent(character.id)}`}
          className="inline-flex w-full items-center justify-center bg-[#FF5800] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#e54f00]"
        >
          {t("cloud.publicChat.startChat", {
            name: character.name,
            defaultValue: "Chat with {{name}}",
          })}
        </Link>
      </div>
    </div>
  );
}
