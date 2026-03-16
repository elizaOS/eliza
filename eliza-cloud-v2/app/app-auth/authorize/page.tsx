"use client";

import { useEffect, useState, Suspense } from "react";
import { usePrivy, useLogin } from "@privy-io/react-auth";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { BrandButton } from "@/components/brand";
import { Loader2, AlertTriangle, Shield, ArrowRight, X } from "lucide-react";
import LandingHeader from "@/components/layout/landing-header";

interface AppInfo {
  id: string;
  name: string;
  description?: string;
  logo_url?: string;
  website_url?: string;
}

function AuthorizeContent() {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const { login } = useLogin();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthorizing, setIsAuthorizing] = useState(false);

  const appId = searchParams.get("app_id");
  const redirectUri = searchParams.get("redirect_uri");
  const state = searchParams.get("state");

  // Validate and fetch app info
  useEffect(() => {
    async function validateApp() {
      if (!appId) {
        setError(
          "Missing app_id parameter. Apps must be registered with Eliza Cloud.",
        );
        setIsLoading(false);
        return;
      }

      if (!redirectUri) {
        setError("Missing redirect_uri parameter.");
        setIsLoading(false);
        return;
      }

      // Validate redirect URI format
      try {
        const uri = new URL(redirectUri);
        // Allow localhost for development
        if (!uri.protocol.startsWith("http")) {
          throw new Error("Invalid protocol");
        }
      } catch {
        setError("Invalid redirect_uri format.");
        setIsLoading(false);
        return;
      }

      // Fetch app info
      try {
        const res = await fetch(`/api/v1/apps/${appId}/public`);
        if (!res.ok) {
          if (res.status === 404) {
            setError(
              "App not found. Please ensure the app is registered with Eliza Cloud.",
            );
          } else {
            setError("Failed to verify app.");
          }
          setIsLoading(false);
          return;
        }

        const data = await res.json();
        setAppInfo(data.app);
        setIsLoading(false);
      } catch {
        setError("Failed to verify app. Please try again.");
        setIsLoading(false);
      }
    }

    validateApp();
  }, [appId, redirectUri]);

  // Handle authorization after login
  useEffect(() => {
    async function completeAuthorization() {
      if (!ready || !authenticated || !user || !appInfo || !redirectUri) return;
      if (isAuthorizing) return;

      setIsAuthorizing(true);

      try {
        // Get the Privy access token
        const token = await getAccessToken();

        if (!token) {
          setError("Failed to get authentication token.");
          setIsAuthorizing(false);
          return;
        }

        // Record the app user connection
        await fetch("/api/v1/app-auth/connect", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ appId }),
        });

        // Build redirect URL with token
        const redirectUrl = new URL(redirectUri);
        redirectUrl.searchParams.set("token", token);
        if (state) {
          redirectUrl.searchParams.set("state", state);
        }

        // Redirect back to the app
        window.location.href = redirectUrl.toString();
      } catch (err) {
        console.error("Authorization error:", err);
        setError("Failed to complete authorization. Please try again.");
        setIsAuthorizing(false);
      }
    }

    completeAuthorization();
  }, [
    ready,
    authenticated,
    user,
    appId,
    appInfo,
    redirectUri,
    state,
    getAccessToken,
    isAuthorizing,
  ]);

  const handleLogin = () => {
    login();
  };

  const handleCancel = () => {
    if (redirectUri) {
      const redirectUrl = new URL(redirectUri);
      redirectUrl.searchParams.set("error", "access_denied");
      redirectUrl.searchParams.set(
        "error_description",
        "User denied authorization",
      );
      if (state) {
        redirectUrl.searchParams.set("state", state);
      }
      window.location.href = redirectUrl.toString();
    } else {
      router.push("/");
    }
  };

  // Loading state
  if (!ready || isLoading) {
    return (
      <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#0A0A0A]">
        <LandingHeader />
        <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] via-neutral-900/50 to-[#0A0A0A]" />
        <div className="relative z-10 flex flex-1 items-center justify-center p-4">
          <div className="w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl p-8">
            <div className="flex flex-col items-center gap-6">
              <div className="relative">
                <Loader2 className="h-12 w-12 animate-spin text-[#FF5800]" />
                <div className="absolute inset-0 h-12 w-12 animate-pulse rounded-full bg-[#FF5800]/20 blur-xl" />
              </div>
              <div className="space-y-1 text-center">
                <h3 className="text-lg font-semibold text-white">
                  Verifying application...
                </h3>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#0A0A0A]">
        <LandingHeader />
        <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] via-neutral-900/50 to-[#0A0A0A]" />
        <div className="relative z-10 flex flex-1 items-center justify-center p-4">
          <div className="w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl p-8">
            <div className="flex flex-col items-center gap-6">
              <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-red-500/10">
                <AlertTriangle className="h-7 w-7 text-red-500" />
              </div>
              <div className="space-y-2 text-center">
                <h3 className="text-lg font-semibold text-white">
                  Authorization Error
                </h3>
                <p className="text-sm text-neutral-500 max-w-xs">{error}</p>
              </div>
              <button
                onClick={() => router.push("/")}
                className="px-6 py-2.5 rounded-xl border border-white/10 text-sm text-white hover:bg-white/10 transition-colors"
              >
                Go to Eliza Cloud
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Authorizing state (after login)
  if (authenticated && isAuthorizing) {
    return (
      <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#0A0A0A]">
        <LandingHeader />
        <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] via-neutral-900/50 to-[#0A0A0A]" />
        <div className="relative z-10 flex flex-1 items-center justify-center p-4">
          <div className="w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl p-8">
            <div className="flex flex-col items-center gap-6">
              <div className="relative">
                <Loader2 className="h-12 w-12 animate-spin text-[#FF5800]" />
                <div className="absolute inset-0 h-12 w-12 animate-pulse rounded-full bg-[#FF5800]/20 blur-xl" />
              </div>
              <div className="space-y-2 text-center">
                <h3 className="text-lg font-semibold text-white">
                  Authorizing...
                </h3>
                <p className="text-sm text-neutral-500">
                  Redirecting you back to {appInfo?.name || "the app"}
                </p>
              </div>
              <div className="flex gap-1.5">
                <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800] [animation-delay:-0.3s]" />
                <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800] [animation-delay:-0.15s]" />
                <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800]" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Authorization prompt (not logged in)
  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#0A0A0A]">
      <LandingHeader />
      <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] via-neutral-900/50 to-[#0A0A0A]" />
      <div className="relative z-10 flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl p-6 md:p-8">
          <div className="space-y-6">
            {/* App info */}
            <div className="flex flex-col items-center gap-4 text-center">
              {appInfo?.logo_url ? (
                <Image
                  src={appInfo.logo_url}
                  alt={appInfo.name || "App logo"}
                  width={64}
                  height={64}
                  className="h-16 w-16 rounded-xl object-cover"
                  unoptimized
                />
              ) : (
                <div className="h-16 w-16 rounded-xl bg-gradient-to-br from-[#FF5800] to-[#FF8800] flex items-center justify-center">
                  <span className="text-2xl font-bold text-white">
                    {appInfo?.name?.charAt(0) || "A"}
                  </span>
                </div>
              )}
              <div>
                <h1 className="text-xl font-semibold text-white">
                  {appInfo?.name || "Application"}
                </h1>
                {appInfo?.website_url && (
                  <p className="text-sm text-neutral-500 mt-1">
                    {new URL(appInfo.website_url).hostname}
                  </p>
                )}
              </div>
            </div>

            {/* Permission info */}
            <div className="space-y-3 p-4 rounded-xl bg-black/40 border border-white/10">
              <div className="flex items-center gap-2 text-white">
                <Shield className="h-4 w-4 text-[#FF5800]" />
                <span className="text-sm font-medium">This app wants to:</span>
              </div>
              <ul className="space-y-2 text-sm text-neutral-400 ml-6">
                <li className="flex items-center gap-2">
                  <div className="h-1.5 w-1.5 rounded-full bg-[#FF5800]" />
                  Access your Eliza Cloud account
                </li>
                <li className="flex items-center gap-2">
                  <div className="h-1.5 w-1.5 rounded-full bg-[#FF5800]" />
                  Use AI features with your credits
                </li>
              </ul>
            </div>

            {/* Actions */}
            <div className="space-y-3">
              <BrandButton
                variant="primary"
                onClick={handleLogin}
                className="w-full h-11 rounded-xl"
              >
                {authenticated ? (
                  <>
                    <ArrowRight className="mr-2 h-4 w-4" />
                    Continue as {user?.email?.address || "User"}
                  </>
                ) : (
                  "Sign in with Eliza Cloud"
                )}
              </BrandButton>
              <button
                onClick={handleCancel}
                className="w-full flex items-center justify-center gap-2 py-2.5 text-sm text-neutral-500 hover:text-white transition-colors"
              >
                <X className="h-4 w-4" />
                Cancel
              </button>
            </div>

            {/* Footer */}
            <p className="text-center text-xs text-neutral-600 pt-2 border-t border-white/10">
              By continuing, you agree to share your account information with
              this app.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function LoadingFallback() {
  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#0A0A0A]">
      <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] via-neutral-900/50 to-[#0A0A0A]" />
      <div className="relative z-10 flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl p-8">
          <div className="flex flex-col items-center gap-6">
            <div className="relative">
              <Loader2 className="h-12 w-12 animate-spin text-[#FF5800]" />
              <div className="absolute inset-0 h-12 w-12 animate-pulse rounded-full bg-[#FF5800]/20 blur-xl" />
            </div>
            <div className="space-y-1 text-center">
              <h3 className="text-lg font-semibold text-white">Loading...</h3>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * App Authorization Page
 *
 * OAuth-style authorization flow for third-party apps.
 * Users sign in with their Eliza Cloud account and authorize the app.
 */
export default function AppAuthorizePage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <AuthorizeContent />
    </Suspense>
  );
}
