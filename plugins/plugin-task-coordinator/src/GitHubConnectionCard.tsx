// Renders GitHub auth state for coding-agent framework settings.
import { Button, client, openExternalUrl, SettingsControls } from "@elizaos/ui";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  GitPullRequest,
  Loader2,
  Unplug,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * GitHub connection card for the Coding Agents settings page.
 *
 * Two guided paths to a credential (#15796):
 *   1. **Sign in with GitHub** — the OAuth device flow. The card starts a
 *      server-side flow (`POST /api/github/device-login/start`), shows the
 *      short user code + verification link, and polls
 *      `GET /api/github/device-login/:flowId/status` at the server-directed
 *      cadence until GitHub reports approval. GitHub's `device_code` and the
 *      issued token never reach the browser. Shown only when the server
 *      reports `deviceFlowAvailable` (a GITHUB_OAUTH_CLIENT_ID is configured).
 *   2. **Paste a PAT** — the always-available fallback, validated server-side
 *      against GitHub `/user` before being persisted.
 *
 * Either way the server persists the token to the on-disk credential store
 * AND the per-agent character secrets, so spawned coding sub-agents (the
 * orchestrator's `runtime.getSetting("GITHUB_TOKEN")` resolution) see it
 * without a restart. The token is write-only from the UI side: the API never
 * returns it after save. State here is the connection metadata (username,
 * scopes, savedAt), the device-flow state machine, and an in-memory draft
 * input while the user types a new PAT.
 */

interface TokenStatus {
  connected: boolean;
  deviceFlowAvailable?: boolean;
  username?: string;
  scopes?: string[];
  savedAt?: number;
}

interface DeviceLoginStart {
  flowId: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

type DeviceLoginStatus =
  | { status: "pending"; retryAfterSeconds: number }
  | ({ status: "complete" } & TokenStatus);

const TOKEN_GENERATE_URL =
  "https://github.com/settings/tokens/new?description=eliza-coding-agents&scopes=repo,read:user";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string };

type DeviceFlowState =
  | { kind: "idle" }
  | { kind: "starting" }
  | {
      kind: "waiting";
      flowId: string;
      userCode: string;
      verificationUri: string;
    }
  | { kind: "error"; message: string };

export function GitHubConnectionCard() {
  const [status, setStatus] = useState<TokenStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowState>({
    kind: "idle",
  });
  const [codeCopied, setCodeCopied] = useState(false);
  // The active flow's poll timer + a generation counter so a cancelled or
  // superseded flow's in-flight response can never clobber newer state.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flowGenerationRef = useRef(0);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await client.fetch<TokenStatus>("/api/github/token");
      setStatus(next);
      setStatusError(null);
    } catch (err) {
      // error-policy:J4 designed error state — the card renders a visible
      // load-failure row instead of a healthy-looking "not connected".
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const stopPolling = useCallback(() => {
    flowGenerationRef.current += 1;
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const pollDeviceFlow = useCallback(
    (flowId: string, delaySeconds: number, generation: number) => {
      pollTimerRef.current = setTimeout(async () => {
        if (generation !== flowGenerationRef.current) return;
        try {
          const result = await client.fetch<DeviceLoginStatus>(
            `/api/github/device-login/${encodeURIComponent(flowId)}/status`,
          );
          if (generation !== flowGenerationRef.current) return;
          if (result.status === "pending") {
            pollDeviceFlow(flowId, result.retryAfterSeconds, generation);
            return;
          }
          const { status: _status, ...connection } = result;
          setStatus(connection);
          setDeviceFlow({ kind: "idle" });
        } catch (err) {
          if (generation !== flowGenerationRef.current) return;
          // error-policy:J4 designed error state — declined / expired /
          // upstream failures all end the flow visibly with the server's
          // human-readable reason and a retry affordance.
          setDeviceFlow({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }, delaySeconds * 1000);
    },
    [],
  );

  const handleDeviceSignIn = useCallback(async () => {
    stopPolling();
    const generation = flowGenerationRef.current;
    setDeviceFlow({ kind: "starting" });
    setCodeCopied(false);
    try {
      const started = await client.fetch<DeviceLoginStart>(
        "/api/github/device-login/start",
        { method: "POST" },
      );
      if (generation !== flowGenerationRef.current) return;
      setDeviceFlow({
        kind: "waiting",
        flowId: started.flowId,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
      });
      pollDeviceFlow(started.flowId, started.intervalSeconds, generation);
    } catch (err) {
      if (generation !== flowGenerationRef.current) return;
      setDeviceFlow({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [pollDeviceFlow, stopPolling]);

  const handleDeviceCancel = useCallback(() => {
    stopPolling();
    setDeviceFlow({ kind: "idle" });
  }, [stopPolling]);

  const handleCopyCode = useCallback(async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCodeCopied(true);
    } catch {
      // error-policy:J4 designed degrade — clipboard access can be denied by
      // the browser; the code stays visible on screen to type by hand, so the
      // copy affordance simply not confirming is the designed fallback.
      setCodeCopied(false);
    }
  }, []);

  const handleConnect = useCallback(async () => {
    const token = draft.trim();
    if (token.length === 0) return;
    setSubmitState({ kind: "submitting" });
    try {
      const res = await client.fetch<TokenStatus | { error: string }>(
        "/api/github/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        },
      );
      if ("error" in res) {
        setSubmitState({ kind: "error", message: res.error });
        return;
      }
      setStatus(res);
      setDraft("");
      setSubmitState({ kind: "idle" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSubmitState({ kind: "error", message });
    }
  }, [draft]);

  const handleDisconnect = useCallback(async () => {
    setSubmitState({ kind: "submitting" });
    try {
      const next = await client.fetch<TokenStatus>("/api/github/token", {
        method: "DELETE",
      });
      setStatus(next);
      setSubmitState({ kind: "idle" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSubmitState({ kind: "error", message });
    }
  }, []);

  const submitting = submitState.kind === "submitting";
  const errorMessage =
    submitState.kind === "error" ? submitState.message : null;
  const deviceBusy =
    deviceFlow.kind === "starting" || deviceFlow.kind === "waiting";

  return (
    <div className="space-y-3 px-1 py-1">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <GitPullRequest className="h-4 w-4 text-muted" aria-hidden />
          <span className="text-sm font-medium text-txt">GitHub</span>
          {status?.connected ? (
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500"
              title={`Connected as @${status.username}`}
              aria-label={`Connected as @${status.username}`}
              role="img"
            />
          ) : (
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-muted/40"
              title="Not connected"
              aria-label="Not connected"
              role="img"
            />
          )}
        </div>
      </div>

      {statusError ? (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-500">
          Could not load GitHub connection status: {statusError}
        </div>
      ) : status === null ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          <span>Loading connection status…</span>
        </div>
      ) : status.connected ? (
        <div className="flex flex-col gap-2 text-xs">
          <div className="flex items-center gap-2 text-muted">
            <CheckCircle2
              className="h-3.5 w-3.5 text-emerald-500"
              aria-hidden
            />
            <span>
              Connected as{" "}
              <span className="font-medium text-txt">@{status.username}</span>
            </span>
          </div>
          {status.scopes && status.scopes.length > 0 ? (
            <div className="text-muted">
              Scopes:{" "}
              <span className="font-mono text-txt">
                {status.scopes.join(", ")}
              </span>
            </div>
          ) : (
            <div className="text-muted">
              Scopes: <span className="text-amber-500">none</span>
            </div>
          )}
          <div className="flex items-center justify-between pt-1">
            <span className="sr-only">
              Coding sub-agents will use this token for git/gh operations.
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleDisconnect}
              disabled={submitting}
            >
              <Unplug className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-xs">
          {status.deviceFlowAvailable ? (
            deviceFlow.kind === "waiting" ? (
              <div
                className="flex flex-col gap-2 rounded-md border border-border bg-muted/10 p-2.5"
                data-testid="github-device-waiting"
              >
                <span className="text-muted">
                  Enter this code on github.com to sign in:
                </span>
                <div className="flex items-center gap-2">
                  <span className="rounded bg-muted/20 px-2 py-1 font-mono text-base font-semibold tracking-widest text-txt">
                    {deviceFlow.userCode}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleCopyCode(deviceFlow.userCode)}
                    aria-label="Copy code"
                  >
                    <Copy className="mr-1 h-3 w-3" aria-hidden />
                    {codeCopied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <Button
                  unstyled
                  type="button"
                  className="inline-flex w-fit items-center gap-1 text-xs text-accent hover:underline"
                  onClick={() => openExternalUrl(deviceFlow.verificationUri)}
                >
                  <ExternalLink className="h-3 w-3" aria-hidden />
                  Open {deviceFlow.verificationUri}
                </Button>
                <div className="flex items-center gap-2 text-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  <span>Waiting for approval on github.com…</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleDeviceCancel}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Button
                  variant="default"
                  size="sm"
                  className="w-fit"
                  onClick={() => void handleDeviceSignIn()}
                  disabled={deviceFlow.kind === "starting"}
                >
                  {deviceFlow.kind === "starting" ? (
                    <>
                      <Loader2
                        className="mr-1.5 h-3.5 w-3.5 animate-spin"
                        aria-hidden
                      />
                      Contacting GitHub…
                    </>
                  ) : (
                    "Sign in with GitHub"
                  )}
                </Button>
                {deviceFlow.kind === "error" ? (
                  <div
                    className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-rose-500"
                    data-testid="github-device-error"
                  >
                    {deviceFlow.message}
                  </div>
                ) : null}
                <span className="text-muted">
                  Or paste a personal access token:
                </span>
              </div>
            )
          ) : null}
          {deviceFlow.kind !== "waiting" ? (
            <>
              <p className="sr-only">
                Paste a personal access token so coding sub-agents can clone
                private repos, push commits, and open pull requests.
              </p>
              <Button
                unstyled
                type="button"
                className="inline-flex w-fit items-center gap-1 text-xs text-accent hover:underline"
                onClick={() => openExternalUrl(TOKEN_GENERATE_URL)}
              >
                <ExternalLink className="h-3 w-3" aria-hidden />
                Generate a token on github.com (scopes: repo, read:user)
              </Button>
              <div className="flex items-center gap-2">
                <SettingsControls.Input
                  className="w-full"
                  variant="compact"
                  type="password"
                  placeholder="ghp_…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleConnect();
                  }}
                  autoComplete="off"
                />
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => void handleConnect()}
                  disabled={
                    submitting || deviceBusy || draft.trim().length === 0
                  }
                >
                  {submitting ? "Connecting…" : "Connect"}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      )}

      {errorMessage ? (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-500">
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}
