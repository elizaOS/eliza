"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Terminal, CheckCircle2, AlertCircle } from "lucide-react";

export function CliLoginContent() {
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
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
            <CardTitle>Loading...</CardTitle>
            <CardDescription>Preparing authentication</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </div>
            <CardTitle>Authentication Error</CardTitle>
            <CardDescription>{errorMessage}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => window.close()}
              variant="outline"
              className="w-full"
            >
              Close Window
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (status === "waiting_auth") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Terminal className="h-6 w-6 text-primary" />
            </div>
            <CardTitle>CLI Authentication</CardTitle>
            <CardDescription>
              Sign in to connect your elizaOS CLI to the cloud
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={async () => {
                setIsLoggingIn(true);
                await login();
                setTimeout(() => setIsLoggingIn(false), 1000);
              }}
              className="w-full"
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
          </CardContent>
        </Card>
      </div>
    );
  }

  if (status === "completing") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
            <CardTitle>Generating API Key</CardTitle>
            <CardDescription>
              Creating your credentials for CLI access...
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
              <CheckCircle2 className="h-6 w-6 text-green-500" />
            </div>
            <CardTitle>Authentication Complete!</CardTitle>
            <CardDescription>
              Your API key has been generated and sent to the CLI
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg bg-muted p-4">
              <p className="text-sm font-medium mb-2">API Key Details:</p>
              <div className="text-xs text-muted-foreground space-y-1">
                <p>
                  <span className="font-medium">Prefix:</span> {apiKeyPrefix}
                </p>
                <p>
                  <span className="font-medium">Created for:</span>{" "}
                  {user?.email?.address || "Your account"}
                </p>
              </div>
            </div>

            <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-4">
              <p className="text-sm text-center">
                ✓ You can now close this window and return to your terminal
              </p>
            </div>

            <Button
              onClick={() => window.close()}
              variant="outline"
              className="w-full"
            >
              Close Window
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return null;
}

export function CliLoginFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
          <CardTitle>Loading...</CardTitle>
          <CardDescription>Initializing authentication</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
