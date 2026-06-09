"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useStewardAuthContext } from "@/components/providers/StewardAuthProvider";
import {
  buildFeedOAuthRedirectUri,
  consumeStewardPkceVerifier,
  type FeedStewardOAuthProvider,
} from "@/lib/steward-oauth";

const STEWARD_TENANT_ID = process.env.NEXT_PUBLIC_STEWARD_TENANT_ID ?? "feed";

function isFeedOAuthProvider(value: string): value is FeedStewardOAuthProvider {
  return value === "google" || value === "discord" || value === "twitter";
}

/**
 * OAuth callback page for Steward OAuth providers (Google, Discord, Twitter/X).
 *
 * PKCE code flow (current):
 *   ?code=<nonce>  → POST /api/auth/steward/oauth/exchange → session cookies
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

    const searchParams = new URLSearchParams(window.location.search);
    const error = searchParams.get("error");
    const code = searchParams.get("code");
    const token = searchParams.get("token");
    const refreshToken = searchParams.get("refresh_token") ?? undefined;

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
