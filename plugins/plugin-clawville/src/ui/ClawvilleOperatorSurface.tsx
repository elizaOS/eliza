import {
  type AppOperatorSurfaceProps,
  type AppRunSummary,
  client,
  type GameOperatorAction,
  type GameOperatorEvent,
  GameOperatorShell,
  useApp,
} from "@elizaos/ui";
import { useCallback, useMemo, useState } from "react";

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
      (event) =>
        event.kind !== "refresh" &&
        event.kind !== "attach" &&
        event.kind !== "detach",
    )
    .map((event) => ({
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
    run.session?.activity?.map((entry) => ({
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
    (prompt) => ({
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
      onCommand={(command) => void sendCommand(command)}
    />
  );
}
