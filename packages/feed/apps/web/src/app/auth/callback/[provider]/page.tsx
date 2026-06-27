"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { consumeStewardPkceVerifier } from "@elizaos/shared/steward-session-client";
import { useStewardAuthContext } from "@/components/providers/StewardAuthProvider";

type FeedStewardOAuthProvider = "google" | "discord" | "twitter";

function buildFeedOAuthRedirectUri(
  origin: string,
  provider: FeedStewardOAuthProvider,
): string {
  return `${origin}/auth/callback/${provider}`;
}

const STEWARD_TENANT_ID = process.env.NEXT_PUBLIC_STEWARD_TENANT_ID ?? "feed";

function isFeedOAuthProvider(value: string): value is FeedStewardOAuthProvider {
  return value === "google" || value === "discord" || value === "twitter";
}

/**
 * OAuth callback page for Steward OAuth providers (Google, Discord, Twitter/X).
 *
 * PKCE code flow (current):
 *   #code=<nonce>  → POST /api/auth/steward/oauth/exchange → session cookies
 *   (Steward returns the code in the URL fragment, not the query string.)
 *
 * Legacy token-in-URL flow (backward compat during rollout):
 *   ?token=<jwt>&refresh_token=<rt>
 */
export default function OAuthCallbackPage() {
  const { onLoginSuccess } = useStewardAuthContext();
  const router = useRouter();
  const params = useParams<{ provider: string }>();
  const processed = useRef(false);

  useEffect(() => {
    if (processed.current) return;
    processed.current = true;

    const provider = params.provider;
    if (!provider || !isFeedOAuthProvider(provider)) {
      router.replace("/?auth_error=invalid_provider");
      return;
    }

    // Steward's PKCE flow returns the one-time code in the URL *fragment*
    // (`#code=…&state=…`) — deliberately, so it stays out of server logs /
    // Referer / browser history. Read the fragment first, then fall back to the
    // query string for the legacy token-in-URL flow (`?token=…`).
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const queryParams = new URLSearchParams(window.location.search);
    const pick = (key: string): string | null =>
      hashParams.get(key) ?? queryParams.get(key);
    const error = pick("error");
    const code = pick("code");
    const token = pick("token");
    const refreshToken = pick("refresh_token") ?? undefined;

    window.history.replaceState(null, "", window.location.pathname);

    if (error) {
      router.replace(`/?auth_error=${encodeURIComponent(error)}`);
      return;
    }

    if (token) {
      onLoginSuccess(token, refreshToken)
        .then(() => router.replace("/"))
        .catch((err: Error) => {
          router.replace(`/?auth_error=${encodeURIComponent(err.message)}`);
        });
      return;
    }

    if (!code) {
      router.replace("/?auth_error=missing_code");
      return;
    }

    const codeVerifier = consumeStewardPkceVerifier();
    if (!codeVerifier) {
      router.replace("/?auth_error=missing_pkce_verifier");
      return;
    }

    const redirectUri = buildFeedOAuthRedirectUri(window.location.origin, provider);

    fetch("/api/auth/steward/oauth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        code,
        redirectUri,
        tenantId: STEWARD_TENANT_ID,
        codeVerifier,
      }),
    })
      .then(async (response) => {
        const data = (await response.json()) as {
          ok: boolean;
          token?: string;
          refreshToken?: string | null;
          error?: string;
        };
        if (!response.ok || !data.ok || !data.token) {
          throw new Error(data.error ?? "OAuth exchange failed");
        }
        return onLoginSuccess(data.token, data.refreshToken ?? undefined);
      })
      .then(() => router.replace("/"))
      .catch((err: Error) => {
        router.replace(`/?auth_error=${encodeURIComponent(err.message)}`);
      });
  }, [onLoginSuccess, params.provider, router]);

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="text-center">
        <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-muted-foreground text-sm">Completing sign-in…</p>
      </div>
    </div>
  );
}
