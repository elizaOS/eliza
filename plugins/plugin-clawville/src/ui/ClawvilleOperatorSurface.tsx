import {
  type AppOperatorSurfaceProps,
  type AppRunSummary,
  client,
  type GameOperatorAction,
  type GameOperatorEvent,
  GameOperatorShell,
  useApp,
} from "@elizaos/ui";
import { type CSSProperties, useCallback, useMemo, useState } from "react";

type RunEventSummary = {
  eventId: string;
  kind: string;
  message: string;
  severity?: string;
  createdAt?: string | null;
};

type RunActivitySummary = {
  id: string;
  type: string;
  message: string;
  severity?: string;
  timestamp?: string | null;
};

const PRIMARY_COMMANDS = [
  {
    id: "move-tools",
    label: "Go to Tools",
    command: "Move to tool workshop",
    testId: "clawville-command-move-krusty",
  },
  {
    id: "move-code",
    label: "Go to Code",
    command: "Move to skill forge",
    testId: "clawville-command-move-chum",
  },
  {
    id: "visit-nearest",
    label: "Visit nearest",
    command: "Visit the nearest building",
    testId: "clawville-command-visit-nearest",
  },
  {
    id: "ask-npc",
    label: "Ask NPC",
    command: "Ask the nearest NPC what to learn next",
    testId: "clawville-command-ask-npc",
  },
] as const;

function readString(
  source: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(
  source: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusLabel(status: string): string {
  if (status === "running" || status === "ready") return "Live";
  if (status === "degraded" || status === "failed") return "Needs attention";
  return "Starting";
}

function statusTone(status: string): "live" | "attention" | "idle" {
  if (status === "running" || status === "ready") return "live";
  if (status === "degraded" || status === "failed") return "attention";
  return "idle";
}

function replaceRun(appRuns: AppRunSummary[], nextRun: AppRunSummary) {
  return [
    ...appRuns.filter((candidate) => candidate.runId !== nextRun.runId),
    nextRun,
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function localEventId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatBuildingId(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function cleanClawvilleMessage(message: string): string {
  const tooFar = message.match(/^Too far from ([a-z0-9-]+)/i);
  if (tooFar?.[1]) {
    return `Too far from ${formatBuildingId(tooFar[1])}. Move closer before visiting.`;
  }
  return message;
}

function collectRunEvents(
  run: AppRunSummary,
  localEvents: GameOperatorEvent[],
): GameOperatorEvent[] {
  const serverEvents = (run.recentEvents ?? [])
    .filter(
      (event: RunEventSummary) =>
        event.kind !== "refresh" &&
        event.kind !== "attach" &&
        event.kind !== "detach",
    )
    .map((event: RunEventSummary) => ({
      id: event.eventId,
      label: event.kind,
      message: cleanClawvilleMessage(event.message),
      tone:
        event.severity === "error"
          ? "error"
          : event.severity === "warning"
            ? "warning"
            : "info",
      timestamp: event.createdAt,
    })) satisfies GameOperatorEvent[];

  const activityEvents: GameOperatorEvent[] =
    run.session?.activity?.map((entry: RunActivitySummary) => ({
      id: entry.id,
      label: entry.type,
      message: cleanClawvilleMessage(entry.message),
      tone:
        entry.severity === "error"
          ? "error"
          : entry.severity === "warning"
            ? "warning"
            : "info",
      timestamp: entry.timestamp ?? null,
    })) ?? [];

  return [...serverEvents, ...activityEvents, ...localEvents];
}

export function ClawvilleOperatorSurface({
  appName,
  variant = "detail",
}: AppOperatorSurfaceProps) {
  const { appRuns, setState } = useApp();
  const run = useMemo(
    () =>
      [...(Array.isArray(appRuns) ? appRuns : [])]
        .filter((candidate) => candidate.appName === appName)
        .sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        )[0] ?? null,
    [appName, appRuns],
  );
  const [draft, setDraft] = useState("");
  const [localEvents, setLocalEvents] = useState<GameOperatorEvent[]>([]);
  const [sendingCommand, setSendingCommand] = useState<string | null>(null);

  const telemetry =
    run?.session?.telemetry && typeof run.session.telemetry === "object"
      ? (run.session.telemetry as Record<string, unknown>)
      : null;
  const nearestBuilding =
    readString(telemetry, "nearestBuildingLabel") ??
    readString(telemetry, "nearestBuildingId") ??
    "the reef";
  const knowledgeCount = readNumber(telemetry, "knowledgeCount");
  const canSend = Boolean(run?.runId && run.session?.canSendCommands);

  const sendCommand = useCallback(
    async (content: string, clearDraftOnSuccess = false) => {
      const trimmed = content.trim();
      if (!run?.runId || !trimmed || sendingCommand) return;

      setSendingCommand(trimmed);
      setLocalEvents((current) => [
        ...current,
        {
          id: localEventId("clawville-user"),
          label: "You",
          message: trimmed,
          tone: "user",
          timestamp: Date.now(),
        },
      ]);

      try {
        const response = await client.sendAppRunMessage(run.runId, trimmed);
        const persistedSession =
          response.run?.session ?? response.session ?? null;
        if (response.run) {
          setState("appRuns", replaceRun(appRuns, response.run));
        }
        if (clearDraftOnSuccess) {
          setDraft((current) => (current.trim() === trimmed ? "" : current));
        }
        if (persistedSession) {
          setLocalEvents([]);
          return;
        }
        setLocalEvents((current) => [
          ...current,
          {
            id: localEventId("clawville-game"),
            label: response.disposition === "queued" ? "Queued" : "ClawVille",
            message: response.message ?? "Command accepted.",
            tone:
              response.disposition === "accepted"
                ? "success"
                : response.disposition === "queued"
                  ? "info"
                  : "error",
            timestamp: Date.now(),
          },
        ]);
      } catch (error) {
        setLocalEvents((current) => [
          ...current,
          {
            id: localEventId("clawville-error"),
            label: "Error",
            message:
              error instanceof Error
                ? error.message
                : "ClawVille command failed.",
            tone: "error",
            timestamp: Date.now(),
          },
        ]);
      } finally {
        setSendingCommand(null);
      }
    },
    [appRuns, run?.runId, sendingCommand, setState],
  );

  if (!run) {
    return (
      <section
        className={variant === "live" ? "p-3" : ""}
        data-testid="clawville-operator-empty"
      >
        <div className="rounded-2xl border border-border/35 bg-card/74 p-4 text-xs text-muted-strong">
          Launch ClawVille to open game chat.
        </div>
      </section>
    );
  }

  const primaryActions: GameOperatorAction[] = PRIMARY_COMMANDS.map((item) => ({
    ...item,
  }));
  const suggestedActions = (run.session?.suggestedPrompts ?? []).map(
    (prompt: string) => ({
      id: prompt,
      label: prompt,
      command: prompt,
      testId: "clawville-suggested-command",
    }),
  );
  const events = collectRunEvents(run, localEvents);

  return (
    <GameOperatorShell
      surfaceTestId={
        variant === "live"
          ? "clawville-live-operator-surface"
          : "clawville-detail-operator-surface"
      }
      title="ClawVille chat"
      statusLabel={statusLabel(run.status)}
      statusTone={statusTone(run.status)}
      objective={run.session?.goalLabel ?? `Near ${nearestBuilding}`}
      detailItems={[
        { label: "Location", value: nearestBuilding },
        {
          label: "Skills",
          value:
            knowledgeCount === null
              ? "Not loaded"
              : `${knowledgeCount} learned`,
        },
      ]}
      primaryActions={primaryActions}
      suggestedActions={suggestedActions}
      events={events}
      emptyEventsLabel="Movement, NPC chat, and visit results will appear here. Start by visiting the nearest building or asking an NPC what to learn."
      draft={draft}
      inputPlaceholder="Tell ClawVille what to do..."
      canSend={canSend}
      sending={Boolean(sendingCommand)}
      chatInputTestId="clawville-chat-input"
      chatSendTestId="clawville-chat-send"
      noticeTestId="clawville-command-notice"
      variant={variant}
      onDraftChange={setDraft}
      onSendDraft={() => void sendCommand(draft, true)}
      onCommand={(command: string) => void sendCommand(command)}
    />
  );
}

export function ClawvilleTuiView() {
  const { appRuns, setActionNotice, setState } = useApp();
  const run = useMemo(
    () =>
      [...(Array.isArray(appRuns) ? appRuns : [])]
        .filter(
          (candidate) => candidate.appName === "@elizaos/plugin-clawville",
        )
        .sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        )[0] ?? null,
    [appRuns],
  );
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const telemetry =
    run?.session?.telemetry && typeof run.session.telemetry === "object"
      ? (run.session.telemetry as Record<string, unknown>)
      : null;
  const nearestBuilding =
    readString(telemetry, "nearestBuildingLabel") ??
    readString(telemetry, "nearestBuildingId") ??
    "unknown";
  const knowledgeCount = readNumber(telemetry, "knowledgeCount");
  const canSend = Boolean(run?.runId && run.session?.canSendCommands);
  const events = run ? collectRunEvents(run, []) : [];
  const suggestedPrompts = run?.session?.suggestedPrompts ?? [];
  const viewState = {
    viewType: "tui",
    viewId: "clawville",
    appName: "@elizaos/plugin-clawville",
    runId: run?.runId ?? null,
    status: run?.status ?? "idle",
    canSend,
    nearestBuilding,
    knowledgeCount,
    suggestedPromptCount: suggestedPrompts.length,
    eventCount: events.length,
  };

  const sendDraft = async (content: string) => {
    const trimmed = content.trim();
    if (!run?.runId || !trimmed || sending) return;
    setSending(true);
    try {
      const response = await client.sendAppRunMessage(run.runId, trimmed);
      if (response.run) {
        setState("appRuns", replaceRun(appRuns, response.run));
      }
      setActionNotice(
        response.message,
        response.success ? "success" : "error",
        2600,
      );
      setDraft("");
    } catch (error) {
      setActionNotice(
        error instanceof Error ? error.message : "ClawVille command failed.",
        "error",
        3200,
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div data-view-state={JSON.stringify(viewState)} style={tuiRootStyle}>
      <div style={tuiRouteStyle}>elizaos://clawville --type=tui</div>
      <div style={tuiMetaStyle}>
        {run?.status ?? "idle"} | near {nearestBuilding} | {knowledgeCount ?? 0}{" "}
        learned
      </div>
      <section style={tuiPanelStyle} aria-label="ClawVille state">
        <strong style={tuiTitleStyle}>ClawVille</strong>
        <div>run {run?.runId ?? "none"}</div>
        <div>commands {canSend ? "available" : "unavailable"}</div>
        <div>
          objective {run?.session?.goalLabel ?? `Near ${nearestBuilding}`}
        </div>
        <div style={tuiSubtleStyle}>suggested prompts</div>
        {(suggestedPrompts.length
          ? suggestedPrompts
          : PRIMARY_COMMANDS.map((item) => item.command)
        )
          .slice(0, 6)
          .map((prompt: string) => (
            <button
              key={prompt}
              type="button"
              disabled={!canSend || sending}
              onClick={() => void sendDraft(prompt)}
              style={tuiButtonStyle}
            >
              {prompt}
            </button>
          ))}
        <input
          aria-label="ClawVille command"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void sendDraft(draft);
          }}
          placeholder="Tell ClawVille what to do..."
          style={tuiInputStyle}
        />
        <button
          type="button"
          disabled={!canSend || sending || !draft.trim()}
          onClick={() => void sendDraft(draft)}
          style={tuiButtonStyle}
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

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-clawville-state") {
    return {
      viewType: "tui",
      appName: "@elizaos/plugin-clawville",
      primaryCommands: PRIMARY_COMMANDS.map((item) => item.command),
    };
  }
  if (capability === "terminal-clawville-command") {
    const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
    const content =
      typeof params?.content === "string" ? params.content.trim() : "";
    if (!runId) throw new Error("runId is required");
    if (!content) throw new Error("content is required");
    return {
      viewType: "tui",
      command: await client.sendAppRunMessage(runId, content),
    };
  }
  throw new Error(`Unsupported ClawVille TUI capability: ${capability}`);
}
