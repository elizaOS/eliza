"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AlertCircle, Loader2 } from "lucide-react";
import { useLogin, usePrivy } from "@privy-io/react-auth";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

function AuthErrorContent() {
  const { login } = useLogin();
  const { ready } = usePrivy();
  const searchParams = useSearchParams();
  const reason = searchParams.get("reason") || "unknown";
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const errorMessages: Record<string, { title: string; description: string }> =
    {
      auth_failed: {
        title: "Authentication Failed",
        description:
          "We could not authenticate your account. Please try signing in again.",
      },
      sync_failed: {
        title: "Authentication Sync Failed",
        description:
          "We could not sync your account information. Please try signing in again.",
      },
      unknown: {
        title: "Authentication Error",
        description:
          "An unexpected error occurred during authentication. Please try again.",
      },
    };

  const error = errorMessages[reason] || errorMessages.unknown;

  const handleLogin = async () => {
    setIsLoggingIn(true);
    await login();
    setTimeout(() => setIsLoggingIn(false), 1000);
  };

  const isLoading = !ready || isLoggingIn;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <AlertCircle className="h-6 w-6 text-destructive" />
          </div>
          <CardTitle>{error.title}</CardTitle>
          <CardDescription>{error.description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2">
            <Button onClick={handleLogin} disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Loading...
                </>
              ) : (
                "Try Again"
              )}
            </Button>
            <Button variant="outline" asChild>
              <Link href="/">Go Home</Link>
            </Button>
          </div>
          <div className="text-center text-xs text-muted-foreground">
            If this problem persists, please contact support.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Authentication error page with dynamic error messages based on reason query parameter.
 * Supports retry functionality and displays appropriate error details.
 */
export default function AuthErrorPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background p-4">
          <Card className="w-full max-w-md">
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
                <AlertCircle className="h-6 w-6 text-destructive" />
              </div>
              <CardTitle>Authentication Error</CardTitle>
              <CardDescription>Loading error details...</CardDescription>
            </CardHeader>
          </Card>
        </div>
      }
    >
      <AuthErrorContent />
    </Suspense>
  );
}
