"use client";

import { useEffect, useState, useCallback, Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  Terminal,
  CheckCircle2,
  AlertCircle,
  Key,
} from "lucide-react";

function CliLoginContent() {
  const { authenticated, login, user, ready } = usePrivy();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session");

  // Compute initial status from props to avoid setState in effect
  const initialStatus = useMemo(() => {
    if (!sessionId) {
      return {
        status: "error" as const,
        errorMessage: "Invalid authentication link. Missing session ID.",
      };
    }
    if (!authenticated) {
      return { status: "waiting_auth" as const, errorMessage: "" };
    }
    return { status: "loading" as const, errorMessage: "" };
  }, [sessionId, authenticated]);

  const [status, setStatus] = useState<
    "loading" | "waiting_auth" | "completing" | "success" | "error"
  >(initialStatus.status);
  const [errorMessage, setErrorMessage] = useState<string>(
    initialStatus.errorMessage,
  );
  const [apiKeyPrefix, setApiKeyPrefix] = useState<string>("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const completeCliLogin = useCallback(async () => {
    if (!sessionId) {
      setStatus("error");
      setErrorMessage("Session ID is missing");
      return;
    }

    setStatus("completing");

    try {
      const response = await fetch(
        `/api/auth/cli-session/${sessionId}/complete`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        setStatus("error");
        setErrorMessage(errorData.error || "Failed to complete authentication");
        return;
      }

      const data = await response.json();

      setApiKeyPrefix(data.keyPrefix);
      setStatus("success");
    } catch (error) {
      console.error("CLI login error:", error);
      setStatus("error");
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Network error. Please try again.",
      );
    }
  }, [sessionId]);

  // Update status when props change (avoiding synchronous setState)
  useEffect(() => {
    // Don't override "completing" or "success" states - they represent process progress
    // that shouldn't be reset by initial status changes
    if (status === "completing" || status === "success") {
      return;
    }

    const nextStatus = initialStatus.status;
    const nextErrorMessage = initialStatus.errorMessage;

    // Only update if status changed to avoid unnecessary renders
    if (status !== nextStatus || errorMessage !== nextErrorMessage) {
      // Use setTimeout to avoid synchronous setState in effect
      const timer = setTimeout(() => {
        setStatus(nextStatus);
        setErrorMessage(nextErrorMessage);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [initialStatus.status, initialStatus.errorMessage, status, errorMessage]);

  // Separate effect for completing login when authenticated
  useEffect(() => {
    if (initialStatus.status === "loading" && authenticated && sessionId) {
      // Use setTimeout to avoid synchronous setState in effect
      const timer = setTimeout(() => {
        completeCliLogin();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [initialStatus.status, authenticated, sessionId, completeCliLogin]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A] p-4">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] via-neutral-900/50 to-[#0A0A0A]" />
        <div className="relative w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl p-8">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[#FF5800]/10">
              <Loader2 className="h-7 w-7 animate-spin text-[#FF5800]" />
            </div>
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-white">Loading...</h2>
              <p className="text-sm text-neutral-500">
                Preparing authentication
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A] p-4">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] via-neutral-900/50 to-[#0A0A0A]" />
        <div className="relative w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl p-8">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-red-500/10">
              <AlertCircle className="h-7 w-7 text-red-500" />
            </div>
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-white">
                Authentication Error
              </h2>
              <p className="text-sm text-neutral-500">{errorMessage}</p>
            </div>
            <Button
              onClick={() => window.close()}
              variant="outline"
              className="w-full mt-2 rounded-xl border-white/10 hover:bg-white/10"
            >
              Close Window
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (status === "waiting_auth") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A] p-4">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] via-neutral-900/50 to-[#0A0A0A]" />
        <div className="relative w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl p-8">
          <div className="flex flex-col items-center gap-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[#FF5800]/10">
              <Terminal className="h-7 w-7 text-[#FF5800]" />
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-semibold text-white">
                CLI Authentication
              </h2>
              <p className="text-sm text-neutral-500">
                Sign in to connect your elizaOS CLI to the cloud
              </p>
            </div>
            <Button
              onClick={async () => {
                setIsLoggingIn(true);
                await login();
                setTimeout(() => setIsLoggingIn(false), 1000);
              }}
              className="w-full h-11 rounded-xl bg-[#FF5800] hover:bg-[#FF5800]/80 text-white"
              disabled={!ready || isLoggingIn}
            >
              {!ready || isLoggingIn ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Loading...
                </>
              ) : (
                "Sign In"
              )}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (status === "completing") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A] p-4">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] via-neutral-900/50 to-[#0A0A0A]" />
        <div className="relative w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl p-8">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[#FF5800]/10">
              <Key className="h-7 w-7 text-[#FF5800] animate-pulse" />
            </div>
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-white">
                Generating API Key
              </h2>
              <p className="text-sm text-neutral-500">
                Creating your credentials for CLI access...
              </p>
            </div>
            <div className="flex gap-1.5 mt-2">
              <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800] [animation-delay:-0.3s]" />
              <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800] [animation-delay:-0.15s]" />
              <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800]" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A] p-4">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] via-neutral-900/50 to-[#0A0A0A]" />
        <div className="relative w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl p-8">
          <div className="flex flex-col items-center gap-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-green-500/10">
              <CheckCircle2 className="h-7 w-7 text-green-500" />
            </div>
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-white">
                Authentication Complete!
              </h2>
              <p className="text-sm text-neutral-500">
                Your API key has been generated and sent to the CLI
              </p>
            </div>

            <div className="w-full rounded-xl bg-black/40 border border-white/10 p-4 space-y-3">
              <p className="text-xs font-medium text-neutral-400">
                API Key Details
              </p>
              <div className="text-sm space-y-2">
                <div className="flex justify-between">
                  <span className="text-neutral-500">Prefix</span>
                  <span className="font-mono text-white">{apiKeyPrefix}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Created for</span>
                  <span className="text-white">
                    {user?.email?.address || "Your account"}
                  </span>
                </div>
              </div>
            </div>

            <div className="w-full rounded-xl border border-green-500/20 bg-green-500/5 p-4">
              <p className="text-sm text-green-400 flex items-center justify-center gap-2">
                <CheckCircle2 className="h-4 w-4" />
                You can now close this window and return to your terminal
              </p>
            </div>

            <Button
              onClick={() => window.close()}
              variant="outline"
              className="w-full rounded-xl border-white/10 hover:bg-white/10"
            >
              Close Window
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

/**
 * CLI login page for authenticating command-line tool users.
 * Handles Privy authentication and generates API keys for CLI access.
 */
export default function CliLoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A] p-4">
          <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] via-neutral-900/50 to-[#0A0A0A]" />
          <div className="relative w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl p-8">
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[#FF5800]/10">
                <Loader2 className="h-7 w-7 animate-spin text-[#FF5800]" />
              </div>
              <div className="space-y-1">
                <h2 className="text-xl font-semibold text-white">Loading...</h2>
                <p className="text-sm text-neutral-500">
                  Initializing authentication
                </p>
              </div>
            </div>
          </div>
        </div>
      }
    >
      <CliLoginContent />
    </Suspense>
  );
}
