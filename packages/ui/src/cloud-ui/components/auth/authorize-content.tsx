"use client";

/**
 * App-authorize screen content: Steward login (Discord/Google) and the return-to handoff.
 */
import {
  clearStoredStewardToken,
  readStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { DiscordIcon, GoogleIcon, StewardLogin, useAuth } from "@stwd/react";
import type { StewardProviders } from "@stwd/sdk";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invalidateStewardServerCookieSyncMarker } from "../../../cloud/lib/steward-session-cookie-sync-marker";
import {
  buildStewardOAuthRedirectUri,
  resolveStewardOAuthTenantId,
} from "../../../cloud/public-pages/lib/steward-oauth-url";
import { Alert } from "../../../components/ui/alert";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "../../../components/ui/avatar";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import Image from "../../runtime/image";
import { useRouter, useSearchParams } from "../../runtime/navigation";
import { CornerBrackets } from "../primitives";
import {
  buildAppAuthorizeCancelRedirect,
  buildAppAuthorizeCompletionRedirect,
  buildAppAuthorizeLoginHref,
  isSafeAppAuthorizeRedirectUri,
  storeCurrentAppAuthorizeReturnTo,
} from "./authorize-return";

const MOBILE_APP_CALLBACK_URI = "elizaos://auth/callback";

interface MobileAuthorizeRequest {
  clientId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  deviceName?: string;
  environment: string;
  flow: "mobile_pkce";
}

interface AppInfo {
  id: string;
  name: string;
  description?: string;
  logo_url?: string;
  website_url?: string;
}

type AuthorizeStatus = "validating" | "ready" | "authorizing" | "error";
type AppAuthorizeOAuthProvider = "google" | "discord";
type AppAuthorizeOAuthSignIn = (
  provider: AppAuthorizeOAuthProvider,
  config?: { redirectUri?: string; tenantId?: string },
) => Promise<unknown>;
type AppAuthorizeAuthState = {
  activeTenantId: string | null;
  getToken: () => string | null | undefined;
  isAuthenticated: boolean;
  isLoading: boolean;
  isProvidersLoading: boolean;
  providers: StewardProviders | null;
  signInWithOAuth: AppAuthorizeOAuthSignIn;
  signOut: () => unknown;
};

function isPlaywrightTestAuthEnabled(): boolean {
  return (
    import.meta.env.VITE_PLAYWRIGHT_TEST_AUTH === "true" ||
    (typeof process !== "undefined" &&
      process.env?.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true")
  );
}

const TEST_AUTH_PROVIDERS: StewardProviders = {
  passkey: true,
  email: true,
  siwe: false,
  siws: false,
  google: false,
  discord: false,
  github: false,
  twitter: false,
  oauth: [],
};

const APP_AUTHORIZE_OAUTH_PROVIDERS = [
  {
    id: "google",
    label: "Continue with Google",
    buttonClassName: "stwd-login__btn--google",
    spinnerClassName: "stwd-login__spinner--dark",
    Icon: GoogleIcon,
  },
  {
    id: "discord",
    label: "Continue with Discord",
    buttonClassName: "stwd-login__btn--discord",
    spinnerClassName: "",
    Icon: DiscordIcon,
  },
] satisfies Array<{
  id: AppAuthorizeOAuthProvider;
  label: string;
  buttonClassName: string;
  spinnerClassName: string;
  Icon: typeof GoogleIcon;
}>;

export function AuthorizeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const appId = searchParams.get("app_id");
  const redirectUri = searchParams.get("redirect_uri");
  const state = searchParams.get("state");
  const serializedSearchParams = searchParams.toString();
  const mobileRequest = useMemo(
    () =>
      parseMobileAuthorizeRequest(new URLSearchParams(serializedSearchParams)),
    [serializedSearchParams],
  );

  if (searchParams.get("flow") === "mobile_pkce" && !mobileRequest) {
    return (
      <AuthorizationErrorFrame
        error="The mobile sign-in request is incomplete. Return to Eliza and try again."
        onHome={() => router.push("/")}
      />
    );
  }

  if (!mobileRequest && !appId) {
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

  return (
    <AuthorizeAuthenticatedContent
      appId={appId ?? ""}
      mobileRequest={mobileRequest}
      redirectUri={redirectUri}
      state={state}
    />
  );
}

function parseMobileAuthorizeRequest(
  searchParams: URLSearchParams,
): MobileAuthorizeRequest | null {
  if (searchParams.get("flow") !== "mobile_pkce") return null;
  const clientId = searchParams.get("client_id")?.trim();
  const environment = searchParams.get("environment")?.trim();
  const codeChallenge = searchParams.get("code_challenge")?.trim();
  const codeChallengeMethod = searchParams.get("code_challenge_method")?.trim();
  const state = searchParams.get("state")?.trim();
  const redirectUri = searchParams.get("redirect_uri")?.trim();
  if (
    !clientId ||
    !environment ||
    !codeChallenge ||
    !codeChallengeMethod ||
    !state ||
    !redirectUri
  ) {
    return null;
  }
  const deviceName = searchParams.get("device_name")?.trim() || undefined;
  return {
    clientId,
    codeChallenge,
    codeChallengeMethod,
    deviceName,
    environment,
    flow: "mobile_pkce",
  };
}

function readPlaywrightTestToken(): string {
  if (typeof window === "undefined") return "playwright-test-token";
  try {
    return readStoredStewardToken() ?? "playwright-test-token";
  } catch {
    return "playwright-test-token";
  }
}

function AuthorizeAuthenticatedContent({
  appId,
  mobileRequest,
  redirectUri,
  state,
}: {
  appId: string;
  mobileRequest: MobileAuthorizeRequest | null;
  redirectUri: string;
  state: string | null;
}) {
  if (mobileRequest) {
    const token = readStoredStewardToken()?.trim() || null;
    return (
      <AuthorizeFlow
        appId={appId}
        auth={{
          activeTenantId: null,
          getToken: () => token,
          isAuthenticated: token !== null,
          isLoading: false,
          providers: null,
          isProvidersLoading: false,
          signInWithOAuth: async () => undefined,
          signOut: clearStoredStewardToken,
        }}
        mobileRequest={mobileRequest}
        redirectUri={redirectUri}
        state={state}
      />
    );
  }

  if (isPlaywrightTestAuthEnabled()) {
    return (
      <AuthorizeFlow
        appId={appId}
        auth={{
          activeTenantId: null,
          getToken: readPlaywrightTestToken,
          isAuthenticated: true,
          isLoading: false,
          isProvidersLoading: false,
          providers: TEST_AUTH_PROVIDERS,
          signInWithOAuth: async () => undefined,
          signOut: () => undefined,
        }}
        mobileRequest={mobileRequest}
        redirectUri={redirectUri}
        state={state}
      />
    );
  }

  return (
    <AuthorizeStewardContent
      appId={appId}
      mobileRequest={mobileRequest}
      redirectUri={redirectUri}
      state={state}
    />
  );
}

function AuthorizeStewardContent({
  appId,
  mobileRequest,
  redirectUri,
  state,
}: {
  appId: string;
  mobileRequest: MobileAuthorizeRequest | null;
  redirectUri: string;
  state: string | null;
}) {
  return (
    <AuthorizeFlow
      appId={appId}
      auth={useAuth() as AppAuthorizeAuthState}
      mobileRequest={mobileRequest}
      redirectUri={redirectUri}
      state={state}
    />
  );
}

function AuthorizeFlow({
  appId,
  auth,
  mobileRequest,
  redirectUri,
  state,
}: {
  appId: string;
  auth: AppAuthorizeAuthState;
  mobileRequest: MobileAuthorizeRequest | null;
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
    signInWithOAuth,
    activeTenantId,
  } = auth;
  // Steward provider discovery (Google/Discord/etc) is fetched at app shell
  // mount, but on a cold load to /app-auth/authorize the round-trip can take a
  // few seconds. Reveal the login section atomically once providers resolve so
  // OAuth buttons don't pop in one-by-one underneath passkey/email.
  const providersReady = providers !== null || !isProvidersLoading;
  const router = useRouter();

  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [status, setStatus] = useState<AuthorizeStatus>("validating");
  const [error, setError] = useState<string | null>(null);
  const mobileAuthorizationStarted = useRef(false);

  useEffect(storeCurrentAppAuthorizeReturnTo, []);

  // Validate app + redirect_uri exactly once on mount.
  useEffect(() => {
    let cancelled = false;

    async function validateApp() {
      if (!isSafeAppAuthorizeRedirectUri(redirectUri)) {
        setError("Invalid redirect_uri format.");
        setStatus("error");
        return;
      }

      try {
        const validationUrl = mobileRequest
          ? (() => {
              const url = new URL(
                "/api/v1/app-auth/mobile/config",
                window.location.origin,
              );
              url.searchParams.set("clientId", mobileRequest.clientId);
              url.searchParams.set("environment", mobileRequest.environment);
              url.searchParams.set("redirectUri", redirectUri);
              return `${url.pathname}${url.search}`;
            })()
          : `/api/v1/apps/${appId}/public?redirect_uri=${encodeURIComponent(redirectUri)}`;
        const res = await fetch(validationUrl);
        if (cancelled) return;

        if (!res.ok) {
          if (res.status === 404) {
            setError(
              "App not found. Please ensure the app is registered with Eliza Cloud.",
            );
          } else if (res.status === 400) {
            setError(
              "This redirect URI is not registered for the selected app.",
            );
          } else {
            setError("Failed to verify app.");
          }
          setStatus("error");
          return;
        }

        const data = (await res.json()) as {
          app?: {
            description?: string;
            id?: string;
            logoUrl?: string;
            logo_url?: string;
            name?: string;
            websiteUrl?: string;
            website_url?: string;
          };
        };
        if (!data.app?.name) {
          setError("Eliza Cloud returned invalid application metadata.");
          setStatus("error");
          return;
        }
        setAppInfo({
          id: data.app.id ?? (mobileRequest ? mobileRequest.clientId : appId),
          name: data.app.name,
          description: data.app.description,
          logo_url: data.app.logo_url ?? data.app.logoUrl,
          website_url: data.app.website_url ?? data.app.websiteUrl,
        });
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
  }, [appId, mobileRequest, redirectUri]);

  const handleAuthorize = useCallback(async () => {
    if ((!appId && !mobileRequest) || !redirectUri) return;
    const token = getToken();
    if (!token) {
      // Edge case: useAuth says authenticated but token isn't readable.
      // Force re-sign-in rather than silently failing. This component consumes
      // the raw SDK context (not LocalStewardAuthContext), so retire any
      // explicit-sync proof here before the SDK begins fallible sign-out work.
      invalidateStewardServerCookieSyncMarker();
      signOut();
      if (mobileRequest) {
        window.location.assign(
          buildAppAuthorizeLoginHref(window.location.search),
        );
        return;
      }
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
        body: JSON.stringify(
          mobileRequest
            ? {
                ...mobileRequest,
                redirectUri,
                state,
              }
            : { appId, redirectUri },
        ),
      });

      if (!res.ok) {
        if (mobileRequest && res.status === 401) {
          invalidateStewardServerCookieSyncMarker();
          signOut();
          window.location.assign(
            buildAppAuthorizeLoginHref(window.location.search),
          );
          return;
        }
        const message =
          res.status === 401
            ? "Authentication failed. Please sign in again."
            : `Failed to connect to ${appInfo?.name ?? "the app"} (HTTP ${res.status}).`;
        throw new Error(message);
      }

      // error-policy:J3 parse of the authorize response body; a malformed/empty
      // body yields null and the missing-code check below throws a visible
      // error rather than proceeding with a fabricated code.
      const data = (await res.json().catch(() => null)) as {
        code?: unknown;
      } | null;
      const code = typeof data?.code === "string" ? data.code : "";
      if (!code) {
        throw new Error(
          "Authorization failed because no authorization code was returned.",
        );
      }

      // The mount-time gate already ran, but the navigation sink re-checks
      // the hand-off scheme so no future refactor can route around it.
      if (!isSafeAppAuthorizeRedirectUri(redirectUri)) {
        throw new Error("Invalid redirect_uri format.");
      }

      window.location.assign(
        buildAppAuthorizeCompletionRedirect({
          code,
          redirectUri: mobileRequest ? MOBILE_APP_CALLBACK_URI : redirectUri,
          state,
        }),
      );
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to complete authorization.";
      setError(message);
      setStatus(mobileRequest ? "error" : "ready");
    }
  }, [
    appId,
    redirectUri,
    state,
    appInfo?.name,
    getToken,
    mobileRequest,
    signOut,
  ]);

  useEffect(() => {
    if (!mobileRequest || status !== "ready" || authLoading) return;
    if (!isAuthenticated) {
      window.location.assign(
        buildAppAuthorizeLoginHref(window.location.search),
      );
      return;
    }
    if (mobileAuthorizationStarted.current) return;
    mobileAuthorizationStarted.current = true;
    void handleAuthorize();
  }, [authLoading, handleAuthorize, isAuthenticated, mobileRequest, status]);

  const handleCancel = useCallback(() => {
    // Fail closed on an untrusted hand-off target: stay on our own origin
    // rather than navigating to a scriptable or slash-less scheme.
    if (!redirectUri || !isSafeAppAuthorizeRedirectUri(redirectUri)) {
      router.push("/");
      return;
    }
    window.location.assign(
      buildAppAuthorizeCancelRedirect({
        redirectUri: mobileRequest ? MOBILE_APP_CALLBACK_URI : redirectUri,
        state,
      }),
    );
  }, [mobileRequest, redirectUri, state, router]);

  // Render.

  if (status === "validating" || authLoading) {
    return (
      <Frame>
        <Loader2 className="size-12 animate-spin text-muted" />
        <h3 className="text-lg font-semibold text-white">
          Verifying application…
        </h3>
      </Frame>
    );
  }

  if (status === "error" && !appInfo) {
    return (
      <AuthorizationErrorFrame error={error} onHome={() => router.push("/")} />
    );
  }

  // The earlier returns guarantee appInfo is set from here on (status is
  // either "ready", "authorizing", or "error"-with-appInfo-loaded).
  if (!appInfo) return null;

  if (status === "error" && mobileRequest) {
    return (
      <AuthorizationErrorFrame
        actionLabel="Return to Eliza"
        error={error}
        onHome={handleCancel}
      />
    );
  }

  if (status === "authorizing") {
    return (
      <Frame>
        <Loader2 className="size-12 animate-spin text-muted" />
        <h3 className="text-lg font-semibold text-white">
          {mobileRequest ? "Returning to Eliza…" : "Authorizing…"}
        </h3>
        <p className="text-sm text-white/60">
          Redirecting you back to {appInfo.name}
        </p>
      </Frame>
    );
  }

  if (mobileRequest) {
    return (
      <Frame>
        <Loader2 className="size-12 animate-spin text-muted" />
        <h3 className="text-lg font-semibold text-white">Finishing sign-in…</h3>
      </Frame>
    );
  }

  return (
    <Frame>
      <AppHeader appInfo={appInfo} />
      <p className="max-w-sm text-center text-sm text-white/60">
        Connect {appInfo.name} to your Eliza Cloud account. AI features may use
        your cloud credit balance.
      </p>

      {error && <Alert variant="dashboardError">{error}</Alert>}

      {isAuthenticated ? (
        <SignedInActions
          appName={appInfo.name}
          onAuthorize={handleAuthorize}
          onCancel={handleCancel}
        />
      ) : (
        <SignedOutActions
          activeTenantId={activeTenantId}
          onCancel={handleCancel}
          providers={providers}
          providersReady={providersReady}
          signInWithOAuth={signInWithOAuth}
        />
      )}
    </Frame>
  );
}

// Presentational helpers kept local to this file.

function AuthorizationErrorFrame({
  actionLabel = "Go to Eliza Cloud",
  error,
  onHome,
}: {
  actionLabel?: string;
  error: string | null;
  onHome: () => void;
}) {
  return (
    <Frame>
      <Card
        surface="destructiveSubtle"
        radius="full"
        padding="comfortable"
        className="flex size-16 items-center justify-center"
      >
        <AlertTriangle className="size-8 text-destructive" />
      </Card>
      <h3 className="text-lg font-semibold text-white">Authorization Error</h3>
      <p className="text-sm text-white/60 max-w-xs text-center">{error}</p>
      <Button variant="outline" onClick={onHome} className="mt-4">
        {actionLabel}
      </Button>
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
    <div className="relative flex min-h-dvh w-full flex-col overflow-hidden">
      <Card
        surface="card"
        radius="none"
        className="theme-cloud absolute inset-0"
        aria-hidden
      />
      <div className="relative z-10 flex flex-1 items-center justify-center p-4">
        <Card variant="brand" className="w-full max-w-md">
          <CornerBrackets size="md" className="opacity-50" />
          <div className="relative z-10 flex flex-col items-center gap-6 py-8 px-2">
            {children}
          </div>
        </Card>
      </div>
    </div>
  );
}

function AppHeader({ appInfo }: { appInfo: AppInfo }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      {appInfo.logo_url ? (
        <Avatar shape="square" className="size-16">
          <AvatarImage asChild>
            <Image
              src={appInfo.logo_url}
              alt={appInfo.name}
              width={64}
              height={64}
              className="object-cover"
              unoptimized
            />
          </AvatarImage>
        </Avatar>
      ) : (
        <Avatar shape="square" className="size-16">
          <AvatarFallback shape="square" tone="muted">
            <span className="text-2xl font-bold text-txt-strong">
              {appInfo.name.charAt(0)}
            </span>
          </AvatarFallback>
        </Avatar>
      )}
      <div>
        <h1 className="text-xl font-bold text-white">{appInfo.name}</h1>
        {appInfo.website_url && (
          <p className="text-sm text-white/50 mt-1">
            {new URL(appInfo.website_url).hostname}
          </p>
        )}
      </div>
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
    <div className="flex w-full flex-col items-center gap-3">
      <Button onClick={onAuthorize} className="w-full">
        Authorize {appName}
      </Button>
      <InlineCancelButton onCancel={onCancel} />
    </div>
  );
}

function SignedOutActions({
  activeTenantId,
  onCancel,
  providers,
  providersReady,
  signInWithOAuth,
}: {
  activeTenantId: string | null;
  onCancel: () => void;
  providers: StewardProviders | null;
  providersReady: boolean;
  signInWithOAuth: AppAuthorizeOAuthSignIn;
}) {
  const [oauthLoadingProvider, setOauthLoadingProvider] =
    useState<AppAuthorizeOAuthProvider | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const enabledOAuthProviders = APP_AUTHORIZE_OAUTH_PROVIDERS.filter(
    ({ id }) => providers?.[id] ?? false,
  );
  const showPasskey = providers?.passkey ?? true;
  const showEmail = providers?.email ?? true;

  const handleOAuth = useCallback(
    async (provider: AppAuthorizeOAuthProvider) => {
      if (typeof window === "undefined") return;

      setOauthLoadingProvider(provider);
      setOauthError(null);

      try {
        const redirectUri = buildStewardOAuthRedirectUri(
          window.location.origin,
        );
        await signInWithOAuth(provider, {
          redirectUri,
          tenantId: resolveStewardOAuthTenantId(activeTenantId),
        });
      } catch (err) {
        setOauthError(
          err instanceof Error ? err.message : "Unable to start OAuth sign-in.",
        );
      } finally {
        setOauthLoadingProvider(null);
      }
    },
    [activeTenantId, signInWithOAuth],
  );

  return (
    <div className="flex w-full flex-col items-center gap-4">
      {providersReady ? (
        <>
          <StewardLogin
            variant="inline"
            showPasskey={showPasskey}
            showEmail={showEmail}
            showGoogle={false}
            showDiscord={false}
            title="Sign in to authorize"
          />
          {enabledOAuthProviders.length > 0 && (showPasskey || showEmail) && (
            <div className="stwd-login__divider">
              <span>or</span>
            </div>
          )}
          {enabledOAuthProviders.length > 0 && (
            <div className="stwd-login__oauth">
              {enabledOAuthProviders.map(
                ({ id, label, buttonClassName, spinnerClassName, Icon }) => (
                  <Button
                    variant="ghost"
                    className={`stwd-login__btn ${buttonClassName}`}
                    disabled={oauthLoadingProvider !== null}
                    key={id}
                    onClick={() => void handleOAuth(id)}
                    type="button"
                  >
                    {oauthLoadingProvider === id ? (
                      <span
                        className={`stwd-login__spinner ${spinnerClassName}`.trim()}
                      />
                    ) : (
                      <Icon size={18} />
                    )}
                    <span>{label}</span>
                  </Button>
                ),
              )}
            </div>
          )}
          {oauthError && (
            <p className="stwd-login__error" role="alert">
              {oauthError}
            </p>
          )}
        </>
      ) : (
        <div className="flex flex-col items-center gap-3 py-6">
          <Loader2 className="size-6 animate-spin text-muted" />
          <p className="text-sm text-white/60">Loading sign-in options…</p>
        </div>
      )}
      <InlineCancelButton onCancel={onCancel} />
    </div>
  );
}

function InlineCancelButton({ onCancel }: { onCancel: () => void }) {
  return (
    <Button variant="ghostMuted" size="touch" type="button" onClick={onCancel}>
      Cancel
    </Button>
  );
}
