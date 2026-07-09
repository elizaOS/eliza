/**
 * CLI / device login page (public). After the Steward session resolves, POSTs
 * to /api/auth/cli-session/:id/complete to mint an API key for the waiting CLI
 * / Remote device pairing, then posts a completion message to the opener.
 */

import { AlertCircle, CheckCircle2, Key, Loader2 } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../../../../components/primitives";
import { ApiError, apiFetch } from "../../../lib/api-client";
import { useSessionAuth } from "../../../lib/use-session-auth";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { clearStaleStewardSession } from "../../../shell/StewardProvider";
import { getErrorMessage } from "../../lib/error-message";
import { usePageTitle } from "../../lib/use-page-title";

type TFn = ReturnType<typeof useCloudT>;

const COMPLETE_TIMEOUT_MS = 30_000;

type CompletionState =
  | { status: "idle" }
  | { status: "completing" }
  | { status: "redirecting" }
  | { status: "success"; apiKeyPrefix: string }
  | { status: "error"; errorMessage: string };

type PageState =
  | { status: "initializing" }
  | { status: "loading" }
  | { status: "waiting_auth" }
  | { status: "completing" }
  | { status: "redirecting" }
  | { status: "success"; apiKeyPrefix: string }
  | { status: "error"; errorMessage: string };

type PanelTone = "accent" | "danger" | "success";

const PANEL_TONE_CLASSES: Record<
  PanelTone,
  { container: string; icon: string }
> = {
  accent: {
    container: "bg-accent-subtle",
    icon: "text-accent",
  },
  danger: { container: "bg-destructive-subtle", icon: "text-destructive" },
  success: { container: "bg-status-success-bg", icon: "text-status-success" },
};

function isAllowedCliReturnHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "elizacloud.ai" ||
    host === "www.elizacloud.ai" ||
    host === "staging.elizacloud.ai" ||
    host === "app.elizacloud.ai" ||
    host === "app-staging.elizacloud.ai"
  );
}

function sanitizeCliLoginReturnTo(value: string | null): string | null {
  if (!value?.trim()) return null;
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isAllowedCliReturnHost(url.hostname)) return null;
    return url.toString();
  } catch (error) {
    void error;
    return null;
  }
}

function resolveCliLoginMessageTargetOrigin(returnTo: string | null): string {
  if (typeof window === "undefined") return "https://elizacloud.ai";
  if (!returnTo) return window.location.origin;
  return new URL(returnTo).origin;
}

function getPageState({
  authenticated,
  completion,
  ready,
  sessionId,
  t,
}: {
  authenticated: boolean;
  completion: CompletionState;
  ready: boolean;
  sessionId: string | null;
  t: TFn;
}): PageState {
  if (!sessionId) {
    return {
      status: "error",
      errorMessage: t("cloud.cliLogin.invalidLink", {
        defaultValue: "Invalid authentication link. Missing session ID.",
      }),
    };
  }
  if (completion.status !== "idle") return completion;
  if (!ready) return { status: "initializing" };
  if (!authenticated) return { status: "waiting_auth" };
  return { status: "loading" };
}

function CliLoginPanel({
  actions,
  children,
  description,
  icon: Icon,
  iconClassName,
  title,
  tone,
}: {
  actions?: ReactNode;
  children?: ReactNode;
  description: ReactNode;
  icon: ComponentType<{ className?: string }>;
  iconClassName?: string;
  title: string;
  tone: PanelTone;
}) {
  const toneClasses = PANEL_TONE_CLASSES[tone];
  return (
    // Scroll — never clip — when the panel is taller than the viewport. A flex
    // `justify-center` pins the card's center and pushes its top above
    // scrollTop 0 where it can't be reached; `overflow-y-auto` + the card's
    // `my-auto` centers when it fits and scrolls-from-top when it overflows.
    // Regressed on short screens (Light Phone III, 1080×1240) where the action
    // buttons fell below an unscrollable fold — see cli-login-page.test.tsx.
    <div className="theme-cloud relative flex min-h-[100dvh] flex-col items-center overflow-y-auto bg-bg p-4">
      <div className="relative my-auto w-full max-w-md bg-card border border-border p-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <div
            className={`flex h-14 w-14 items-center justify-center ${toneClasses.container}`}
          >
            <Icon
              className={`h-7 w-7 ${toneClasses.icon} ${iconClassName ?? ""}`}
            />
          </div>
          <div className="space-y-1">
            <h2 className="text-xl font-semibold text-txt">{title}</h2>
            <div className="text-sm text-muted">{description}</div>
          </div>
          {children}
          {actions ? <div className="w-full space-y-2">{actions}</div> : null}
        </div>
      </div>
    </div>
  );
}

export default function CliLoginPage() {
  const t = useCloudT();
  const { authenticated, ready } = useSessionAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const sessionId = searchParams.get("session");
  const launchReturnTo = sanitizeCliLoginReturnTo(searchParams.get("returnTo"));
  const [completion, setCompletion] = useState<CompletionState>({
    status: "idle",
  });
  const lastSessionId = useRef(sessionId);
  const completionFiredRef = useRef(false);

  usePageTitle(
    t("cloud.cliLogin.metaTitle", {
      defaultValue: "Sign in | Eliza Cloud",
    }),
  );

  useEffect(() => {
    if (lastSessionId.current === sessionId) return;
    lastSessionId.current = sessionId;
    completionFiredRef.current = false;
    setCompletion({ status: "idle" });
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !ready || !authenticated) return;
    if (completionFiredRef.current) return;
    completionFiredRef.current = true;

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), COMPLETE_TIMEOUT_MS);

    async function completeCliLogin() {
      setCompletion({ status: "completing" });
      try {
        const response = await apiFetch(
          `/api/auth/cli-session/${sessionId}/complete`,
          { method: "POST", json: {}, signal: abort.signal },
        );
        const data = (await response.json()) as { keyPrefix: string };
        window.opener?.postMessage(
          { type: "eliza-cloud-auth-complete", sessionId },
          resolveCliLoginMessageTargetOrigin(launchReturnTo),
        );
        if (launchReturnTo) {
          setCompletion({ status: "redirecting" });
          try {
            window.close();
          } catch (error) {
            void error;
            // Some browsers reject script-close for normal tabs; redirect below
            // still lands the user back in the app that started sign-in.
          }
          window.location.replace(launchReturnTo);
          return;
        }
        setCompletion({ status: "success", apiKeyPrefix: data.keyPrefix });
      } catch (error) {
        const aborted =
          error instanceof DOMException && error.name === "AbortError";
        if (error instanceof ApiError && error.status === 401) {
          clearStaleStewardSession();
        }
        setCompletion({
          status: "error",
          errorMessage: aborted
            ? t("cloud.cliLogin.timeout", {
                defaultValue:
                  "The cloud took too long to respond. Please try again.",
              })
            : error instanceof ApiError
              ? error.message
              : getErrorMessage(
                  error,
                  t("cloud.cliLogin.networkError", {
                    defaultValue: "Network error. Please try again.",
                  }),
                ),
        });
      }
    }

    void completeCliLogin();

    return () => {
      clearTimeout(timeout);
      if (!completionFiredRef.current) abort.abort();
    };
  }, [authenticated, launchReturnTo, ready, sessionId, t]);

  const pageState = getPageState({
    authenticated,
    completion,
    ready,
    sessionId,
    t,
  });
  const returnToQuery = searchParams.toString();
  const returnTo = `/auth/cli-login${returnToQuery ? `?${returnToQuery}` : ""}`;
  const signInHref = `/login?returnTo=${encodeURIComponent(returnTo)}`;

  // No "CLI Authentication" interstitial: when the user isn't signed in yet,
  // forward straight to the Steward login. `returnTo` brings the browser back
  // here once authenticated, where the session auto-completes. Guarded per
  // session via sessionStorage so a login page that bounces back without
  // establishing a session falls back to a manual button instead of looping.
  const autoSignInKey = sessionId
    ? `eliza-cloud-cli-login-autosignin:${sessionId}`
    : null;
  const autoSignInTried =
    autoSignInKey !== null &&
    typeof sessionStorage !== "undefined" &&
    sessionStorage.getItem(autoSignInKey) === "1";

  useEffect(() => {
    if (
      pageState.status !== "waiting_auth" ||
      !autoSignInKey ||
      autoSignInTried
    ) {
      return;
    }
    try {
      sessionStorage.setItem(autoSignInKey, "1");
    } catch (error) {
      void error;
      // sessionStorage unavailable — fall through to the manual sign-in button.
    }
    navigate(signInHref, { replace: true });
  }, [pageState.status, autoSignInKey, autoSignInTried, signInHref, navigate]);

  if (pageState.status === "initializing" || pageState.status === "loading") {
    return (
      <CliLoginPanel
        description={
          pageState.status === "initializing"
            ? t("cloud.cliLogin.initializing", {
                defaultValue: "Initializing authentication",
              })
            : t("cloud.cliLogin.preparing", {
                defaultValue: "Preparing authentication",
              })
        }
        icon={Loader2}
        iconClassName="animate-spin"
        title={t("cloud.cliLogin.loading", { defaultValue: "Loading..." })}
        tone="accent"
      />
    );
  }

  if (pageState.status === "error") {
    return (
      <CliLoginPanel
        actions={
          sessionId ? (
            <a href={signInHref} className="w-full">
              <Button className="w-full h-11 bg-accent hover:bg-accent-hover text-accent-foreground">
                {t("cloud.cliLogin.signInAgain", {
                  defaultValue: "Sign In Again",
                })}
              </Button>
            </a>
          ) : null
        }
        description={pageState.errorMessage}
        icon={AlertCircle}
        title={t("cloud.cliLogin.authError", {
          defaultValue: "Authentication Error",
        })}
        tone="danger"
      />
    );
  }

  if (pageState.status === "waiting_auth") {
    // Happy path: the effect above is forwarding to /login — render a neutral
    // "redirecting" state, never the CLI interstitial. Only if the login page
    // bounced back here still unauthenticated (guard already set) do we show a
    // manual sign-in button as a non-looping fallback.
    if (!autoSignInTried) {
      return (
        <CliLoginPanel
          description={t("cloud.cliLogin.redirecting", {
            defaultValue: "Taking you to sign in…",
          })}
          icon={Loader2}
          iconClassName="animate-spin"
          title={t("cloud.cliLogin.redirectingTitle", {
            defaultValue: "Signing in",
          })}
          tone="accent"
        />
      );
    }
    return (
      <CliLoginPanel
        actions={
          <Button
            asChild
            className="w-full h-11 bg-accent hover:bg-accent-hover text-accent-foreground"
          >
            <a href={signInHref}>
              {t("cloud.cliLogin.signIn", { defaultValue: "Sign In" })}
            </a>
          </Button>
        }
        description={t("cloud.cliLogin.waitingAuthDescription", {
          defaultValue: "Sign in to connect your Eliza app to Eliza Cloud",
        })}
        icon={Key}
        title={t("cloud.cliLogin.cliAuthentication", {
          defaultValue: "Sign in to Eliza Cloud",
        })}
        tone="accent"
      />
    );
  }

  if (pageState.status === "completing" || pageState.status === "redirecting") {
    return (
      <CliLoginPanel
        description={
          pageState.status === "redirecting"
            ? t("cloud.cliLogin.returningDescription", {
                defaultValue: "Returning to your app…",
              })
            : t("cloud.cliLogin.completingDescription", {
                defaultValue: "Finishing sign-in…",
              })
        }
        icon={Key}
        iconClassName="animate-pulse"
        title={
          pageState.status === "redirecting"
            ? t("cloud.cliLogin.returningTitle", {
                defaultValue: "Returning to app",
              })
            : t("cloud.cliLogin.generatingApiKey", {
                defaultValue: "Generating API Key",
              })
        }
        tone="accent"
      >
        <div className="flex gap-1.5 mt-2">
          <div className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:-0.3s] motion-reduce:animate-none" />
          <div className="h-2 w-2 animate-bounce rounded-full bg-accent [animation-delay:-0.15s] motion-reduce:animate-none" />
          <div className="h-2 w-2 animate-bounce rounded-full bg-accent motion-reduce:animate-none" />
        </div>
      </CliLoginPanel>
    );
  }

  if (pageState.status === "success") {
    return (
      <CliLoginPanel
        actions={
          <Button
            className="w-full h-11 bg-accent hover:bg-accent-hover text-accent-foreground"
            onClick={() => window.close()}
          >
            {t("cloud.cliLogin.closeWindow", {
              defaultValue: "Close window",
            })}
          </Button>
        }
        description={t("cloud.cliLogin.successDescription", {
          defaultValue:
            "You're signed in. Your credentials were sent to the app you started from.",
        })}
        icon={CheckCircle2}
        title={t("cloud.cliLogin.authComplete", {
          defaultValue: "Authentication Complete!",
        })}
        tone="success"
      >
        <div className="w-full border border-status-success/20 bg-status-success-bg p-4">
          <p className="text-sm text-status-success flex items-center justify-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            {t("cloud.cliLogin.returnToApp", {
              defaultValue: "Return to your app to continue.",
            })}
          </p>
        </div>
      </CliLoginPanel>
    );
  }

  return null;
}
