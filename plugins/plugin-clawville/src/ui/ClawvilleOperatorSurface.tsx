import {
  type AppOperatorSurfaceProps,
  type AppRunSummary,
  client,
  type GameOperatorAction,
  type GameOperatorEvent,
  GameOperatorShell,
  useApp,
} from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";
import { PRIMARY_COMMANDS } from "./ClawvilleOperatorSurface.helpers";

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
  // Matches @elizaos/ui AppSessionActivityItem.timestamp (epoch ms), the type
  // of the run.session.activity entries this annotates.
  timestamp?: number | null;
};

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

const CLAWVILLE_HERO_URL = "/api/views/clawville/hero";
const CLAWVILLE_ACCENT = "#ff5800";

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

type ChipState = "live" | "attention" | "idle";

const CHIP_DOT_COLOR: Record<ChipState, string> = {
  live: "#22c55e",
  attention: CLAWVILLE_ACCENT,
  idle: "rgba(125,125,125,0.55)",
};

function HeroStatusChip({
  state,
  label,
}: {
  state: ChipState;
  label: string;
}) {
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
        backgroundImage: `url(${CLAWVILLE_HERO_URL})`,
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
              background: CLAWVILLE_ACCENT,
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

function ClawvilleWaitingZone() {
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
        <div style={{ fontSize: 30, opacity: 0.85 }}>🦀</div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          Waiting for a ClawVille session
        </div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          Launch the game to drop the agent into the reef.
        </div>
      </div>
    </div>
  );
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
  const canSend = Boolean(run?.runId && run.session?.canSendCommands);

  const sendCommand = useCallback(
    async (content: string) => {
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
      <section data-testid="clawville-operator-empty">
        <HeroFrame variant={variant}>
          <HeroHeader
            title="ClawVille"
            state="idle"
            statusText="Game relay ready"
          />
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
            }}
          >
            <StatusStripCard
              icon="🏘"
              label="Map"
              value="Town staged"
              state="live"
            />
            <StatusStripCard
              icon="💬"
              label="Chat"
              value="Overlay relay"
              state="idle"
            />
            <StatusStripCard
              icon="⚡"
              label="Commands"
              value={`${PRIMARY_COMMANDS.length} quick actions`}
              state="attention"
            />
          </div>
          <ClawvilleWaitingZone />
        </HeroFrame>
      </section>
    );
  }

  const primaryActions: GameOperatorAction[] = PRIMARY_COMMANDS.map((item) => ({
    ...item,
  }));
  const suggestedPrompts = (run.session?.suggestedPrompts ?? []).slice(0, 2);
  const suggestedActions = suggestedPrompts.map((prompt: string) => ({
    id: prompt,
    label: prompt,
    command: prompt,
    testId: "clawville-suggested-command",
  }));
  const events = collectRunEvents(run, localEvents).slice(0, 3);

  const heroState = statusTone(run.status);
  return (
    <>
      <ClawvilleOperatorRegistrar
        suggestedPrompts={suggestedPrompts}
        onCommand={(command) => void sendCommand(command)}
      />
      <HeroFrame variant={variant}>
        <HeroHeader
          title="ClawVille"
          state={heroState}
          statusText={statusLabel(run.status)}
          cta={
            canSend
              ? {
                  label: "Visit nearest",
                  onClick: () =>
                    void sendCommand(PRIMARY_COMMANDS[0].command),
                  disabled: Boolean(sendingCommand),
                }
              : null
          }
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <StatusStripCard
            icon="📍"
            label="Location"
            value={nearestBuilding}
            state="live"
          />
          <StatusStripCard
            icon="⚡"
            label="Relay"
            value={canSend ? "Ready" : "Syncing"}
            state={canSend ? "live" : "attention"}
          />
          <StatusStripCard
            icon="🎯"
            label="Goal"
            value={run.session?.goalLabel ?? `Near ${nearestBuilding}`}
            state="idle"
          />
        </div>
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
          detailItems={[{ label: "Location", value: nearestBuilding }]}
          primaryActions={primaryActions}
          suggestedActions={suggestedActions}
          events={events}
          emptyEventsLabel="No events yet."
          canSend={canSend}
          sending={Boolean(sendingCommand)}
          noticeTestId="clawville-command-notice"
          variant={variant}
          onCommand={(command: string) => void sendCommand(command)}
        />
      </HeroFrame>
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

function ClawvillePrimaryCommandRegistrar({
  id,
  label,
  command,
  onCommand,
}: {
  id: string;
  label: string;
  command: string;
  onCommand: (command: string) => void;
}) {
  useAgentElement<HTMLButtonElement>({
    id: `command-${id}`,
    role: "button",
    label,
    group: "clawville-primary-commands",
    description: `Send the ClawVille command: ${command}`,
    onActivate: () => onCommand(command),
  });
  return null;
}

function ClawvilleSuggestedCommandRegistrar({
  prompt,
  index,
  onCommand,
}: {
  prompt: string;
  index: number;
  onCommand: (command: string) => void;
}) {
  useAgentElement<HTMLButtonElement>({
    id: `suggested-command-${slugifyPrompt(prompt, index)}`,
    role: "button",
    label: prompt,
    group: "clawville-suggested-commands",
    description: `Send the suggested ClawVille command: ${prompt}`,
    onActivate: () => onCommand(prompt),
  });
  return null;
}

/**
 * Registers the operator surface's interactive controls with the agent surface.
 * The controls themselves are rendered by GameOperatorShell (which does not
 * forward refs), so each visible action is registered as a callback-driven
 * element wired to the same handlers the shell invokes.
 */
function ClawvilleOperatorRegistrar({
  suggestedPrompts,
  onCommand,
}: {
  suggestedPrompts: string[];
  onCommand: (command: string) => void;
}) {
  return (
    <>
      {PRIMARY_COMMANDS.map((item) => (
        <ClawvillePrimaryCommandRegistrar
          key={item.id}
          id={item.id}
          label={item.label}
          command={item.command}
          onCommand={onCommand}
        />
      ))}
      {suggestedPrompts.map((prompt, index) => (
        <ClawvilleSuggestedCommandRegistrar
          key={prompt}
          prompt={prompt}
          index={index}
          onCommand={onCommand}
        />
      ))}
    </>
  );
}

function ClawvilleSuggestedPromptButton({
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
    group: "clawville-suggested-prompts",
    description: `Send the ClawVille command: ${prompt}`,
  });
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={() => onSelect(prompt)}
      style={tuiButtonStyle}
      {...agentProps}
    >
      {prompt}
    </button>
  );
}

function ClawvilleCommandInput({
  draft,
  onDraftChange,
  onSubmit,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: "command-input",
    role: "text-input",
    label: "ClawVille command",
    group: "clawville-command",
    description: "Type a command to send to ClawVille",
  });
  return (
    <input
      ref={ref}
      aria-label="ClawVille command"
      value={draft}
      onChange={(event) => onDraftChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSubmit();
      }}
      placeholder="Tell ClawVille what to do..."
      style={tuiInputStyle}
      {...agentProps}
    />
  );
}

function ClawvilleSendButton({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "send-command",
    role: "button",
    label: "Send command",
    group: "clawville-command",
    description: "Send the typed command to ClawVille",
  });
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onSend}
      style={tuiButtonStyle}
      {...agentProps}
    >
      send command
    </button>
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
          .map((prompt: string, index: number) => (
            <ClawvilleSuggestedPromptButton
              key={prompt}
              prompt={prompt}
              index={index}
              disabled={!canSend || sending}
              onSelect={(value) => void sendDraft(value)}
            />
          ))}
        <ClawvilleCommandInput
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={() => void sendDraft(draft)}
        />
        <ClawvilleSendButton
          disabled={!canSend || sending || !draft.trim()}
          onSend={() => void sendDraft(draft)}
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
