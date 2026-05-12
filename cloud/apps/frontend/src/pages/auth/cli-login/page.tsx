import { Button } from "@elizaos/cloud-ui";
import { AlertCircle, CheckCircle2, Key, Loader2, Terminal } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import { clearStaleStewardSession } from "@/lib/providers/StewardProvider";
import { ApiError, apiFetch } from "../../../lib/api-client";

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

const PANEL_TONE_CLASSES: Record<PanelTone, { container: string; icon: string }> = {
  accent: {
    container: "bg-[#FF5800]/10",
    icon: "text-[#FF5800]",
  },
  danger: {
    container: "bg-red-500/10",
    icon: "text-red-500",
  },
  success: {
    container: "bg-green-500/10",
    icon: "text-green-500",
  },
};

function getPageState({
  authenticated,
  completion,
  ready,
  sessionId,
}: {
  authenticated: boolean;
  completion: CompletionState;
  ready: boolean;
  sessionId: string | null;
}): PageState {
  if (!sessionId) {
    return {
      status: "error",
      errorMessage: "Invalid authentication link. Missing session ID.",
    };
  }

  if (completion.status !== "idle") {
    return completion;
  }

  if (!ready) {
    return { status: "initializing" };
  }

  if (!authenticated) {
    return { status: "waiting_auth" };
  }

  return { status: "loading" };
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function getUserEmail(user: unknown) {
  if (!user || typeof user !== "object" || !("email" in user)) {
    return undefined;
  }

  const email = (user as { email?: unknown }).email;
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
    <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A] p-4">
      <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] via-neutral-900/50 to-[#0A0A0A]" />
      <div className="relative w-full max-w-md bg-neutral-900 border border-white/10 rounded-2xl p-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <div
            className={`flex h-14 w-14 items-center justify-center rounded-xl ${toneClasses.container}`}
          >
            <Icon className={`h-7 w-7 ${toneClasses.icon} ${iconClassName ?? ""}`} />
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

function CliLoginContent() {
  const { authenticated, ready, user } = useSessionAuth();
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session");
  const [completion, setCompletion] = useState<CompletionState>({ status: "idle" });
  const lastSessionId = useRef(sessionId);
  const completionFiredRef = useRef(false);

  useEffect(() => {
    if (lastSessionId.current === sessionId) {
      return;
    }

    lastSessionId.current = sessionId;
    completionFiredRef.current = false;
    setCompletion({ status: "idle" });
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !ready || !authenticated) {
      return;
    }
    if (completionFiredRef.current) {
      return;
    }
    completionFiredRef.current = true;

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), COMPLETE_TIMEOUT_MS);

    async function completeCliLogin() {
      setCompletion({ status: "completing" });

      try {
        // apiFetch attaches the steward Bearer token from localStorage and
        // sets credentials:"include" so the steward-token cookie reaches the
        // Worker — the cli-login page may be opened in SafariViewController,
        // where same-origin defaults aren't reliable across the Pages→Worker
        // proxy hop. apiFetch throws ApiError on non-2xx; the catch handles
        // 401 + everything else.
        const response = await apiFetch(`/api/auth/cli-session/${sessionId}/complete`, {
          method: "POST",
          json: {},
          signal: abort.signal,
        });

        const data = (await response.json()) as { keyPrefix: string };
        window.opener?.postMessage({ type: "eliza-cloud-auth-complete", sessionId }, "*");

        setCompletion({ status: "success", apiKeyPrefix: data.keyPrefix });
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        if (error instanceof ApiError && error.status === 401) {
          clearStaleStewardSession();
        }
        setCompletion({
          status: "error",
          errorMessage: aborted
            ? "The cloud took too long to respond. Please try again."
            : error instanceof ApiError
              ? error.message
              : getErrorMessage(error, "Network error. Please try again."),
        });
      }
    }

    void completeCliLogin();

    return () => {
      clearTimeout(timeout);
      if (!completionFiredRef.current) {
        abort.abort();
      }
    };
  }, [authenticated, ready, sessionId]);

  const pageState = getPageState({ authenticated, completion, ready, sessionId });
  const returnToQuery = searchParams.toString();
  const returnTo = `/auth/cli-login${returnToQuery ? `?${returnToQuery}` : ""}`;
  const signInHref = `/login?returnTo=${encodeURIComponent(returnTo)}`;
  const userEmail = getUserEmail(user);

  if (pageState.status === "initializing" || pageState.status === "loading") {
    return (
      <CliLoginPanel
        description={
          pageState.status === "initializing"
            ? "Initializing authentication"
            : "Preparing authentication"
        }
        icon={Loader2}
        iconClassName="animate-spin"
        title="Loading..."
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
                <Button className="w-full h-11 rounded-xl bg-[#FF5800] hover:bg-[#FF5800]/80 text-white">
                  Sign In Again
                </Button>
              </a>
            ) : null}
            <Button
              onClick={() => window.close()}
              variant="outline"
              className="w-full mt-2 rounded-xl border-white/10 hover:bg-white/10"
            >
              Close Window
            </Button>
          </>
        }
        description={pageState.errorMessage}
        icon={AlertCircle}
        title="Authentication Error"
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
              className="w-full h-11 rounded-xl bg-[#FF5800] hover:bg-[#FF5800]/80 text-white"
              disabled={!ready}
            >
              {!ready ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Loading...
                </>
              ) : (
                "Sign In"
              )}
            </Button>
          </a>
        }
        description="Sign in to connect your Eliza app or CLI to Eliza Cloud"
        icon={Terminal}
        title="CLI Authentication"
        tone="accent"
      />
    );
  }

  if (pageState.status === "completing") {
    return (
      <CliLoginPanel
        description="Creating your credentials for CLI access..."
        icon={Key}
        iconClassName="animate-pulse"
        title="Generating API Key"
        tone="accent"
      >
        <div className="flex gap-1.5 mt-2">
          <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800] [animation-delay:-0.3s]" />
          <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800] [animation-delay:-0.15s]" />
          <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800]" />
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
            className="w-full rounded-xl border-white/10 hover:bg-white/10"
          >
            Close Window
          </Button>
        }
        description="Your API key has been generated and sent to the CLI"
        icon={CheckCircle2}
        title="Authentication Complete!"
        tone="success"
      >
        <div className="w-full rounded-xl bg-black/40 border border-white/10 p-4 space-y-3">
          <p className="text-xs font-medium text-neutral-400">API Key Details</p>
          <div className="text-sm space-y-2">
            <div className="flex justify-between">
              <span className="text-neutral-500">Prefix</span>
              <span className="font-mono text-white">{pageState.apiKeyPrefix}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-500">Created for</span>
              <span className="text-white">{userEmail || "Your account"}</span>
            </div>
          </div>
        </div>

        <div className="w-full rounded-xl border border-green-500/20 bg-green-500/5 p-4">
          <p className="text-sm text-green-400 flex items-center justify-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            You can now close this window and return to your terminal
          </p>
        </div>
      </CliLoginPanel>
    );
  }

  return null;
}

/**
 * CLI login page for authenticating command-line tool users.
 * Uses Steward session auth (`useSessionAuth`), then generates an API key for CLI access.
 */
export default function CliLoginPage() {
  return <CliLoginContent />;
}
