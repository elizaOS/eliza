import {
  type AppOperatorSurfaceProps,
  type AppRunSummary,
  client,
  type GameOperatorAction,
  type GameOperatorEvent,
  GameOperatorShell,
  useApp,
} from "@elizaos/app-core/ui-compat";
import { useAgentElement } from "@elizaos/ui";
import { type CSSProperties, useCallback, useMemo, useState } from "react";

const LANES = ["top", "mid", "bot"] as const;

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

function formatHeroClass(value: string | null): string {
  if (!value) return "Not deployed";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatHeroLine(telemetry: Record<string, unknown> | null): string {
  const heroClass = formatHeroClass(readString(telemetry, "heroClass"));
  const lane = readString(telemetry, "heroLane");
  const level = readNumber(telemetry, "heroLevel");
  const hp = readNumber(telemetry, "heroHp");
  const maxHp = readNumber(telemetry, "heroMaxHp");
  const hpLabel = hp !== null && maxHp !== null ? `, ${hp}/${maxHp} HP` : "";
  const laneLabel = lane ? ` ${lane}` : "";
  const levelLabel = level !== null ? ` Lv${level}` : "";
  return `${heroClass}${levelLabel}${laneLabel}${hpLabel}`;
}

function isLearnPrompt(prompt: string): boolean {
  return /^learn\s+/i.test(prompt);
}

function isRelevantPrompt(prompt: string): boolean {
  return (
    isLearnPrompt(prompt) ||
    /^reinforce\s+/i.test(prompt) ||
    /^move\s+to\s+/i.test(prompt) ||
    /^recall/i.test(prompt) ||
    /^review strategy$/i.test(prompt)
  );
}

function statusLabel(status: string): string {
  if (status === "running" || status === "ready") return "Live";
  if (status === "degraded" || status === "failed") return "Needs attention";
  if (status === "respawning") return "Respawning";
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

function cleanDefenseMessage(message: string): string {
  if (message.includes("Too many requests") || message.includes("(429)")) {
    return "Defense controls are rate-limited right now. Try again shortly.";
  }
  if (message.includes("Failed to fetch game state")) {
    return "Defense state is temporarily unavailable. Retrying automatically.";
  }
  if (message.startsWith("Defense control API unavailable")) {
    return "Defense controls are temporarily unavailable.";
  }
  return message;
}

function collectRunEvents(
  run: AppRunSummary,
  telemetry: Record<string, unknown> | null,
  localEvents: GameOperatorEvent[],
): GameOperatorEvent[] {
  const serverEvents = (run.recentEvents ?? [])
    .filter(
      (event) =>
        event.kind !== "refresh" &&
        event.kind !== "attach" &&
        event.kind !== "detach",
    )
    .map((event) => ({
      id: event.eventId,
      label: event.kind,
      message: cleanDefenseMessage(event.message),
      tone:
        event.severity === "error"
          ? "error"
          : event.severity === "warning"
            ? "warning"
            : "info",
      timestamp: event.createdAt,
    })) satisfies GameOperatorEvent[];

  const activityEvents: GameOperatorEvent[] =
    run.session?.activity?.map((entry) => ({
      id: entry.id,
      label: entry.type,
      message: cleanDefenseMessage(entry.message),
      tone:
        entry.severity === "error"
          ? "error"
          : entry.severity === "warning"
            ? "warning"
            : "info",
      timestamp: entry.timestamp ?? null,
    })) ?? [];

  const recentActivity: GameOperatorEvent[] = Array.isArray(
    telemetry?.recentActivity,
  )
    ? (
        telemetry.recentActivity as Array<{
          ts?: number;
          action?: string;
          detail?: string;
        }>
      )
        .filter(
          (entry) =>
            typeof entry.detail === "string" && entry.detail.trim().length > 0,
        )
        .map((entry, index) => ({
          id: `defense-telemetry-${entry.ts ?? index}-${index}`,
          label: entry.action ?? "game",
          message: cleanDefenseMessage(entry.detail ?? ""),
          tone: entry.action === "error" ? "error" : "info",
          timestamp: entry.ts ?? null,
        }))
    : [];

  return [
    ...serverEvents,
    ...activityEvents,
    ...recentActivity,
    ...localEvents,
  ];
}

export function DefenseAgentsOperatorSurface({
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
  const heroLane = readString(telemetry, "heroLane");
  const heroClass = readString(telemetry, "heroClass") ?? "mage";
  const autoPlay = telemetry?.autoPlay === true;
  const canSend = Boolean(run?.runId && run.session?.canSendCommands);
  const tacticalPrompts = (run?.session?.suggestedPrompts ?? [])
    .filter(isRelevantPrompt)
    .filter((prompt) => !/^auto[- ]?play/i.test(prompt));

  const sendCommand = useCallback(
    async (content: string, clearDraftOnSuccess = false) => {
      const trimmed = content.trim();
      if (!run?.runId || !trimmed || sendingCommand) return;

      setSendingCommand(trimmed);
      setLocalEvents((current) => [
        ...current,
        {
          id: localEventId("defense-user"),
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
            id: localEventId("defense-game"),
            label: response.disposition === "queued" ? "Queued" : "Defense",
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
            id: localEventId("defense-error"),
            label: "Error",
            message:
              error instanceof Error
                ? error.message
                : "Defense command failed.",
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
        data-testid="defense-operator-empty"
      >
        <div className="rounded-2xl border border-border/35 bg-card/74 p-4 text-xs text-muted-strong">
          Launch Defense of the Agents to open game chat.
        </div>
      </section>
    );
  }

  const primaryActions: GameOperatorAction[] = [
    {
      id: "autoplay",
      label: autoPlay ? "Autoplay on" : "Autoplay off",
      command: autoPlay ? "Auto-play OFF" : "Auto-play ON",
      active: autoPlay,
      testId: "defense-command-autoplay",
    },
    {
      id: "recall",
      label: "Recall",
      command: "Recall to base",
      testId: "defense-command-recall",
    },
    ...LANES.map((lane) => ({
      id: `lane-${lane}`,
      label: heroLane ? `Move ${lane}` : `Deploy ${lane}`,
      command: heroLane
        ? `Move to ${lane} lane`
        : `Deploy as ${heroClass} in ${lane} lane`,
      active: heroLane === lane,
      testId: `defense-command-lane-${lane}`,
    })),
  ];

  const suggestedActions = tacticalPrompts.map((prompt) => ({
    id: prompt,
    label: prompt,
    command: prompt,
    testId: "defense-suggested-command",
  }));

  const events = collectRunEvents(run, telemetry, localEvents);

  return (
    <GameOperatorShell
      surfaceTestId={
        variant === "live"
          ? "defense-live-operator-surface"
          : "defense-detail-operator-surface"
      }
      title="Defense command"
      statusLabel={statusLabel(run.status)}
      statusTone={statusTone(run.status)}
      objective={run.session?.goalLabel ?? run.session?.summary ?? run.summary}
      detailItems={[
        { label: "Hero", value: formatHeroLine(telemetry) },
        { label: "Mode", value: autoPlay ? "Autoplay" : "Manual" },
      ]}
      primaryActions={primaryActions}
      suggestedActions={suggestedActions}
      events={events}
      emptyEventsLabel="Commands and match events will appear here. Start with a lane move, recall, or a strategy note."
      draft={draft}
      inputPlaceholder="Command the hero..."
      canSend={canSend}
      sending={Boolean(sendingCommand)}
      chatInputTestId="defense-chat-input"
      chatSendTestId="defense-chat-send"
      noticeTestId="defense-command-notice"
      variant={variant}
      onDraftChange={setDraft}
      onSendDraft={() => void sendCommand(draft, true)}
      onCommand={(command) => void sendCommand(command)}
    />
  );
}

function DefenseTacticalPromptButton({
  prompt,
  disabled,
  onSend,
}: {
  prompt: string;
  disabled: boolean;
  onSend: (prompt: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `prompt-${prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
    role: "button",
    label: prompt,
    group: "defense-tactical-prompts",
    description: `Send the "${prompt}" command to the hero`,
  });
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={() => onSend(prompt)}
      style={tuiButtonStyle}
      aria-label={prompt}
      {...agentProps}
    >
      {prompt}
    </button>
  );
}

function DefenseCommandInput({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: "input-command",
    role: "text-input",
    label: "Defense command",
    group: "defense-command",
    description: "Type a command for the hero, then send it",
  });
  return (
    <input
      ref={ref}
      aria-label="Defense command"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSubmit();
      }}
      placeholder="Command the hero..."
      style={tuiInputStyle}
      {...agentProps}
    />
  );
}

function DefenseSendCommandButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "action-send-command",
    role: "button",
    label: "Send command",
    group: "defense-command",
    description: "Send the typed command to the hero",
  });
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={tuiButtonStyle}
      aria-label="Send command"
      {...agentProps}
    >
      send command
    </button>
  );
}

export function DefenseAgentsTuiView() {
  const { appRuns, setActionNotice, setState } = useApp();
  const run = useMemo(
    () =>
      [...(Array.isArray(appRuns) ? appRuns : [])]
        .filter(
          (candidate) =>
            candidate.appName === "@elizaos/plugin-defense-of-the-agents",
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
  const heroLine = formatHeroLine(telemetry);
  const heroLane = readString(telemetry, "heroLane");
  const autoPlay = telemetry?.autoPlay === true;
  const canSend = Boolean(run?.runId && run.session?.canSendCommands);
  const tacticalPrompts = (run?.session?.suggestedPrompts ?? [])
    .filter(isRelevantPrompt)
    .filter((prompt) => !/^auto[- ]?play/i.test(prompt));
  const events = run ? collectRunEvents(run, telemetry, []) : [];
  const viewState = {
    viewType: "tui",
    viewId: "defense-of-the-agents",
    appName: "@elizaos/plugin-defense-of-the-agents",
    runId: run?.runId ?? null,
    status: run?.status ?? "idle",
    canSend,
    heroLine,
    heroLane,
    autoPlay,
    tacticalPromptCount: tacticalPrompts.length,
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
        error instanceof Error ? error.message : "Defense command failed.",
        "error",
        3200,
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div data-view-state={JSON.stringify(viewState)} style={tuiRootStyle}>
      <div style={tuiRouteStyle}>
        elizaos://defense-of-the-agents --type=tui
      </div>
      <div style={tuiMetaStyle}>
        {run?.status ?? "idle"} | {heroLine} | autoplay{" "}
        {autoPlay ? "on" : "off"}
      </div>
      <section style={tuiPanelStyle} aria-label="Defense of the Agents state">
        <strong style={tuiTitleStyle}>Defense of the Agents</strong>
        <div>run {run?.runId ?? "none"}</div>
        <div>commands {canSend ? "available" : "unavailable"}</div>
        <div>lane {heroLane ?? "unassigned"}</div>
        <div style={tuiSubtleStyle}>tactical prompts</div>
        {(tacticalPrompts.length
          ? tacticalPrompts
          : ["review strategy", "move to mid", "recall"]
        )
          .slice(0, 6)
          .map((prompt) => (
            <DefenseTacticalPromptButton
              key={prompt}
              prompt={prompt}
              disabled={!canSend || sending}
              onSend={(value) => void sendDraft(value)}
            />
          ))}
        <DefenseCommandInput
          value={draft}
          onChange={setDraft}
          onSubmit={() => void sendDraft(draft)}
        />
        <DefenseSendCommandButton
          disabled={!canSend || sending || !draft.trim()}
          onClick={() => void sendDraft(draft)}
        />
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
  if (capability === "terminal-defense-state") {
    return {
      viewType: "tui",
      appName: "@elizaos/plugin-defense-of-the-agents",
      lanes: [...LANES],
      primaryCommands: [
        "review strategy",
        "move to top",
        "move to mid",
        "move to bot",
        "recall",
      ],
    };
  }
  if (capability === "terminal-defense-command") {
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
  throw new Error(`Unsupported Defense TUI capability: ${capability}`);
}
