/**
 * CLI / device login page (public). After the Steward session resolves, POSTs
 * to /api/auth/cli-session/:id/complete to mint an API key for the waiting CLI
 * / Remote device pairing, then posts a completion message to the opener.
 * Ported from `@elizaos/cloud-frontend/src/pages/auth/cli-login/page.tsx`.
 */

import {
  AlertCircle,
  CheckCircle2,
  Key,
  Loader2,
  Terminal,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../../../../components/primitives";
import { ApiError, apiFetch } from "../../../lib/api-client";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { clearStaleStewardSession } from "../../../shell/StewardProvider";
import { getErrorMessage } from "../../lib/error-message";
import { usePageTitle } from "../../lib/use-page-title";
import { useSessionAuth } from "../../lib/use-session-auth";

type TFn = ReturnType<typeof useCloudT>;

const COMPLETE_TIMEOUT_MS = 30_000;

type CompletionState =
  | { status: "idle" }
  | { status: "completing" }
  | { status: "success"; apiKeyPrefix: string }
  | { status: "error"; errorMessage: string };

type PageState =
  | { status: "initializing" }
  | { status: "loading" }
  | { status: "waiting_auth" }
  | { status: "completing" }
  | { status: "success"; apiKeyPrefix: string }
  | { status: "error"; errorMessage: string };

type PanelTone = "accent" | "danger" | "success";

const PANEL_TONE_CLASSES: Record<
  PanelTone,
  { container: string; icon: string }
> = {
  accent: {
    container: "bg-[var(--brand-orange)]/10",
    icon: "text-[var(--brand-orange)]",
  },
  danger: { container: "bg-red-500/10", icon: "text-red-500" },
  success: { container: "bg-green-500/10", icon: "text-green-500" },
};

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

function getUserEmail(user: unknown): string | undefined {
  if (!user || typeof user !== "object" || !("email" in user)) return undefined;
  const { email } = user as { email?: unknown };
  return typeof email === "string" ? email : undefined;
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
    <div className="flex min-h-screen items-center justify-center bg-black p-4">
      <div className="absolute inset-0 bg-black" />
      <div className="relative w-full max-w-md bg-black border border-white/14 p-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <div
            className={`flex h-14 w-14 items-center justify-center ${toneClasses.container}`}
          >
            <Icon
              className={`h-7 w-7 ${toneClasses.icon} ${iconClassName ?? ""}`}
            />
          </div>
          <div className="space-y-1">
            <h2 className="text-xl font-semibold text-white">{title}</h2>
            <div className="text-sm text-neutral-500">{description}</div>
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
  const { authenticated, ready, user } = useSessionAuth();
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session");
  const [completion, setCompletion] = useState<CompletionState>({
    status: "idle",
  });
  const lastSessionId = useRef(sessionId);
  const completionFiredRef = useRef(false);

  usePageTitle(
    t("cloud.cliLogin.metaTitle", {
      defaultValue: "CLI Authentication | Eliza Cloud",
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
          "*",
        );
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
  }, [authenticated, ready, sessionId, t]);

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
  const userEmail = getUserEmail(user);

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
          <>
            {sessionId ? (
              <a href={signInHref} className="w-full">
                <Button className="w-full h-11 bg-[var(--brand-orange)] hover:bg-[#e54f00] text-white">
                  {t("cloud.cliLogin.signInAgain", {
                    defaultValue: "Sign In Again",
                  })}
                </Button>
              </a>
            ) : null}
            <Button
              onClick={() => window.close()}
              variant="outline"
              className="w-full mt-2 border-white/14 hover:bg-white/10"
            >
              {t("cloud.cliLogin.closeWindow", {
                defaultValue: "Close Window",
              })}
            </Button>
          </>
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
    return (
      <CliLoginPanel
        actions={
          <a href={signInHref} className="w-full">
            <Button
              className="w-full h-11 bg-[var(--brand-orange)] hover:bg-[#e54f00] text-white"
              disabled={!ready}
            >
              {!ready ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  {t("cloud.cliLogin.loading", { defaultValue: "Loading..." })}
                </>
              ) : (
                t("cloud.cliLogin.signIn", { defaultValue: "Sign In" })
              )}
            </Button>
          </a>
        }
        description={t("cloud.cliLogin.waitingAuthDescription", {
          defaultValue:
            "Sign in to connect your Eliza app or CLI to Eliza Cloud",
        })}
        icon={Terminal}
        title={t("cloud.cliLogin.cliAuthentication", {
          defaultValue: "CLI Authentication",
        })}
        tone="accent"
      />
    );
  }

  if (pageState.status === "completing") {
    return (
      <CliLoginPanel
        description={t("cloud.cliLogin.completingDescription", {
          defaultValue: "Creating your credentials for CLI access...",
        })}
        icon={Key}
        iconClassName="animate-pulse"
        title={t("cloud.cliLogin.generatingApiKey", {
          defaultValue: "Generating API Key",
        })}
        tone="accent"
      >
        <div className="flex gap-1.5 mt-2">
          <div className="h-2 w-2 animate-bounce rounded-full bg-[var(--brand-orange)] [animation-delay:-0.3s]" />
          <div className="h-2 w-2 animate-bounce rounded-full bg-[var(--brand-orange)] [animation-delay:-0.15s]" />
          <div className="h-2 w-2 animate-bounce rounded-full bg-[var(--brand-orange)]" />
        </div>
      </CliLoginPanel>
    );
  }

  if (pageState.status === "success") {
    return (
      <CliLoginPanel
        actions={
          <Button
            onClick={() => window.close()}
            variant="outline"
            className="w-full border-white/14 hover:bg-white/10"
          >
            {t("cloud.cliLogin.closeWindow", { defaultValue: "Close Window" })}
          </Button>
        }
        description={t("cloud.cliLogin.successDescription", {
          defaultValue: "Your API key has been generated and sent to the CLI",
        })}
        icon={CheckCircle2}
        title={t("cloud.cliLogin.authComplete", {
          defaultValue: "Authentication Complete!",
        })}
        tone="success"
      >
        <div className="w-full bg-black/40 border border-white/14 p-4 space-y-3">
          <p className="text-xs font-medium text-neutral-400">
            {t("cloud.cliLogin.apiKeyDetails", {
              defaultValue: "API Key Details",
            })}
          </p>
          <div className="text-sm space-y-2">
            <div className="flex justify-between">
              <span className="text-neutral-500">
                {t("cloud.cliLogin.prefix", { defaultValue: "Prefix" })}
              </span>
              <span className="font-mono text-white">
                {pageState.apiKeyPrefix}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">
                {t("cloud.cliLogin.createdFor", {
                  defaultValue: "Created for",
                })}
              </span>
              <span className="text-white">
                {userEmail ||
                  t("cloud.cliLogin.yourAccount", {
                    defaultValue: "Your account",
                  })}
              </span>
            </div>
          </div>
        </div>

        <div className="w-full border border-green-500/20 bg-green-500/5 p-4">
          <p className="text-sm text-green-400 flex items-center justify-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            {t("cloud.cliLogin.returnToTerminal", {
              defaultValue:
                "You can now close this window and return to your terminal",
            })}
          </p>
        </div>
      </CliLoginPanel>
    );
  }

  return null;
}
