/**
 * ClawvilleView — the single GUI/XR data wrapper for the ClawVille operator
 * surface.
 *
 * It owns the live ClawVille run data (resolve the latest run for the app, build
 * the snapshot, dispatch quick-action and free-text commands through the app-run
 * client) and renders the one presentational {@link ClawvilleSpatialView} inside
 * a {@link SpatialSurface}. Omitting the `modality` prop lets `SpatialSurface`
 * auto-detect GUI vs XR via `window.__elizaXRContext`, so the SAME component
 * serves both surfaces. The TUI surface renders the same `ClawvilleSpatialView`
 * through the terminal registry (see `register-terminal-view.tsx`).
 *
 * This is the operator control panel (status + command shell), NOT the embedded
 * 3D game viewer — that is served separately via the `/api/apps/clawville/viewer`
 * iframe route.
 */

import {
  type AppRunSummary,
  client,
  type GameOperatorAction,
  type GameOperatorEvent,
} from "@elizaos/ui";
import { useAppSelector } from "@elizaos/ui/state";
import { SpatialSurface } from "@elizaos/ui/spatial";
import { useCallback, useMemo, useState } from "react";
import { PRIMARY_COMMANDS } from "../ui/ClawvilleOperatorSurface.helpers.ts";
import {
  type ClawvilleSnapshot,
  ClawvilleSpatialView,
  toClawvilleSnapshot,
} from "./ClawvilleSpatialView.tsx";

const CLAWVILLE_APP_NAME = "@elizaos/plugin-clawville";

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
  timestamp?: number | null;
};

function formatBuildingId(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Rewrite the terse "Too far from <id>" relay message into a friendly label. */
function cleanClawvilleMessage(message: string): string {
  const tooFar = message.match(/^Too far from ([a-z0-9-]+)/i);
  if (tooFar?.[1]) {
    return `Too far from ${formatBuildingId(tooFar[1])}. Move closer before visiting.`;
  }
  return message;
}

function localEventId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function replaceRun(
  appRuns: AppRunSummary[],
  nextRun: AppRunSummary,
): AppRunSummary[] {
  return [
    ...appRuns.filter((candidate) => candidate.runId !== nextRun.runId),
    nextRun,
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

const eventTone = (severity?: string): GameOperatorEvent["tone"] =>
  severity === "error" ? "error" : severity === "warning" ? "warning" : "info";

/** Server + activity + optimistic local events, refresh/attach/detach filtered. */
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
      tone: eventTone(event.severity),
      timestamp: event.createdAt,
    }));

  const activityEvents: GameOperatorEvent[] =
    run.session?.activity?.map((entry: RunActivitySummary) => ({
      id: entry.id,
      label: entry.type,
      message: cleanClawvilleMessage(entry.message),
      tone: eventTone(entry.severity),
      timestamp: entry.timestamp ?? null,
    })) ?? [];

  return [...serverEvents, ...activityEvents, ...localEvents];
}

/** Quick actions = PRIMARY_COMMANDS followed by the first two suggested prompts. */
function buildActions(run: AppRunSummary | null): GameOperatorAction[] {
  const primary: GameOperatorAction[] = PRIMARY_COMMANDS.map((item) => ({
    ...item,
  }));
  const suggested: GameOperatorAction[] = (run?.session?.suggestedPrompts ?? [])
    .slice(0, 2)
    .map((prompt: string) => ({
      id: prompt,
      label: prompt,
      command: prompt,
      testId: "clawville-suggested-command",
    }));
  return [...primary, ...suggested];
}

export function ClawvilleView() {
  const appRuns = useAppSelector((s) => s.appRuns);
  const setState = useAppSelector((s) => s.setState);
  const run = useMemo(
    () =>
      [...(Array.isArray(appRuns) ? appRuns : [])]
        .filter((candidate) => candidate.appName === CLAWVILLE_APP_NAME)
        .sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        )[0] ?? null,
    [appRuns],
  );

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [localEvents, setLocalEvents] = useState<GameOperatorEvent[]>([]);

  const sendCommand = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!run?.runId || !trimmed || sending) return;

      setSending(true);
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
        if (response.run) {
          setState("appRuns", replaceRun(appRuns, response.run));
        }
        const persistedSession = response.run?.session ?? response.session;
        if (persistedSession) {
          setLocalEvents([]);
        } else {
          setLocalEvents((current) => [
            ...current,
            {
              id: localEventId("clawville-game"),
              label:
                response.disposition === "queued" ? "Queued" : "ClawVille",
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
        }
        setDraft("");
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
      void sendCommand(action);
    },
    [draft, sendCommand],
  );

  const snapshot: ClawvilleSnapshot = useMemo(() => {
    const events = run ? collectRunEvents(run, localEvents).slice(-6) : [];
    const base = toClawvilleSnapshot(run, events, buildActions(run));
    return { ...base, draft, sending };
  }, [run, localEvents, draft, sending]);

  return (
    <SpatialSurface>
      <ClawvilleSpatialView snapshot={snapshot} onAction={onAction} />
    </SpatialSurface>
  );
}
