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
import { Button } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";

const HYPERSCAPE_HERO_URL = "/api/views/hyperscape/hero";
const HYPERSCAPE_ACCENT = "#ff5800";

type ChipState = "live" | "attention" | "idle";

const CHIP_DOT_COLOR: Record<ChipState, string> = {
  live: "#22c55e",
  attention: HYPERSCAPE_ACCENT,
  idle: "rgba(125,125,125,0.55)",
};

function chipStateForStatus(status: string | undefined): ChipState {
  if (status === "running" || status === "ready") return "live";
  if (status === "degraded" || status === "failed") return "attention";
  return "idle";
}

function statusLabelText(status: string | undefined): string {
  if (status === "running" || status === "ready") return "Live";
  if (status === "degraded" || status === "failed") return "Needs attention";
  return "Starting";
}

function HeroStatusChip({ state, label }: { state: ChipState; label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 999,
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(8px)",
        border: "1px solid rgba(255,255,255,0.16)",
        color: "#fff",
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: 999,
          background: CHIP_DOT_COLOR[state],
          boxShadow: `0 0 0 4px ${CHIP_DOT_COLOR[state]}33`,
        }}
      />
      {label}
    </span>
  );
}

function HeroHeader({
  title,
  state,
  statusText,
  cta,
}: {
  title: string;
  state: ChipState;
  statusText: string;
  cta?: { label: string; onClick: () => void; disabled?: boolean } | null;
}) {
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "34vh",
        minHeight: 220,
        maxHeight: 380,
        overflow: "hidden",
        borderRadius: 20,
        backgroundColor: "#0b0b0f",
        backgroundImage: `url(${HYPERSCAPE_HERO_URL})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.12) 45%, rgba(0,0,0,0.72) 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 24,
          right: 24,
          bottom: 22,
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <HeroStatusChip state={state} label={statusText} />
          <div
            style={{
              color: "#fff",
              fontSize: 34,
              fontWeight: 800,
              lineHeight: 1.05,
              letterSpacing: "-0.01em",
              textShadow: "0 2px 18px rgba(0,0,0,0.55)",
            }}
          >
            {title}
          </div>
        </div>
        {cta ? (
          <button
            type="button"
            onClick={cta.onClick}
            disabled={cta.disabled}
            style={{
              padding: "12px 22px",
              borderRadius: 999,
              border: "none",
              background: HYPERSCAPE_ACCENT,
              color: "#fff",
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: "0.01em",
              cursor: cta.disabled ? "default" : "pointer",
              opacity: cta.disabled ? 0.55 : 1,
              boxShadow: "0 8px 24px rgba(255,88,0,0.35)",
            }}
          >
            {cta.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function StatusStripCard({
  icon,
  label,
  value,
  state,
}: {
  icon: string;
  label: string;
  value: string;
  state: ChipState;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flex: "1 1 160px",
        minWidth: 150,
        padding: "12px 14px",
        borderRadius: 14,
        border: "1px solid var(--border, rgba(0,0,0,0.12))",
        background: "var(--card, rgba(255,255,255,0.8))",
      }}
    >
      <div
        aria-hidden
        style={{
          display: "grid",
          placeItems: "center",
          width: 38,
          height: 38,
          borderRadius: 11,
          fontSize: 18,
          background: "var(--surface, rgba(0,0,0,0.04))",
        }}
      >
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--muted, rgba(0,0,0,0.58))",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: CHIP_DOT_COLOR[state],
            }}
          />
          {label}
        </div>
        <div
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: "var(--foreground, var(--text, #111))",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

function HeroFrame({
  children,
  variant,
}: {
  children: ReactNode;
  variant: AppOperatorSurfaceProps["variant"];
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: variant === "live" ? 12 : 16,
        maxWidth: 1100,
        margin: "0 auto",
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      {children}
    </div>
  );
}

function HyperscapeWaitingZone() {
  return (
    <div
      style={{
        flex: "1 1 auto",
        minHeight: 160,
        display: "grid",
        placeItems: "center",
        borderRadius: 16,
        border: "1px dashed var(--border, rgba(0,0,0,0.12))",
        background:
          "radial-gradient(120% 120% at 50% 0%, var(--surface, rgba(0,0,0,0.04)) 0%, transparent 70%)",
        padding: "28px 16px",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
          color: "var(--muted, rgba(0,0,0,0.58))",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 30, opacity: 0.85 }}>◇</div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          Waiting for a host session
        </div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          Launch Hyperscape to attach the viewer and follow the agent.
        </div>
      </div>
    </div>
  );
}

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
  if (!run) {
    return (
      <section data-testid="hyperscape-operator-ready">
        <HeroFrame variant={variant}>
          <HeroHeader
            title="Hyperscape"
            state="idle"
            statusText="Host surface ready"
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <StatusStripCard
              icon="◇"
              label="Auth"
              value="Wallet pending"
              state="attention"
            />
            <StatusStripCard
              icon="◎"
              label="Viewer"
              value="Embed attaches"
              state="idle"
            />
            <StatusStripCard
              icon="⌖"
              label="Follow"
              value="Target sync"
              state="idle"
            />
          </div>
          <HyperscapeWaitingZone />
        </HeroFrame>
      </section>
    );
  }

  const firstPrompt = session?.suggestedPrompts?.[0];
  return (
    <HeroFrame variant={variant}>
      <HeroHeader
        title="Hyperscape"
        state={chipStateForStatus(run.status)}
        statusText={statusLabelText(run.status)}
        cta={
          showChat && firstPrompt
            ? {
                label: firstPrompt,
                onClick: () => void handleSuggestedPrompt(firstPrompt),
                disabled: sending,
              }
            : null
        }
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <StatusStripCard
          icon="◎"
          label="Viewer"
          value={run.viewerAttachment}
          state={run.viewerAttachment === "attached" ? "live" : "idle"}
        />
        <StatusStripCard
          icon="⌖"
          label="Follow"
          value={
            session?.followEntity ??
            run.viewer?.authMessage?.followEntity ??
            "Pending"
          }
          state={session?.followEntity ? "live" : "idle"}
        />
        <StatusStripCard
          icon="❤"
          label="Health"
          value={run.health.state}
          state={chipStateForStatus(run.status)}
        />
        <StatusStripCard
          icon="⚡"
          label="Relay"
          value={session?.canSendCommands ? "Ready" : "Waiting"}
          state={session?.canSendCommands ? "live" : "attention"}
        />
      </div>
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
            {matchingRuns.length} active run
            {matchingRuns.length === 1 ? "" : "s"}
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
        </SurfaceSection>
      ) : null}

        {statusMessage ? (
          <div className="rounded-2xl border border-border/35 bg-card/70 px-4 py-3 text-xs-tight leading-5 text-muted-strong">
            {statusMessage}
          </div>
        ) : null}
      </section>
    </HeroFrame>
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
