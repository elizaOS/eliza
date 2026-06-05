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
import { type CSSProperties, useCallback, useMemo, useState } from "react";
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

function ClawvilleReadyCard({
  icon,
  label,
  value,
  tone = "cyan",
}: {
  icon: string;
  label: string;
  value: string;
  tone?: "cyan" | "emerald" | "amber" | "violet";
}) {
  const toneClass = {
    amber: "border-amber-300/35 bg-amber-400/10 text-amber-700",
    cyan: "border-cyan-300/35 bg-cyan-400/10 text-cyan-700",
    emerald: "border-emerald-300/35 bg-emerald-400/10 text-emerald-700",
    violet: "border-violet-300/35 bg-violet-400/10 text-violet-700",
  }[tone];

  return (
    <div className="flex min-h-16 items-center gap-3 rounded-xl border border-border/45 bg-card/78 px-4 py-3 shadow-sm">
      <div
        aria-hidden
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border text-lg ${toneClass}`}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-normal text-muted-strong">
          {label}
        </div>
        <div className="truncate text-sm font-semibold text-foreground">
          {value}
        </div>
      </div>
    </div>
  );
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
        className={variant === "live" ? "p-3" : "p-4"}
        data-testid="clawville-operator-empty"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/45 bg-card/82 px-4 py-3 shadow-sm">
            <div className="flex items-center gap-3">
              <div
                aria-hidden
                className="grid h-10 w-10 place-items-center rounded-xl bg-rose-500 text-xl text-white shadow-sm"
              >
                🦀
              </div>
              <div>
                <div className="text-sm font-semibold text-foreground">
                  ClawVille
                </div>
                <div className="text-[11px] font-semibold uppercase tracking-normal text-muted-strong">
                  game relay ready
                </div>
              </div>
            </div>
            <div className="h-3 w-3 rounded-full bg-amber-400 shadow-[0_0_0_4px_rgba(251,191,36,0.18)]" />
          </div>

          <div className="grid grid-cols-1 gap-3">
            <ClawvilleReadyCard
              icon="🏘"
              label="Map"
              value="Town buildings staged"
              tone="emerald"
            />
            <ClawvilleReadyCard
              icon="💬"
              label="Chat"
              value="Use overlay relay"
              tone="cyan"
            />
            <ClawvilleReadyCard
              icon="⚡"
              label="Commands"
              value={`${PRIMARY_COMMANDS.length} quick actions`}
              tone="amber"
            />
            <ClawvilleReadyCard
              icon="↗"
              label="Path"
              value="/clawville"
              tone="violet"
            />
          </div>
        </div>
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

  return (
    <>
      <ClawvilleOperatorRegistrar
        suggestedPrompts={suggestedPrompts}
        getDraft={() => draft}
        onDraftChange={setDraft}
        onCommand={(command) => void sendCommand(command)}
        onSendDraft={() => void sendCommand(draft, true)}
      />
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

function ClawvilleDraftInputRegistrar({
  getDraft,
  onDraftChange,
}: {
  getDraft: () => string;
  onDraftChange: (value: string) => void;
}) {
  useAgentElement<HTMLInputElement>({
    id: "chat-command-input",
    role: "text-input",
    label: "ClawVille command",
    group: "clawville-chat",
    description: "Type a command to send to ClawVille",
    getValue: getDraft,
    onFill: onDraftChange,
  });
  return null;
}

function ClawvilleSendDraftRegistrar({
  onSendDraft,
}: {
  onSendDraft: () => void;
}) {
  useAgentElement<HTMLButtonElement>({
    id: "chat-send",
    role: "button",
    label: "Send command",
    group: "clawville-chat",
    description: "Send the typed command to ClawVille",
    onActivate: onSendDraft,
  });
  return null;
}

/**
 * Registers the operator surface's interactive controls with the agent surface.
 * The controls themselves are rendered by GameOperatorShell (which does not
 * forward refs), so each control is registered as a callback-driven element
 * wired to the same handlers the shell invokes.
 */
function ClawvilleOperatorRegistrar({
  suggestedPrompts,
  getDraft,
  onDraftChange,
  onCommand,
  onSendDraft,
}: {
  suggestedPrompts: string[];
  getDraft: () => string;
  onDraftChange: (value: string) => void;
  onCommand: (command: string) => void;
  onSendDraft: () => void;
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
      <ClawvilleDraftInputRegistrar
        getDraft={getDraft}
        onDraftChange={onDraftChange}
      />
      <ClawvilleSendDraftRegistrar onSendDraft={onSendDraft} />
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
