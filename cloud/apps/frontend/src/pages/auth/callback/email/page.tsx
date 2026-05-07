import { BrandButton, BrandCard, CornerBrackets } from "@elizaos/cloud-ui";
import { useAuth } from "@stwd/react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  clearStoredAppAuthorizeReturnTo,
  readStoredAppAuthorizeReturnTo,
} from "@elizaos/cloud-ui/components/auth/authorize-return";
import { syncStewardSessionCookie } from "../../../../lib/steward-session";

type CallbackStatus = "verifying" | "success" | "error";

export default function StewardEmailCallbackPage() {
  const [searchParams] = useSearchParams();
  const { verifyEmailCallback, isAuthenticated } = useAuth();
  const attemptedRef = useRef(false);
  const [status, setStatus] = useState<CallbackStatus>("verifying");
  const [error, setError] = useState<string | null>(null);

  const returnTo = useMemo(readStoredAppAuthorizeReturnTo, []);

  useEffect(() => {
    if (attemptedRef.current) return;
    attemptedRef.current = true;

    if (!returnTo) {
      setStatus("error");
      setError("Could not find the app authorization request. Start sign-in again from the app.");
      return;
    }

    let redirectTimer: ReturnType<typeof setTimeout> | null = null;
    const finishSuccess = () => {
      clearStoredAppAuthorizeReturnTo();
      setStatus("success");
      redirectTimer = setTimeout(() => {
        window.location.replace(returnTo);
      }, 1500);
    };

    if (isAuthenticated) {
      finishSuccess();
      return () => {
        if (redirectTimer) clearTimeout(redirectTimer);
      };
    }

    const token = searchParams.get("token");
    const email = searchParams.get("email");
    if (!token || !email) {
      setStatus("error");
      setError("This sign-in link is missing its token or email.");
      return;
    }

    void (async () => {
      try {
        const result = await verifyEmailCallback(token, email);
        await syncStewardSessionCookie(result.token, result.refreshToken);
        finishSuccess();
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Could not verify this sign-in link.");
      }
    })();

    return () => {
      if (redirectTimer) clearTimeout(redirectTimer);
    };
  }, [isAuthenticated, returnTo, searchParams, verifyEmailCallback]);

  if (status === "error") {
    return (
      <Frame>
        <div className="rounded-full bg-red-500/20 p-4">
          <AlertTriangle className="h-8 w-8 text-red-400" />
        </div>
        <h1 className="text-lg font-semibold text-white">Sign-in failed</h1>
        <p className="max-w-xs text-center text-sm text-white/60">{error}</p>
      </Frame>
    );
  }

  if (status === "success") {
    return (
      <Frame>
        <CheckCircle2 className="h-12 w-12 text-emerald-400" />
        <h1 className="text-lg font-semibold text-white">Signed in</h1>
        <p className="text-sm text-white/60">Returning to the app authorization screen...</p>
        <BrandButton className="mt-2" onClick={() => returnTo && window.location.assign(returnTo)}>
          Continue to app authorization
        </BrandButton>
      </Frame>
    );
  }

  return (
    <Frame>
      <Loader2 className="h-12 w-12 animate-spin text-[#FF5800]" />
      <h1 className="text-lg font-semibold text-white">Verifying sign-in link...</h1>
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-black via-zinc-900 to-black" />
      <div className="relative z-10 flex flex-1 items-center justify-center p-4">
        <BrandCard className="w-full max-w-md bg-black/60 backdrop-blur-sm">
          <CornerBrackets size="md" className="opacity-50" />
          <div className="relative z-10 flex flex-col items-center gap-6 px-2 py-8">{children}</div>
        </BrandCard>
      </div>
    </div>
  );
}
