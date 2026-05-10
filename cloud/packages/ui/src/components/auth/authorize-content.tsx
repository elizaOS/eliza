"use client";

import { BrandButton, BrandCard, CornerBrackets } from "../primitives";
import Image from "../../runtime/image";
import { useRouter, useSearchParams } from "../../runtime/navigation";
import { StewardLogin, useAuth } from "@stwd/react";
import { AlertTriangle, CheckCircle2, Loader2, Shield } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { storeCurrentAppAuthorizeReturnTo } from "./authorize-return";

interface AppInfo {
  id: string;
  name: string;
  description?: string;
  logo_url?: string;
  website_url?: string;
}

type AuthorizeStatus = "validating" | "ready" | "authorizing" | "error";

export function AuthorizeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const appId = searchParams.get("app_id");
  const redirectUri = searchParams.get("redirect_uri");
  const state = searchParams.get("state");

  if (!appId) {
    return (
      <AuthorizationErrorFrame
        error="Missing app_id parameter. Apps must be registered with Eliza Cloud."
        onHome={() => router.push("/")}
      />
    );
  }

  if (!redirectUri) {
    return (
      <AuthorizationErrorFrame
        error="Missing redirect_uri parameter."
        onHome={() => router.push("/")}
      />
    );
  }

  return <AuthorizeAuthenticatedContent appId={appId} redirectUri={redirectUri} state={state} />;
}

function AuthorizeAuthenticatedContent({
  appId,
  redirectUri,
  state,
}: {
  appId: string;
  redirectUri: string;
  state: string | null;
}) {
  const {
    isLoading: authLoading,
    isAuthenticated,
    getToken,
    signOut,
    providers,
    isProvidersLoading,
  } = useAuth();
  // Steward provider discovery (Google/Discord/etc) is fetched at app shell
  // mount, but on a cold load to /app-auth/authorize the round-trip can take a
  // few seconds. Reveal the login section atomically once providers resolve so
  // OAuth buttons don't pop in one-by-one underneath passkey/email.
  const providersReady = providers !== null || !isProvidersLoading;
  const router = useRouter();

  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [status, setStatus] = useState<AuthorizeStatus>("validating");
  const [error, setError] = useState<string | null>(null);

  useEffect(storeCurrentAppAuthorizeReturnTo, []);

  // Validate app + redirect_uri exactly once on mount.
  useEffect(() => {
    let cancelled = false;

    async function validateApp() {
      try {
        const uri = new URL(redirectUri);
        if (!uri.protocol.startsWith("http")) throw new Error("Invalid protocol");
      } catch {
        setError("Invalid redirect_uri format.");
        setStatus("error");
        return;
      }

      try {
        const res = await fetch(
          `/api/v1/apps/${appId}/public?redirect_uri=${encodeURIComponent(redirectUri)}`,
        );
        if (cancelled) return;

        if (!res.ok) {
          if (res.status === 404) {
            setError("App not found. Please ensure the app is registered with Eliza Cloud.");
          } else if (res.status === 400) {
            setError("This redirect URI is not registered for the selected app.");
          } else {
            setError("Failed to verify app.");
          }
          setStatus("error");
          return;
        }

        const data = await res.json();
        setAppInfo(data.app);
        setStatus("ready");
      } catch {
        if (cancelled) return;
        setError("Failed to verify app. Please try again.");
        setStatus("error");
      }
    }

    void validateApp();
    return () => {
      cancelled = true;
    };
  }, [appId, redirectUri]);

  const handleAuthorize = useCallback(async () => {
    if (!appId || !redirectUri) return;
    const token = getToken();
    if (!token) {
      // Edge case: useAuth says authenticated but token isn't readable.
      // Force re-sign-in rather than silently failing.
      signOut();
      setError("Your session expired. Please sign in again.");
      setStatus("ready");
      return;
    }

    setStatus("authorizing");
    setError(null);

    try {
      const res = await fetch("/api/v1/app-auth/connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ appId }),
      });

      if (!res.ok) {
        const message =
          res.status === 401
            ? "Authentication failed. Please sign in again."
            : `Failed to connect to ${appInfo?.name ?? "the app"} (HTTP ${res.status}).`;
        throw new Error(message);
      }

      const url = new URL(redirectUri);
      url.searchParams.set("token", token);
      if (state) url.searchParams.set("state", state);
      window.location.href = url.toString();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to complete authorization.";
      setError(message);
      setStatus("ready");
    }
  }, [appId, redirectUri, state, appInfo?.name, getToken, signOut]);

  const handleCancel = useCallback(() => {
    if (!redirectUri) {
      router.push("/");
      return;
    }
    const url = new URL(redirectUri);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("error_description", "User denied authorization");
    if (state) url.searchParams.set("state", state);
    window.location.href = url.toString();
  }, [redirectUri, state, router]);

  // Render.

  if (status === "validating" || authLoading) {
    return (
      <Frame>
        <Loader2 className="h-12 w-12 animate-spin text-[#FF5800]" />
        <h3 className="text-lg font-semibold text-white">Verifying application...</h3>
      </Frame>
    );
  }

  if (status === "error" && !appInfo) {
    return <AuthorizationErrorFrame error={error} onHome={() => router.push("/")} />;
  }

  // The earlier returns guarantee appInfo is set from here on (status is
  // either "ready", "authorizing", or "error"-with-appInfo-loaded).
  if (!appInfo) return null;

  if (status === "authorizing") {
    return (
      <Frame>
        <Loader2 className="h-12 w-12 animate-spin text-[#FF5800]" />
        <h3 className="text-lg font-semibold text-white">Authorizing...</h3>
        <p className="text-sm text-white/60">Redirecting you back to {appInfo.name}</p>
      </Frame>
    );
  }

  return (
    <Frame>
      <AppHeader appInfo={appInfo} />
      <PermissionsList />

      {error && (
        <div className="rounded-md border border-red-400/40 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {isAuthenticated ? (
        <SignedInActions
          appName={appInfo.name}
          onAuthorize={handleAuthorize}
          onCancel={handleCancel}
        />
      ) : (
        <SignedOutActions onCancel={handleCancel} providersReady={providersReady} />
      )}

      <p className="text-center text-xs text-white/40">
        By continuing, you agree to share your account information with this app.
      </p>
    </Frame>
  );
}

// Presentational helpers kept local to this file.

function AuthorizationErrorFrame({ error, onHome }: { error: string | null; onHome: () => void }) {
  return (
    <Frame>
      <div className="p-4 rounded-full bg-red-500/20">
        <AlertTriangle className="h-8 w-8 text-red-400" />
      </div>
      <h3 className="text-lg font-semibold text-white">Authorization Error</h3>
      <p className="text-sm text-white/60 max-w-xs text-center">{error}</p>
      <BrandButton variant="outline" onClick={onHome} className="mt-4">
        Go to Eliza Cloud
      </BrandButton>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  // Intentionally no LandingHeader. The header renders different markup on
  // server vs client based on auth state, and the resulting hydration error
  // remounted the tree and prevented validateApp's effect from completing.
  // Consent screens are also better off header-less (Google/GitHub do the
  // same): single-purpose, not a navigable location.
  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-black via-zinc-900 to-black" />
      <div className="relative z-10 flex flex-1 items-center justify-center p-4">
        <BrandCard className="w-full max-w-md backdrop-blur-sm bg-black/60">
          <CornerBrackets size="md" className="opacity-50" />
          <div className="relative z-10 flex flex-col items-center gap-6 py-8 px-2">{children}</div>
        </BrandCard>
      </div>
    </div>
  );
}

function AppHeader({ appInfo }: { appInfo: AppInfo }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      {appInfo.logo_url ? (
        <Image
          src={appInfo.logo_url}
          alt={appInfo.name}
          width={64}
          height={64}
          className="h-16 w-16 rounded-xl object-cover"
          unoptimized
        />
      ) : (
        <div className="h-16 w-16 rounded-xl bg-gradient-to-br from-[#FF5800] to-[#FF8800] flex items-center justify-center">
          <span className="text-2xl font-bold text-white">{appInfo.name.charAt(0)}</span>
        </div>
      )}
      <div>
        <h1 className="text-xl font-bold text-white">{appInfo.name}</h1>
        {appInfo.website_url && (
          <p className="text-sm text-white/50 mt-1">{new URL(appInfo.website_url).hostname}</p>
        )}
      </div>
    </div>
  );
}

function PermissionsList() {
  return (
    <div className="space-y-3 p-4 rounded-lg bg-white/5 border border-white/10 w-full">
      <div className="flex items-center gap-2 text-white/80">
        <Shield className="h-4 w-4 text-[#FF5800]" />
        <span className="text-sm font-medium">This app wants to:</span>
      </div>
      <ul className="space-y-2 text-sm text-white/60 ml-6">
        <li className="flex items-center gap-2">
          <div className="h-1.5 w-1.5 rounded-full bg-[#FF5800]" />
          Access your Eliza Cloud account
        </li>
        <li className="flex items-center gap-2">
          <div className="h-1.5 w-1.5 rounded-full bg-[#FF5800]" />
          Use AI features paid for from your cloud credit balance
        </li>
      </ul>
    </div>
  );
}

function SignedInActions({
  appName,
  onAuthorize,
  onCancel,
}: {
  appName: string;
  onAuthorize: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex items-center justify-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80">
        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
        <span>Signed in</span>
      </div>
      <BrandButton onClick={onAuthorize} className="w-full">
        Authorize {appName}
      </BrandButton>
      <BrandButton variant="ghost" onClick={onCancel} className="w-full">
        Cancel
      </BrandButton>
    </div>
  );
}

function SignedOutActions({
  onCancel,
  providersReady,
}: {
  onCancel: () => void;
  providersReady: boolean;
}) {
  return (
    <div className="flex w-full flex-col gap-4">
      {providersReady ? (
        <StewardLogin variant="inline" showPasskey showEmail title="Sign in to authorize" />
      ) : (
        <div className="flex flex-col items-center gap-3 py-6">
          <Loader2 className="h-6 w-6 animate-spin text-[#FF5800]" />
          <p className="text-sm text-white/60">Loading sign-in options...</p>
        </div>
      )}
      <BrandButton variant="ghost" onClick={onCancel} className="w-full">
        Cancel
      </BrandButton>
    </div>
  );
}
