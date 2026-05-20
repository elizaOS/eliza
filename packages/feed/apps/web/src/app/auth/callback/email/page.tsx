"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useStewardAuthContext } from "@/components/providers/StewardAuthProvider";

/**
 * Email magic-link callback page.
 *
 * Steward redirects here after a user clicks the magic link in their email:
 *   ?token=<verification_token>&email=<email>
 *
 * Calls stewardAuth.verifyEmailCallback() to exchange the token for a session
 * JWT, then POSTs to /api/auth/session to set the httpOnly cookie.
 */
export default function EmailCallbackPage() {
  const { stewardAuth, onLoginSuccess } = useStewardAuthContext();
  const router = useRouter();
  const processed = useRef(false);

  useEffect(() => {
    if (processed.current) return;
    processed.current = true;

    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const email = params.get("email");

    // Sanitize URL immediately
    window.history.replaceState(null, "", window.location.pathname);

    if (!token || !email) {
      router.replace("/?auth_error=missing_params");
      return;
    }

    stewardAuth
      .verifyEmailCallback(token, email)
      .then((result) => onLoginSuccess(result.token))
      .then(() => router.replace("/"))
      .catch((err: Error) => {
        router.replace(`/?auth_error=${encodeURIComponent(err.message)}`);
      });
  }, [stewardAuth, onLoginSuccess, router]);

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="text-center">
        <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-muted-foreground text-sm">Verifying your email…</p>
      </div>
    </div>
  );
}
