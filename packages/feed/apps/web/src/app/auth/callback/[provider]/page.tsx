"use client";

import { consumeStewardPkceVerifier } from "@elizaos/shared/steward-session-client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
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
 * Snapshot of the OAuth params, captured at client module-eval time.
 *
 * Steward returns the one-time code in the URL *fragment* (`#code=…`). Next.js's
 * App Router normalizes the URL during hydration and drops the fragment before
 * our mount effect runs, so reading `window.location.hash` inside the effect
 * intermittently sees an empty hash and bounces the user back to `/` with
 * `auth_error=missing_code`. Module scope runs as the route chunk first
 * executes — earlier than the router's normalization — so the fragment is still
 * present here. The effect prefers this snapshot and only falls back to the live
 * location (for the legacy `?token=` query flow, which the router keeps).
 */
const INITIAL_OAUTH_LOCATION =
  typeof window !== "undefined"
    ? { hash: window.location.hash, search: window.location.search }
    : { hash: "", search: "" };

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
    // Referer / browser history. Read from the module-eval snapshot (see
    // INITIAL_OAUTH_LOCATION) because the App Router strips the fragment before
    // this effect runs; fall back to the live location for the legacy
    // token-in-URL flow (`?token=…`).
    const hash = INITIAL_OAUTH_LOCATION.hash || window.location.hash;
    const search = INITIAL_OAUTH_LOCATION.search || window.location.search;
    const hashParams = new URLSearchParams(hash.replace(/^#/, ""));
    const queryParams = new URLSearchParams(search);
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

    const redirectUri = buildFeedOAuthRedirectUri(
      window.location.origin,
      provider,
    );

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
