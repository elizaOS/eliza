import {
  type AppOperatorSurfaceProps,
  type AppRunSummary,
  client,
  type GameOperatorAction,
  type GameOperatorEvent,
  GameOperatorShell,
  useApp,
} from "@elizaos/app-core/ui-compat";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";

const DEFENSE_HERO_URL = "/api/views/defense-of-the-agents/hero";
const DEFENSE_ACCENT = "#ff5800";

type ChipState = "live" | "attention" | "idle";

const CHIP_DOT_COLOR: Record<ChipState, string> = {
  live: "#22c55e",
  attention: DEFENSE_ACCENT,
  idle: "rgba(125,125,125,0.55)",
};

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
        backgroundImage: `url(${DEFENSE_HERO_URL})`,
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
              background: DEFENSE_ACCENT,
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

function DefenseWaitingZone() {
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
        <div style={{ fontSize: 30, opacity: 0.85 }}>🛡</div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          Waiting for a match
        </div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          Launch Defense to deploy the agent's hero into a lane.
        </div>
      </div>
    </div>
  );
}

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
    async (content: string) => {
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
      <section data-testid="defense-operator-empty">
        <HeroFrame variant={variant}>
          <HeroHeader
            title="Defense of the Agents"
            state="idle"
            statusText="Tactical surface ready"
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <StatusStripCard
              icon="🛡"
              label="Hero"
              value="Deploys on launch"
              state="live"
            />
            <StatusStripCard
              icon="⚔"
              label="Tactics"
              value="Move · recall · reinforce"
              state="attention"
            />
            <StatusStripCard
              icon="▶"
              label="Autoplay"
              value="Toggle in session"
              state="idle"
            />
          </div>
          <DefenseWaitingZone />
        </HeroFrame>
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
    {
      id: `lane-${heroLane ?? "mid"}`,
      label: heroLane ? `Move ${heroLane}` : "Deploy mid",
      command: heroLane
        ? `Move to ${heroLane} lane`
        : `Deploy as ${heroClass} in mid lane`,
      active: Boolean(heroLane),
      testId: `defense-command-lane-${heroLane ?? "mid"}`,
    },
  ];

  const suggestedActions = tacticalPrompts.slice(0, 2).map((prompt) => ({
    id: prompt,
    label: prompt,
    command: prompt,
    testId: "defense-suggested-command",
  }));

  const events = collectRunEvents(run, telemetry, localEvents).slice(0, 3);

  const heroState = statusTone(run.status);
  const recallAction = primaryActions.find((action) => action.id === "recall");
  return (
    <>
      <DefenseOperatorRegistrar
        primaryActions={primaryActions}
        suggestedActions={suggestedActions}
        onCommand={(command) => void sendCommand(command)}
      />
      <HeroFrame variant={variant}>
        <HeroHeader
          title="Defense of the Agents"
          state={heroState}
          statusText={statusLabel(run.status)}
          cta={
            canSend && recallAction
              ? {
                  label: recallAction.label,
                  onClick: () => void sendCommand(recallAction.command),
                  disabled: Boolean(sendingCommand),
                }
              : null
          }
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <StatusStripCard
            icon="🛡"
            label="Hero"
            value={formatHeroLine(telemetry)}
            state="live"
          />
          <StatusStripCard
            icon="▶"
            label="Mode"
            value={autoPlay ? "Autoplay" : "Manual"}
            state={autoPlay ? "live" : "idle"}
          />
          <StatusStripCard
            icon="⚡"
            label="Relay"
            value={canSend ? "Ready" : "Syncing"}
            state={canSend ? "live" : "attention"}
          />
        </div>
        <GameOperatorShell
          surfaceTestId={
            variant === "live"
              ? "defense-live-operator-surface"
              : "defense-detail-operator-surface"
          }
          title="Defense command"
          statusLabel={statusLabel(run.status)}
          statusTone={statusTone(run.status)}
          objective={run.session?.goalLabel ?? run.summary}
          detailItems={[
            { label: "Hero", value: formatHeroLine(telemetry) },
            { label: "Mode", value: autoPlay ? "Autoplay" : "Manual" },
          ]}
          primaryActions={primaryActions}
          suggestedActions={suggestedActions}
          events={events}
          emptyEventsLabel="No match events yet."
          canSend={canSend}
          sending={Boolean(sendingCommand)}
          noticeTestId="defense-command-notice"
          variant={variant}
          onCommand={(command) => void sendCommand(command)}
        />
      </HeroFrame>
    </>
  );
}

function primaryActionRole(id: string): "toggle" | "tab" | "button" {
  if (id === "autoplay") return "toggle";
  if (id.startsWith("lane-")) return "tab";
  return "button";
}

function DefensePrimaryActionRegistrar({
  action,
  onCommand,
}: {
  action: GameOperatorAction;
  onCommand: (command: string) => void;
}) {
  const role = primaryActionRole(action.id);
  useAgentElement<HTMLButtonElement>({
    id: `command-${action.id}`,
    role,
    label: action.label,
    group: "defense-primary-commands",
    description: `Send the Defense command: ${action.command}`,
    status:
      role === "toggle" || role === "tab"
        ? action.active
          ? "active"
          : "inactive"
        : undefined,
    onActivate: () => onCommand(action.command),
  });
  return null;
}

function DefenseSuggestedActionRegistrar({
  action,
  index,
  onCommand,
}: {
  action: GameOperatorAction;
  index: number;
  onCommand: (command: string) => void;
}) {
  useAgentElement<HTMLButtonElement>({
    id: `suggested-command-${slugifyPrompt(action.command, index)}`,
    role: "button",
    label: action.label,
    group: "defense-suggested-commands",
    description: `Send the suggested Defense command: ${action.command}`,
    onActivate: () => onCommand(action.command),
  });
  return null;
}

/**
 * Registers the operator surface's interactive controls with the agent surface.
 * GameOperatorShell renders these controls and does not forward refs, so each is
 * registered as a callback-driven element wired to the same handlers the shell
 * invokes (primary lane/recall/autoplay commands and suggested commands).
 */
function DefenseOperatorRegistrar({
  primaryActions,
  suggestedActions,
  onCommand,
}: {
  primaryActions: GameOperatorAction[];
  suggestedActions: GameOperatorAction[];
  onCommand: (command: string) => void;
}) {
  return (
    <>
      {primaryActions.map((action) => (
        <DefensePrimaryActionRegistrar
          key={action.id}
          action={action}
          onCommand={onCommand}
        />
      ))}
      {suggestedActions.map((action, index) => (
        <DefenseSuggestedActionRegistrar
          key={action.id}
          action={action}
          index={index}
          onCommand={onCommand}
        />
      ))}
    </>
  );
}

function slugifyPrompt(prompt: string, index: number): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug ? `${slug}-${index}` : `prompt-${index}`;
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
    id: `prompt-${prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}`,
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
