// Renders GitHub auth state for coding-agent framework settings.
import { Button, client, openExternalUrl, SettingsControls } from "@elizaos/ui";
import {
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  LogIn,
  Unplug,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * GitHub connection card for the Coding Agents settings page — the guided
 * credential setup step for every GitHub-touching capability (#15796).
 *
 * Two paths to connect, matching the server routes in
 * `@elizaos/plugin-github`:
 *
 * 1. **Device sign-in** (`POST /api/github/device/start|poll`) — shown when
 *    the agent has a `GITHUB_OAUTH_CLIENT_ID` setting. The card shows the
 *    short user code, opens github.com/login/device, and polls until the
 *    user approves. The device code and the granted token never reach the
 *    browser.
 * 2. **PAT paste** (`POST /api/github/token`) — always available.
 *
 * Either way the server validates the token against GitHub `/user`, persists
 * it to `<state-dir>/credentials/github.json`, and applies it to the live
 * runtime's per-agent settings (`runtime.getSetting("GITHUB_TOKEN")`) so
 * GitHub capabilities work immediately — no restart, no process-env write.
 *
 * The token itself is write-only from the UI side: the API never returns it
 * after save. State here is just the metadata (username, scopes, savedAt)
 * plus the in-flight sign-in / draft-PAT state.
 */

interface TokenStatus {
  connected: boolean;
  deviceFlowAvailable?: boolean;
  username?: string;
  scopes?: string[];
  savedAt?: number;
}

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
    };

interface DeviceStartResponse {
  status: "started";
  flowId: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

type DevicePollResponse =
  | { status: "pending"; retryAfterSeconds: number }
  | ({ status: "complete" } & TokenStatus)
  | { status: "denied" }
  | { status: "expired" };

export function GitHubConnectionCard() {
  const [status, setStatus] = useState<TokenStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowState>({
    kind: "idle",
  });

  // In-flight poll timer + a generation counter so a cancelled sign-in's
  // late responses are ignored instead of resurrecting the waiting state.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flowGenRef = useRef(0);

  const stopPolling = useCallback(() => {
    flowGenRef.current += 1;
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const refreshStatus = useCallback(async () => {
    const next = await client.fetch<TokenStatus>("/api/github/token");
    setStatus(next);
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const pollDeviceFlow = useCallback((flowId: string, generation: number) => {
    void (async () => {
      if (generation !== flowGenRef.current) return;
      try {
        const res = await client.fetch<DevicePollResponse>(
          "/api/github/device/poll",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ flowId }),
          },
        );
        if (generation !== flowGenRef.current) return;
        if (res.status === "pending") {
          const delaySeconds = Math.max(1, res.retryAfterSeconds);
          pollTimerRef.current = setTimeout(
            () => pollDeviceFlow(flowId, generation),
            delaySeconds * 1000,
          );
          return;
        }
        if (res.status === "complete") {
          setDeviceFlow({ kind: "idle" });
          setSubmitState({ kind: "idle" });
          setStatus(res);
          return;
        }
        setDeviceFlow({ kind: "idle" });
        setSubmitState({
          kind: "error",
          message:
            res.status === "denied"
              ? "GitHub sign-in was denied on github.com. Start again, or paste a personal access token instead."
              : "The sign-in code expired before it was approved. Start again to get a new code.",
        });
      } catch (err) {
        if (generation !== flowGenRef.current) return;
        setDeviceFlow({ kind: "idle" });
        setSubmitState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, []);

  const handleDeviceSignIn = useCallback(async () => {
    stopPolling();
    const generation = flowGenRef.current;
    setSubmitState({ kind: "idle" });
    setDeviceFlow({ kind: "starting" });
    try {
      const res = await client.fetch<DeviceStartResponse>(
        "/api/github/device/start",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (generation !== flowGenRef.current) return;
      setDeviceFlow({
        kind: "waiting",
        flowId: res.flowId,
        userCode: res.userCode,
        verificationUri: res.verificationUri,
      });
      openExternalUrl(res.verificationUri);
      pollTimerRef.current = setTimeout(
        () => pollDeviceFlow(res.flowId, generation),
        Math.max(1, res.intervalSeconds) * 1000,
      );
    } catch (err) {
      if (generation !== flowGenRef.current) return;
      setDeviceFlow({ kind: "idle" });
      setSubmitState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [pollDeviceFlow, stopPolling]);

  const handleCancelDeviceSignIn = useCallback(() => {
    stopPolling();
    setDeviceFlow({ kind: "idle" });
    setSubmitState({ kind: "idle" });
  }, [stopPolling]);

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
    stopPolling();
    setDeviceFlow({ kind: "idle" });
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
  }, [stopPolling]);

  const submitting = submitState.kind === "submitting";
  const errorMessage =
    submitState.kind === "error" ? submitState.message : null;
  const deviceFlowAvailable = status?.deviceFlowAvailable === true;
  const deviceBusy = deviceFlow.kind !== "idle";

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

      {status?.connected ? (
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
          <p className="sr-only">
            Connect GitHub so coding sub-agents can clone private repos, push
            commits, and open pull requests.
          </p>

          {deviceFlowAvailable && deviceFlow.kind !== "waiting" ? (
            <Button
              variant="default"
              size="sm"
              className="w-fit"
              onClick={() => void handleDeviceSignIn()}
              disabled={submitting || deviceFlow.kind === "starting"}
            >
              <LogIn className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {deviceFlow.kind === "starting"
                ? "Starting sign-in…"
                : "Sign in with GitHub"}
            </Button>
          ) : null}

          {deviceFlow.kind === "waiting" ? (
            <div className="flex flex-col gap-2 rounded-md border border-border bg-bg-accent/40 p-2.5">
              <div className="text-muted">
                Enter this code on{" "}
                <Button
                  unstyled
                  type="button"
                  className="inline-flex items-center gap-1 text-accent hover:underline"
                  onClick={() => openExternalUrl(deviceFlow.verificationUri)}
                >
                  {deviceFlow.verificationUri.replace(/^https:\/\//, "")}
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </Button>
              </div>
              <div
                className="select-all font-mono text-base font-semibold tracking-widest text-txt"
                data-testid="github-device-user-code"
              >
                {deviceFlow.userCode}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted">Waiting for approval…</span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleCancelDeviceSignIn}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          <Button
            unstyled
            type="button"
            className="inline-flex w-fit items-center gap-1 text-xs text-accent hover:underline"
            onClick={() => openExternalUrl(TOKEN_GENERATE_URL)}
          >
            <ExternalLink className="h-3 w-3" aria-hidden />
            {deviceFlowAvailable
              ? "Or generate a token on github.com (scopes: repo, read:user)"
              : "Generate a token on github.com (scopes: repo, read:user)"}
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
              disabled={submitting || deviceBusy || draft.trim().length === 0}
            >
              {submitting ? "Connecting…" : "Connect"}
            </Button>
          </div>
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
