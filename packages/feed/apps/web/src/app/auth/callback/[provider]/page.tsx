"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useStewardAuthContext } from "@/components/providers/StewardAuthProvider";

/**
 * OAuth callback page for Steward OAuth providers (Google, Discord, Twitter/X).
 *
 * Steward redirects here after a successful OAuth flow with:
 *   ?token=<jwt>&refresh_token=<rt>   (on success)
 *   ?error=<message>                  (on failure)
 *
 * Security: Immediately sanitizes the URL via replaceState() to prevent
 * the JWT from appearing in browser history, referrer headers, or server logs.
 */
export default function OAuthCallbackPage() {
  const { onLoginSuccess } = useStewardAuthContext();
  const router = useRouter();
  const processed = useRef(false);

  useEffect(() => {
    if (processed.current) return;
    processed.current = true;

    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const refreshToken = params.get("refresh_token") ?? undefined;
    const error = params.get("error");

    // Sanitize URL immediately — remove sensitive query params from history
    window.history.replaceState(null, "", window.location.pathname);

    if (error) {
      router.replace(`/?auth_error=${encodeURIComponent(error)}`);
      return;
    }

    if (!token) {
      router.replace("/?auth_error=missing_token");
      return;
    }

    onLoginSuccess(token, refreshToken)
      .then(() => {
        router.replace("/");
      })
      .catch((err: Error) => {
        router.replace(`/?auth_error=${encodeURIComponent(err.message)}`);
      });
  }, [onLoginSuccess, router]);

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="text-center">
        <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-muted-foreground text-sm">Completing sign-in…</p>
      </div>
    </div>
  );
}
