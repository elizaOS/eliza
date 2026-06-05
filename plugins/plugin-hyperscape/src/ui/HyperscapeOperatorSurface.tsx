import {
  type AppOperatorSurfaceProps,
  type AppRunSummary,
  type AppSessionJsonValue,
  client,
  formatDetailTimestamp,
  SurfaceBadge,
  SurfaceCard,
  SurfaceSection,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
  useApp,
} from "@elizaos/app-core/ui-compat";
import { Button, Input } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { type CSSProperties, useCallback, useMemo, useState } from "react";

function HyperscapeSuggestedPromptButton({
  prompt,
  index,
  disabled,
  onSelect,
}: {
  prompt: string;
  index: number;
  disabled: boolean;
  onSelect: (prompt: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `suggested-prompt-${index}`,
    role: "button",
    label: prompt,
    group: "operator-relay",
    description: `Relay the suggested operator prompt "${prompt}" to Hyperscape`,
  });
  return (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="sm"
      className="min-h-10 rounded-xl px-3 shadow-sm"
      onClick={() => onSelect(prompt)}
      disabled={disabled}
      aria-label={prompt}
      {...agentProps}
    >
      {prompt}
    </Button>
  );
}

function HyperscapeTuiPromptButton({
  prompt,
  index,
  disabled,
  onSelect,
  style,
}: {
  prompt: string;
  index: number;
  disabled: boolean;
  onSelect: (prompt: string) => void;
  style: CSSProperties;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `tui-suggested-prompt-${index}`,
    role: "button",
    label: prompt,
    group: "tui-operator-relay",
    description: `Send the suggested Hyperscape command "${prompt}" from the terminal surface`,
  });
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={() => onSelect(prompt)}
      style={style}
      {...agentProps}
    >
      {prompt}
    </button>
  );
}

interface HyperscapeActivityEntry {
  id: string;
  label: string;
  detail: string;
  timestamp: string | number | null;
}

function asTelemetryRecord(
  value: Record<string, AppSessionJsonValue> | null | undefined,
): Record<string, AppSessionJsonValue> | null {
  return value && typeof value === "object" ? value : null;
}

function extractRecentActivity(run: AppRunSummary): HyperscapeActivityEntry[] {
  const entries: HyperscapeActivityEntry[] = [];

  for (const event of run.recentEvents ?? []) {
    entries.push({
      id: event.eventId,
      label: event.kind,
      detail: event.message,
      timestamp: event.createdAt,
    });
  }

  for (const item of run.session?.activity ?? []) {
    entries.push({
      id: item.id,
      label: item.type,
      detail: item.message,
      timestamp: item.timestamp ?? null,
    });
  }

  const telemetry = asTelemetryRecord(run.session?.telemetry);
  const telemetryActivity = telemetry?.recentActivity;
  if (Array.isArray(telemetryActivity)) {
    for (const item of telemetryActivity) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, AppSessionJsonValue>;
      entries.push({
        id: `${record.action ?? "activity"}-${record.ts ?? entries.length}`,
        label: typeof record.action === "string" ? record.action : "activity",
        detail:
          typeof record.detail === "string"
            ? record.detail
            : "No detail captured.",
        timestamp:
          typeof record.ts === "string" || typeof record.ts === "number"
            ? record.ts
            : null,
      });
    }
  }

  return entries
    .slice()
    .sort((left, right) => {
      const rightTime = new Date(right.timestamp ?? 0).getTime();
      const leftTime = new Date(left.timestamp ?? 0).getTime();
      return (
        (Number.isFinite(rightTime) ? rightTime : 0) -
        (Number.isFinite(leftTime) ? leftTime : 0)
      );
    })
    .slice(0, 5);
}

function formatViewerAuthLabel(run: AppRunSummary): string {
  if (run.viewer?.authMessage?.type) {
    return `Auto-login ${run.viewer.authMessage.type}`;
  }
  if (run.viewer?.postMessageAuth) {
    return "Auth bootstrap pending";
  }
  return "Viewer does not need app auth";
}

function surfaceTestId(variant: AppOperatorSurfaceProps["variant"]): string {
  if (variant === "live") return "hyperscape-live-operator-surface";
  if (variant === "running") return "hyperscape-running-operator-surface";
  return "hyperscape-detail-operator-surface";
}

export function HyperscapeOperatorSurface({
  appName,
  variant = "detail",
  focus = "all",
}: AppOperatorSurfaceProps) {
  const { appRuns } = useApp();
  const { run, matchingRuns } = useMemo(
    () => selectLatestRunForApp(appName, appRuns),
    [appName, appRuns],
  );
  const [operatorMessage, setOperatorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [controlAction, setControlAction] = useState<"pause" | "resume" | null>(
    null,
  );

  const session = run?.session ?? null;
  const recentActivity = useMemo(
    () => (run ? extractRecentActivity(run).slice(0, 2) : []),
    [run],
  );
  const showDashboard = focus !== "chat";
  const showChat = focus !== "dashboard";
  const surfaceTitle =
    variant === "live"
      ? "Hyperscape Host Surface"
      : variant === "running"
        ? "Hyperscape Run Surface"
        : "Hyperscape Host Surface";

  const sendOperatorMessage = useCallback(
    async (content: string) => {
      if (!run || content.length === 0 || sending) return false;

      setSending(true);
      setStatusMessage(null);
      try {
        const response = await client.sendAppRunMessage(run.runId, content);
        setStatusMessage(response.message);
        return response.success;
      } catch (error) {
        setStatusMessage(
          error instanceof Error
            ? error.message
            : "Failed to relay the Hyperscape operator message.",
        );
        return false;
      } finally {
        setSending(false);
      }
    },
    [run, sending],
  );

  const handleSendMessage = useCallback(async () => {
    const content = operatorMessage.trim();
    if (content.length === 0) return;
    const sent = await sendOperatorMessage(content);
    if (sent) {
      setOperatorMessage("");
    }
  }, [operatorMessage, sendOperatorMessage]);

  const handleSuggestedPrompt = useCallback(
    async (prompt: string) => {
      await sendOperatorMessage(prompt.trim());
    },
    [sendOperatorMessage],
  );

  const handleControl = useCallback(
    async (action: "pause" | "resume") => {
      if (!run) return;
      setControlAction(action);
      setStatusMessage(null);
      try {
        const response = await client.controlAppRun(run.runId, action);
        setStatusMessage(response.message);
      } catch (error) {
        setStatusMessage(
          error instanceof Error
            ? error.message
            : `Failed to ${action} Hyperscape.`,
        );
      } finally {
        setControlAction(null);
      }
    },
    [run],
  );

  const pauseControl = useAgentElement<HTMLButtonElement>({
    id: "action-pause",
    role: "button",
    label: "Pause autonomy",
    group: "operator-controls",
    description: "Pause the Hyperscape agent's autonomous run",
    status: controlAction === "pause" ? "active" : "inactive",
  });
  const resumeControl = useAgentElement<HTMLButtonElement>({
    id: "action-resume",
    role: "button",
    label: "Resume autonomy",
    group: "operator-controls",
    description: "Resume the Hyperscape agent's autonomous run",
    status: controlAction === "resume" ? "active" : "inactive",
  });
  const operatorInput = useAgentElement<HTMLInputElement>({
    id: "input-operator-message",
    role: "text-input",
    label: "Operator message",
    group: "operator-relay",
    description:
      "Type an operator message telling Hyperscape what to prioritize, avoid, or explain",
  });
  const sendControl = useAgentElement<HTMLButtonElement>({
    id: "action-send",
    role: "button",
    label: "Send",
    group: "operator-relay",
    description: "Send the operator message to Hyperscape",
  });

  if (!run) {
    return (
      <section className="p-4" data-testid="hyperscape-operator-ready">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/45 bg-card/82 px-4 py-3 shadow-sm">
            <div className="flex items-center gap-3">
              <div
                aria-hidden
                className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-600 text-lg font-black text-white shadow-sm"
              >
                H
              </div>
              <div>
                <div className="text-sm font-semibold text-foreground">
                  Hyperscape
                </div>
                <div className="text-[11px] font-semibold uppercase tracking-normal text-muted-strong">
                  host surface ready
                </div>
              </div>
            </div>
            <div className="h-3 w-3 rounded-full bg-amber-400 shadow-[0_0_0_4px_rgba(251,191,36,0.18)]" />
          </div>

          <div className="grid grid-cols-1 gap-3">
            <div className="flex min-h-16 items-center gap-3 rounded-xl border border-border/45 bg-card/78 px-4 py-3 shadow-sm">
              <div className="grid h-9 w-9 place-items-center rounded-lg border border-amber-300/35 bg-amber-400/10 text-lg text-amber-700">
                ◇
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-normal text-muted-strong">
                  Auth
                </div>
                <div className="text-sm font-semibold text-foreground">
                  Wallet pending
                </div>
              </div>
            </div>
            <div className="flex min-h-16 items-center gap-3 rounded-xl border border-border/45 bg-card/78 px-4 py-3 shadow-sm">
              <div className="grid h-9 w-9 place-items-center rounded-lg border border-cyan-300/35 bg-cyan-400/10 text-lg text-cyan-700">
                ◎
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-normal text-muted-strong">
                  Viewer
                </div>
                <div className="text-sm font-semibold text-foreground">
                  Embed attaches
                </div>
              </div>
            </div>
            <div className="flex min-h-16 items-center gap-3 rounded-xl border border-border/45 bg-card/78 px-4 py-3 shadow-sm">
              <div className="grid h-9 w-9 place-items-center rounded-lg border border-emerald-300/35 bg-emerald-400/10 text-lg text-emerald-700">
                ⌖
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-normal text-muted-strong">
                  Follow
                </div>
                <div className="text-sm font-semibold text-foreground">
                  Target sync
                </div>
              </div>
            </div>
            <div className="flex min-h-16 items-center gap-3 rounded-xl border border-border/45 bg-card/78 px-4 py-3 shadow-sm">
              <div className="grid h-9 w-9 place-items-center rounded-lg border border-violet-300/35 bg-violet-400/10 text-lg text-violet-700">
                ↗
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-normal text-muted-strong">
                  Path
                </div>
                <div className="text-sm font-semibold text-foreground">
                  /hyperscape
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      className={`space-y-3 ${variant === "live" ? "p-3" : ""}`}
      data-testid={surfaceTestId(variant)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-muted">
          {surfaceTitle}
        </div>
        <SurfaceBadge tone={toneForStatusText(run.status)}>
          {run.status}
        </SurfaceBadge>
        <SurfaceBadge tone={toneForViewerAttachment(run.viewerAttachment)}>
          {run.viewerAttachment}
        </SurfaceBadge>
        <SurfaceBadge tone={toneForHealthState(run.health.state)}>
          {run.health.state}
        </SurfaceBadge>
        <span className="ml-auto text-2xs uppercase tracking-[0.18em] text-muted">
          {matchingRuns.length} active run{matchingRuns.length === 1 ? "" : "s"}
        </span>
      </div>

      {showDashboard ? (
        <>
          <SurfaceSection title="Host">
            <div className="space-y-2">
              <SurfaceCard
                label="Auth"
                value={formatViewerAuthLabel(run)}
                subtitle={variant === "live" ? run.viewer?.url : undefined}
              />
              <SurfaceCard
                label="Follow"
                value={
                  session?.followEntity ??
                  run.viewer?.authMessage?.followEntity ??
                  "Pending"
                }
                subtitle={session?.characterId ?? undefined}
              />
              <SurfaceCard
                label="Runtime"
                value={run.supportsBackground ? "Background" : "Foreground"}
                subtitle={session?.summary ?? run.summary ?? undefined}
              />
              <SurfaceCard
                label="Viewer"
                value={run.viewerAttachment}
                subtitle={
                  run.awaySummary?.message ??
                  formatDetailTimestamp(run.lastHeartbeatAt ?? run.updatedAt)
                }
              />
            </div>
          </SurfaceSection>

          <SurfaceSection title="State">
            <div className="space-y-2">
              <SurfaceCard
                label="Goal"
                value={session?.goalLabel ?? "No goal"}
                subtitle={run.summary ?? run.health.message ?? undefined}
              />
              <SurfaceCard
                label="Health"
                value={run.health.state}
                tone={toneForHealthState(run.health.state)}
                subtitle={
                  run.health.message ?? run.healthDetails?.message ?? undefined
                }
              />
              <SurfaceCard
                label="Relay"
                value={session?.canSendCommands ? "Ready" : "Waiting"}
                subtitle={session?.sessionId ?? undefined}
              />
            </div>
            {recentActivity.length > 0 ? (
              <div className="space-y-2">
                {recentActivity.map((entry) => (
                  <div
                    key={entry.id}
                    className="rounded-xl border border-border/30 bg-bg/60 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 text-xs-tight font-medium text-txt">
                      <span>{entry.label}</span>
                      <span className="ml-auto text-2xs uppercase tracking-[0.18em] text-muted">
                        {formatDetailTimestamp(entry.timestamp)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs-tight leading-5 text-muted-strong">
                      {entry.detail}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-border/30 bg-bg/60 px-3 py-2 text-xs-tight italic text-muted">
                No activity.
              </div>
            )}
          </SurfaceSection>
        </>
      ) : null}

      {showChat ? (
        <SurfaceSection title="Operator Relay">
          {session?.suggestedPrompts?.length ? (
            <div className="flex flex-wrap gap-2">
              {session.suggestedPrompts.slice(0, 2).map((prompt, index) => (
                <HyperscapeSuggestedPromptButton
                  key={prompt}
                  prompt={prompt}
                  index={index}
                  disabled={sending}
                  onSelect={(value) => void handleSuggestedPrompt(value)}
                />
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {session?.controls?.includes("pause") ? (
              <Button
                ref={pauseControl.ref}
                type="button"
                variant="outline"
                size="sm"
                className="min-h-10 rounded-xl px-3 shadow-sm"
                onClick={() => void handleControl("pause")}
                disabled={controlAction === "pause"}
                aria-current={controlAction === "pause" ? "true" : undefined}
                aria-label="Pause autonomy"
                {...pauseControl.agentProps}
              >
                {controlAction === "pause" ? "Pausing..." : "Pause"}
              </Button>
            ) : null}
            {session?.controls?.includes("resume") ? (
              <Button
                ref={resumeControl.ref}
                type="button"
                variant="outline"
                size="sm"
                className="min-h-10 rounded-xl px-3 shadow-sm"
                onClick={() => void handleControl("resume")}
                disabled={controlAction === "resume"}
                aria-current={controlAction === "resume" ? "true" : undefined}
                aria-label="Resume autonomy"
                {...resumeControl.agentProps}
              >
                {controlAction === "resume" ? "Resuming..." : "Resume"}
              </Button>
            ) : null}
          </div>
          <div className="grid gap-2">
            <Input
              ref={operatorInput.ref}
              value={operatorMessage}
              onChange={(event) => setOperatorMessage(event.target.value)}
              placeholder="Steer Hyperscape..."
              className="min-h-11 rounded-xl"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSendMessage();
                }
              }}
              disabled={!session?.canSendCommands}
              aria-label="Operator message"
              {...operatorInput.agentProps}
            />
            <Button
              ref={sendControl.ref}
              type="button"
              className="min-h-11 rounded-xl px-4 shadow-sm"
              onClick={() => void handleSendMessage()}
              disabled={
                sending ||
                !session?.canSendCommands ||
                operatorMessage.trim().length === 0
              }
              aria-label="Send"
              {...sendControl.agentProps}
            >
              {sending ? "Sending" : "Send"}
            </Button>
          </div>
        </SurfaceSection>
      ) : null}

      {statusMessage ? (
        <div className="rounded-2xl border border-border/35 bg-card/70 px-4 py-3 text-xs-tight leading-5 text-muted-strong">
          {statusMessage}
        </div>
      ) : null}
    </section>
  );
}

export function HyperscapeTuiView() {
  const { appRuns, setActionNotice } = useApp();
  const { run, matchingRuns } = useMemo(
    () => selectLatestRunForApp("@elizaos/plugin-hyperscape", appRuns),
    [appRuns],
  );
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const session = run?.session ?? null;
  const recentActivity = run ? extractRecentActivity(run) : [];
  const suggestedPrompts = session?.suggestedPrompts ?? [];
  const canSend = Boolean(session?.canSendCommands);
  const tuiCommandInput = useAgentElement<HTMLInputElement>({
    id: "tui-input-command",
    role: "text-input",
    label: "Hyperscape command",
    group: "tui-operator-relay",
    description:
      "Type a Hyperscape operator command to relay from the terminal surface",
    getValue: () => draft,
    onFill: (value) => setDraft(value),
  });
  const tuiSendControl = useAgentElement<HTMLButtonElement>({
    id: "tui-action-send-command",
    role: "button",
    label: "Send command",
    group: "tui-operator-relay",
    description: "Send the typed Hyperscape command from the terminal surface",
  });
  const viewState = {
    viewType: "tui",
    viewId: "hyperscape",
    appName: "@elizaos/plugin-hyperscape",
    runId: run?.runId ?? null,
    status: run?.status ?? "idle",
    health: run?.health.state ?? null,
    viewerAttachment: run?.viewerAttachment ?? null,
    activeRunCount: matchingRuns.length,
    sessionId: session?.sessionId ?? null,
    canSend,
    followEntity:
      session?.followEntity ?? run?.viewer?.authMessage?.followEntity ?? null,
    characterId: session?.characterId ?? null,
    recentActivityCount: recentActivity.length,
    suggestedPromptCount: suggestedPrompts.length,
  };

  const sendDraft = async (content: string) => {
    const trimmed = content.trim();
    if (!run?.runId || !trimmed || sending) return;
    setSending(true);
    try {
      const response = await client.sendAppRunMessage(run.runId, trimmed);
      setActionNotice(
        response.message,
        response.success ? "success" : "error",
        2600,
      );
      setDraft("");
    } catch (error) {
      setActionNotice(
        error instanceof Error
          ? error.message
          : "Failed to relay the Hyperscape operator message.",
        "error",
        3200,
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div data-view-state={JSON.stringify(viewState)} style={tuiRootStyle}>
      <div style={tuiRouteStyle}>elizaos://hyperscape --type=tui</div>
      <div data-status={run?.status ?? "idle"} style={tuiMetaStyle}>
        {run?.status ?? "idle"} | {run?.viewerAttachment ?? "viewer pending"} |{" "}
        {run?.health.state ?? "unknown"}
      </div>
      <section style={tuiPanelStyle} aria-label="Hyperscape state">
        <strong style={tuiTitleStyle}>Hyperscape</strong>
        <div>run {run?.runId ?? "none"}</div>
        <div>session {session?.sessionId ?? "none"}</div>
        <div>follow {viewState.followEntity ?? "none"}</div>
        <div>commands {canSend ? "available" : "unavailable"}</div>
        <div style={tuiSubtleStyle}>suggested prompts</div>
        {(suggestedPrompts.length
          ? suggestedPrompts
          : ["look around", "follow target", "pause"]
        )
          .slice(0, 6)
          .map((prompt, index) => (
            <HyperscapeTuiPromptButton
              key={prompt}
              prompt={prompt}
              index={index}
              disabled={!canSend || sending}
              onSelect={(value) => void sendDraft(value)}
              style={tuiButtonStyle}
            />
          ))}
        <input
          ref={tuiCommandInput.ref}
          aria-label="Hyperscape command"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void sendDraft(draft);
          }}
          placeholder="Send an operator message..."
          style={tuiInputStyle}
          {...tuiCommandInput.agentProps}
        />
        <button
          ref={tuiSendControl.ref}
          type="button"
          disabled={!canSend || sending || !draft.trim()}
          onClick={() => void sendDraft(draft)}
          style={tuiButtonStyle}
          {...tuiSendControl.agentProps}
        >
          send command
        </button>
      </section>
    </div>
  );
}

const tuiRootStyle: CSSProperties = {
  minHeight: "100vh",
  background: "#020617",
  color: "#cbd5e1",
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  padding: 20,
};
const tuiRouteStyle: CSSProperties = { color: "#7dd3fc", marginBottom: 4 };
const tuiMetaStyle: CSSProperties = { color: "#475569", marginBottom: 16 };
const tuiPanelStyle: CSSProperties = {
  border: "1px solid rgba(125,211,252,0.3)",
  borderRadius: 6,
  padding: 16,
  maxWidth: 760,
};
const tuiTitleStyle: CSSProperties = {
  display: "block",
  color: "#e2e8f0",
  marginBottom: 10,
};
const tuiSubtleStyle: CSSProperties = { color: "#64748b", marginTop: 14 };
const tuiButtonStyle: CSSProperties = {
  display: "block",
  width: "100%",
  margin: "8px 0",
  background: "transparent",
  color: "#a7f3d0",
  border: "1px solid rgba(167,243,208,0.45)",
  borderRadius: 4,
  padding: "6px 8px",
  cursor: "pointer",
  fontFamily: "inherit",
};
const tuiInputStyle: CSSProperties = {
  width: "100%",
  marginTop: 14,
  background: "#020617",
  color: "#e2e8f0",
  border: "1px solid rgba(125,211,252,0.35)",
  borderRadius: 4,
  padding: "8px",
  fontFamily: "inherit",
};
