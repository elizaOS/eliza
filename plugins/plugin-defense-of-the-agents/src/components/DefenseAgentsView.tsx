/**
 * DefenseAgentsView — the single GUI/XR data wrapper for the Defense of the
 * Agents operator surface.
 *
 * It owns the live run data (resolve the latest run for the app, derive the hero
 * telemetry + tactical prompts + event log, dispatch lane/recall/autoplay and
 * free-text commands through the app-run client) and renders the one
 * presentational {@link DefenseAgentsSpatialView} inside a {@link SpatialSurface}.
 * Omitting the `modality` prop lets `SpatialSurface` auto-detect GUI vs XR via
 * `window.__elizaXRContext`, so the SAME component serves both surfaces. The TUI
 * surface renders the same `DefenseAgentsSpatialView` through the terminal
 * registry (see `register-terminal-view.tsx`).
 *
 * This is the operator control panel (status + command shell), NOT the embedded
 * game viewer — that is served separately via the
 * `/api/apps/defense-of-the-agents/viewer` iframe route. The game registry's
 * `DefenseAgentsOperatorSurface` (in `../ui`) renders the same live data through
 * the hosted-game shell; both derive their state with the same telemetry parsing.
 */

import {
  type AppRunSummary,
  client,
  useAppSelectorShallow,
} from "@elizaos/app-core/ui-compat";
import { SpatialSurface } from "@elizaos/ui/spatial";
import { useCallback, useMemo, useState } from "react";
import {
  DefenseAgentsSpatialView,
  type DefenseEventRow,
  type DefenseEventTone,
  type DefenseLane,
  type DefenseSnapshot,
} from "./DefenseAgentsSpatialView.tsx";

const DEFENSE_APP_NAME = "@elizaos/plugin-defense-of-the-agents";

const LANES: readonly DefenseLane[] = ["top", "mid", "bot"];

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

function readLane(source: Record<string, unknown> | null): DefenseLane | null {
  const value = readString(source, "heroLane");
  return value && (LANES as readonly string[]).includes(value)
    ? (value as DefenseLane)
    : null;
}

/** Tactical prompts the operator surface relays (auto-play prompts excluded). */
function isRelevantPrompt(prompt: string): boolean {
  return (
    /^learn\s+/i.test(prompt) ||
    /^reinforce\s+/i.test(prompt) ||
    /^move\s+to\s+/i.test(prompt) ||
    /^recall/i.test(prompt) ||
    /^review strategy$/i.test(prompt)
  );
}

/** Rewrite rate-limit / unavailable relay messages into friendly text. */
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

function eventTone(severity?: string): DefenseEventTone {
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  return "info";
}

/** Server + activity + telemetry + optimistic local events, control noise filtered. */
function collectEvents(
  run: AppRunSummary,
  telemetry: Record<string, unknown> | null,
  localEvents: DefenseEventRow[],
): DefenseEventRow[] {
  const serverEvents: DefenseEventRow[] = (run.recentEvents ?? [])
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
      tone: eventTone(event.severity),
    }));

  const activityEvents: DefenseEventRow[] =
    run.session?.activity?.map((entry) => ({
      id: entry.id,
      label: entry.type,
      message: cleanDefenseMessage(entry.message),
      tone: eventTone(entry.severity),
    })) ?? [];

  const recentActivity: DefenseEventRow[] = Array.isArray(
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
        }))
    : [];

  return [
    ...serverEvents,
    ...activityEvents,
    ...recentActivity,
    ...localEvents,
  ];
}

function localEventId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The command string each spatial command-button id sends to the run. */
function commandFor(action: string, snapshot: DefenseSnapshot): string | null {
  if (action === "autoplay") {
    return snapshot.autoPlay ? "Auto-play OFF" : "Auto-play ON";
  }
  if (action === "recall") return "Recall to base";
  if (action.startsWith("lane:")) {
    return `Move to ${action.slice("lane:".length)} lane`;
  }
  if (action.startsWith("prompt:")) return action.slice("prompt:".length);
  return null;
}

export function DefenseAgentsView() {
  const { appRuns, setState } = useAppSelectorShallow((s) => ({
    appRuns: s.appRuns,
    setState: s.setState,
  }));
  const run = useMemo(
    () =>
      [...(Array.isArray(appRuns) ? appRuns : [])]
        .filter((candidate) => candidate.appName === DEFENSE_APP_NAME)
        .sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        )[0] ?? null,
    [appRuns],
  );

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [localEvents, setLocalEvents] = useState<DefenseEventRow[]>([]);

  const snapshot: DefenseSnapshot = useMemo(() => {
    const telemetry =
      run?.session?.telemetry && typeof run.session.telemetry === "object"
        ? (run.session.telemetry as Record<string, unknown>)
        : null;
    const suggestedPrompts = (run?.session?.suggestedPrompts ?? [])
      .filter(isRelevantPrompt)
      .filter((prompt) => !/^auto[- ]?play/i.test(prompt));
    const events = run ? collectEvents(run, telemetry, localEvents) : [];
    return {
      status: run?.status ?? "idle",
      runId: run?.runId ?? null,
      canSendCommands: Boolean(run?.session?.canSendCommands),
      heroClass: readString(telemetry, "heroClass"),
      heroLane: readLane(telemetry),
      heroLevel: readNumber(telemetry, "heroLevel"),
      heroHp: readNumber(telemetry, "heroHp"),
      heroMaxHp: readNumber(telemetry, "heroMaxHp"),
      autoPlay: telemetry?.autoPlay === true,
      goalLabel: run?.session?.goalLabel ?? null,
      suggestedPrompts,
      events,
      draft,
      sending,
    };
  }, [run, localEvents, draft, sending]);

  const sendCommand = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!run?.runId || !trimmed || sending) return;

      setSending(true);
      setLocalEvents((current) => [
        ...current,
        {
          id: localEventId("defense-user"),
          label: "You",
          message: trimmed,
          tone: "info",
        },
      ]);

      try {
        const response = await client.sendAppRunMessage(run.runId, trimmed);
        const persistedSession =
          response.run?.session ?? response.session ?? null;
        if (response.run) {
          const nextRun = response.run;
          setState(
            "appRuns",
            [
              ...appRuns.filter(
                (candidate) => candidate.runId !== nextRun.runId,
              ),
              nextRun,
            ].sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt),
            ),
          );
        }
        if (persistedSession) {
          setLocalEvents([]);
        } else {
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
            },
          ]);
        }
        setDraft("");
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
          },
        ]);
      } finally {
        setSending(false);
      }
    },
    [appRuns, run?.runId, sending, setState],
  );

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("command-draft:")) {
        setDraft(action.slice("command-draft:".length));
        return;
      }
      if (action === "send-command") {
        void sendCommand(draft);
        return;
      }
      const command = commandFor(action, snapshot);
      if (command) void sendCommand(command);
    },
    [draft, sendCommand, snapshot],
  );

  return (
    <SpatialSurface>
      <DefenseAgentsSpatialView snapshot={snapshot} onAction={onAction} />
    </SpatialSurface>
  );
}
