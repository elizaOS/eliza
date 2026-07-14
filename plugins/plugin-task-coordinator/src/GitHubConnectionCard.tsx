/**
 * Guided GitHub connection UI for coding-agent settings.
 * The server owns OAuth secrets and flow state; this component renders the
 * loading, connected, disconnected, unavailable, waiting, cancelled, denied,
 * and expired states and drives the typed start/poll/cancel/reconnect routes.
 */

import {
  Button,
  client,
  isApiError,
  openExternalUrl,
  SettingsControls,
} from "@elizaos/ui";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  Loader2,
  LogIn,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface TokenStatus {
  connected: boolean;
  deviceFlowAvailable: boolean;
  username?: string;
  scopes?: string[];
  savedAt?: number;
}

type StatusState =
  | { kind: "loading" }
  | { kind: "ready"; value: TokenStatus }
  | { kind: "unavailable"; message: string };

type FlowMode = "connect" | "reconnect";

interface WaitingFlow {
  mode: FlowMode;
  flowId: string;
  userCode: string;
  verificationUri: string;
}

type DeviceFlowState =
  | { kind: "idle" }
  | { kind: "starting"; mode: FlowMode }
  | ({ kind: "waiting" } & WaitingFlow)
  | ({ kind: "cancelling" } & WaitingFlow);

type FeedbackState =
  | { kind: "none" }
  | { kind: "cancelled"; message: string }
  | { kind: "denied" | "expired"; message: string; mode: FlowMode }
  | { kind: "error"; message: string; mode?: FlowMode };

interface DeviceStartResponse {
  status: "started";
  mode: FlowMode;
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

const TOKEN_GENERATE_URL =
  "https://github.com/settings/tokens/new?description=eliza-coding-agents&scopes=repo,read:user";

function messageFromError(error: unknown): string {
  if (isApiError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export function GitHubConnectionCard() {
  const [status, setStatus] = useState<StatusState>({ kind: "loading" });
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowState>({
    kind: "idle",
  });
  const [feedback, setFeedback] = useState<FeedbackState>({ kind: "none" });
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flowGenerationRef = useRef(0);

  const stopLocalPolling = useCallback(() => {
    flowGenerationRef.current += 1;
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => stopLocalPolling, [stopLocalPolling]);

  const refreshStatus = useCallback(async () => {
    setStatus({ kind: "loading" });
    setFeedback({ kind: "none" });
    try {
      const value = await client.fetch<TokenStatus>("/api/github/token");
      setStatus({ kind: "ready", value });
    } catch (error) {
      // error-policy:J4 A failed status read must render unavailable, which is
      // visually distinct from the legitimate disconnected state.
      setStatus({ kind: "unavailable", message: messageFromError(error) });
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const pollDeviceFlow = useCallback(
    (flow: WaitingFlow, generation: number) => {
      void (async () => {
        if (generation !== flowGenerationRef.current) return;
        try {
          const response = await client.fetch<DevicePollResponse>(
            "/api/github/device/poll",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ flowId: flow.flowId }),
            },
          );
          if (generation !== flowGenerationRef.current) return;
          if (response.status === "pending") {
            pollTimerRef.current = setTimeout(
              () => pollDeviceFlow(flow, generation),
              Math.max(1, response.retryAfterSeconds) * 1_000,
            );
            return;
          }
          setDeviceFlow({ kind: "idle" });
          if (response.status === "complete") {
            setStatus({ kind: "ready", value: response });
            setFeedback({ kind: "none" });
            return;
          }
          if (response.status === "denied") {
            setFeedback({
              kind: "denied",
              mode: flow.mode,
              message:
                "GitHub sign-in was denied. No credential was changed. You can try again or use a personal access token.",
            });
            return;
          }
          setFeedback({
            kind: "expired",
            mode: flow.mode,
            message:
              "The GitHub sign-in code expired. No credential was changed. Start again for a new code.",
          });
        } catch (error) {
          // error-policy:J4 Poll failures stop the flow and surface a retryable
          // user-facing error; they never masquerade as a denial or expiry.
          if (generation !== flowGenerationRef.current) return;
          setDeviceFlow({ kind: "idle" });
          setFeedback({
            kind: "error",
            mode: flow.mode,
            message: messageFromError(error),
          });
        }
      })();
    },
    [],
  );

  const startDeviceFlow = useCallback(
    async (mode: FlowMode) => {
      stopLocalPolling();
      const generation = flowGenerationRef.current;
      setFeedback({ kind: "none" });
      setDeviceFlow({ kind: "starting", mode });
      try {
        const response = await client.fetch<DeviceStartResponse>(
          mode === "reconnect"
            ? "/api/github/device/reconnect"
            : "/api/github/device/start",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
        );
        if (generation !== flowGenerationRef.current) return;
        const flow: WaitingFlow = {
          mode,
          flowId: response.flowId,
          userCode: response.userCode,
          verificationUri: response.verificationUri,
        };
        setDeviceFlow({ kind: "waiting", ...flow });
        openExternalUrl(response.verificationUri);
        pollTimerRef.current = setTimeout(
          () => pollDeviceFlow(flow, generation),
          Math.max(1, response.intervalSeconds) * 1_000,
        );
      } catch (error) {
        // error-policy:J4 Owner-setup and transport failures are actionable UI
        // states, while the prior credential remains intact for reconnects.
        if (generation !== flowGenerationRef.current) return;
        setDeviceFlow({ kind: "idle" });
        setFeedback({
          kind: "error",
          mode,
          message: messageFromError(error),
        });
      }
    },
    [pollDeviceFlow, stopLocalPolling],
  );

  const cancelDeviceFlow = useCallback(async () => {
    if (deviceFlow.kind !== "waiting") return;
    const flow: WaitingFlow = deviceFlow;
    stopLocalPolling();
    setDeviceFlow({ kind: "cancelling", ...flow });
    setFeedback({ kind: "none" });
    try {
      await client.fetch<{ status: "cancelled" }>("/api/github/device/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId: flow.flowId }),
      });
      setDeviceFlow({ kind: "idle" });
      setFeedback({
        kind: "cancelled",
        message:
          "GitHub sign-in was cancelled. No credential was changed or removed.",
      });
    } catch (error) {
      // error-policy:J4 A server cancellation failure keeps the flow visible
      // so the user can retry cancellation instead of assuming it succeeded.
      setDeviceFlow({ kind: "waiting", ...flow });
      setFeedback({ kind: "error", message: messageFromError(error) });
    }
  }, [deviceFlow, stopLocalPolling]);

  const connectWithToken = useCallback(async () => {
    const token = draft.trim();
    if (!token) return;
    setSubmitting(true);
    setFeedback({ kind: "none" });
    try {
      const value = await client.fetch<TokenStatus>("/api/github/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      setStatus({ kind: "ready", value });
      setDraft("");
    } catch (error) {
      // error-policy:J4 A rejected PAT is shown as an explicit error and the
      // disconnected state remains available for correction and retry.
      setFeedback({ kind: "error", message: messageFromError(error) });
    } finally {
      setSubmitting(false);
    }
  }, [draft]);

  const disconnect = useCallback(async () => {
    stopLocalPolling();
    setDeviceFlow({ kind: "idle" });
    setSubmitting(true);
    setFeedback({ kind: "none" });
    try {
      const value = await client.fetch<TokenStatus>("/api/github/token", {
        method: "DELETE",
      });
      setStatus({ kind: "ready", value });
    } catch (error) {
      // error-policy:J4 Failed disconnect must not render disconnected; the
      // connected credential remains visible while the error is surfaced.
      setFeedback({ kind: "error", message: messageFromError(error) });
    } finally {
      setSubmitting(false);
    }
  }, [stopLocalPolling]);

  const readyStatus = status.kind === "ready" ? status.value : null;
  const flowBusy = deviceFlow.kind !== "idle";

  const flowPanel =
    deviceFlow.kind === "waiting" || deviceFlow.kind === "cancelling" ? (
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
          <span className="inline-flex items-center gap-1.5 text-muted">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            {deviceFlow.kind === "cancelling"
              ? "Cancelling…"
              : deviceFlow.mode === "reconnect"
                ? "Waiting to replace the connection…"
                : "Waiting for approval…"}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void cancelDeviceFlow()}
            disabled={deviceFlow.kind === "cancelling"}
          >
            Cancel
          </Button>
        </div>
      </div>
    ) : null;

  return (
    <div className="space-y-3 px-1 py-1">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <GitPullRequest className="h-4 w-4 text-muted" aria-hidden />
          <span className="text-sm font-medium text-txt">GitHub</span>
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              readyStatus?.connected ? "bg-emerald-500" : "bg-muted/40"
            }`}
            aria-label={
              readyStatus?.connected
                ? `Connected as @${readyStatus.username}`
                : status.kind === "loading"
                  ? "Loading GitHub connection"
                  : status.kind === "unavailable"
                    ? "GitHub connection unavailable"
                    : "Not connected"
            }
            role="img"
          />
        </div>
      </div>

      {status.kind === "loading" ? (
        <div
          className="flex items-center gap-2 rounded-md border border-border px-2.5 py-3 text-xs text-muted"
          aria-live="polite"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Loading this agent&apos;s GitHub connection…
        </div>
      ) : null}

      {status.kind === "unavailable" ? (
        <div className="flex flex-col gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-2 text-xs text-rose-500">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              GitHub connection status is unavailable: {status.message}
            </span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="w-fit"
            onClick={() => void refreshStatus()}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Retry
          </Button>
        </div>
      ) : null}

      {readyStatus?.connected ? (
        <div className="flex flex-col gap-2 text-xs">
          <div className="flex items-center gap-2 text-muted">
            <CheckCircle2
              className="h-3.5 w-3.5 text-emerald-500"
              aria-hidden
            />
            <span>
              Connected as{" "}
              <span className="font-medium text-txt">
                @{readyStatus.username}
              </span>
            </span>
          </div>
          <div className="text-muted">
            Scopes:{" "}
            <span className="font-mono text-txt">
              {readyStatus.scopes && readyStatus.scopes.length > 0
                ? readyStatus.scopes.join(", ")
                : "none reported"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {readyStatus.deviceFlowAvailable ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void startDeviceFlow("reconnect")}
                disabled={submitting || flowBusy}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {deviceFlow.kind === "starting" ? "Starting…" : "Reconnect"}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void disconnect()}
              disabled={submitting || flowBusy}
            >
              <Unplug className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {submitting ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
          {flowPanel}
        </div>
      ) : null}

      {readyStatus && !readyStatus.connected ? (
        <div className="flex flex-col gap-2 text-xs">
          {readyStatus.deviceFlowAvailable &&
          (deviceFlow.kind === "idle" || deviceFlow.kind === "starting") ? (
            <Button
              variant="default"
              size="sm"
              className="w-fit"
              onClick={() => void startDeviceFlow("connect")}
              disabled={submitting || flowBusy}
            >
              <LogIn className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {deviceFlow.kind === "starting"
                ? "Starting sign-in…"
                : "Sign in with GitHub"}
            </Button>
          ) : null}
          {flowPanel}
          <Button
            unstyled
            type="button"
            className="inline-flex w-fit items-center gap-1 text-xs text-accent hover:underline"
            onClick={() => openExternalUrl(TOKEN_GENERATE_URL)}
          >
            <ExternalLink className="h-3 w-3" aria-hidden />
            {readyStatus.deviceFlowAvailable
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
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void connectWithToken();
              }}
              autoComplete="off"
            />
            <Button
              variant="default"
              size="sm"
              onClick={() => void connectWithToken()}
              disabled={submitting || flowBusy || !draft.trim()}
            >
              {submitting ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </div>
      ) : null}

      {feedback.kind !== "none" ? (
        <div
          className={`rounded-md border px-2 py-1.5 text-xs ${
            feedback.kind === "cancelled"
              ? "border-border bg-bg-accent/40 text-muted"
              : "border-rose-500/40 bg-rose-500/10 text-rose-500"
          }`}
          aria-live="polite"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{feedback.message}</span>
            {(feedback.kind === "denied" ||
              feedback.kind === "expired" ||
              (feedback.kind === "error" && feedback.mode)) &&
            deviceFlow.kind === "idle" ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void startDeviceFlow(
                    feedback.kind === "error"
                      ? (feedback.mode ?? "connect")
                      : feedback.mode,
                  )
                }
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                Try again
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
