import {
  type AppOperatorSurfaceProps,
  type AppRunSummary,
  client,
  type GameOperatorAction,
  type GameOperatorEvent,
  GameOperatorShell,
  useApp,
} from "@elizaos/app-core";
import { useCallback, useMemo, useState } from "react";

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
