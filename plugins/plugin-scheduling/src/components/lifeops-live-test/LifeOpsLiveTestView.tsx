/**
 * LifeOpsLiveTestView — the single GUI/XR/TUI data wrapper for the HITL
 * "LifeOps Live Test" surface.
 *
 * It owns every live read + write and hands the presentational
 * {@link LifeOpsLiveTestSpatialView} a fully-resolved snapshot:
 *
 *   - model readiness   `client.getStatus().canRespond`  (true ⇒ ready,
 *                         false ⇒ no model, undefined ⇒ unknown/checking),
 *   - connectors        `client.getPlugins()` filtered to `category:"connector"`
 *                         and intersected with the key LifeOps connectors,
 *   - scheduled tasks   `client.listScheduledTasks()` (quiet 20s poll),
 *   - run validation    `client.runLifeOpsTestProbe(kind)` (seed-due + fire),
 *   - fire on demand     `client.fireScheduledTask(taskId)`.
 *
 * The client DISPLAYS, never COMPUTES: every readiness line, connector status,
 * and fire outcome is resolved HERE into a display string and handed down as a
 * snapshot. The spatial view is display-only and dispatches action ids back
 * through `onAction`; this wrapper turns those into real client calls and route
 * navigations. It imports only the browser client (`@elizaos/ui`) — no
 * spatial-unsafe modules leak into the view bundle.
 */

import { dispatchNavigateViewEvent } from "@elizaos/shared/events";
import {
  client,
  type PluginInfo,
  type ScheduledTaskView,
} from "@elizaos/ui/api";
import { dispatchFocusConnector } from "@elizaos/ui/events";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ChecklistRow,
  type LifeOpsLiveTestSnapshot,
  LifeOpsLiveTestSpatialView,
  type ModelReadiness,
  type OutcomeCard,
  type TaskRowCard,
} from "./LifeOpsLiveTestSpatialView.tsx";

// ---------------------------------------------------------------------------
// Wire mirror — the fire-result shape the scheduled-task routes return. Declared
// locally (the client's `ScheduledTaskFireResult` is not re-exported through the
// barrel); structurally identical, so the inferred client return type flows in.
// ---------------------------------------------------------------------------

interface FireResult {
  kind: "fired" | "raced" | "skipped" | "dispatch_deferred" | "dispatch_failed";
  reason?: string;
  error?: string;
  nextAttemptAtIso?: string;
  task: ScheduledTaskView | null;
}

// ---------------------------------------------------------------------------
// Key LifeOps connectors — a fixed, ordered inventory. A connector row is shown
// only when the matching plugin is present in the runtime plugin list, so a
// build without (say) Slack simply omits that row.
// ---------------------------------------------------------------------------

const KEY_CONNECTORS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "google", label: "Google" },
  { id: "telegram", label: "Telegram" },
  { id: "discord", label: "Discord" },
  { id: "slack", label: "Slack" },
  { id: "x", label: "X" },
];

// ---------------------------------------------------------------------------
// Display resolvers (wire → snapshot; every string resolved here).
// ---------------------------------------------------------------------------

function modelReadiness(canRespond: boolean | undefined): ModelReadiness {
  if (canRespond === true) return "ready";
  if (canRespond === false) return "not-ready";
  return "unknown";
}

function modelRow(readiness: ModelReadiness): ChecklistRow {
  switch (readiness) {
    case "ready":
      return {
        id: "model",
        label: "AI model",
        status: "Connected — the agent can respond.",
        ready: true,
        action: "",
      };
    case "not-ready":
      return {
        id: "model",
        label: "AI model",
        status: "No working model — connect a provider to run a validation.",
        ready: false,
        action: "Connect a model",
      };
    default:
      return {
        id: "model",
        label: "AI model",
        status: "Checking model status…",
        ready: false,
        pending: true,
        action: "Connect a model",
      };
  }
}

function connectorRows(plugins: PluginInfo[]): ChecklistRow[] {
  const connectors = new Map(
    plugins
      .filter((p) => p.category === "connector")
      .map((p) => [p.id, p] as const),
  );
  const rows: ChecklistRow[] = [];
  for (const { id, label } of KEY_CONNECTORS) {
    const plugin = connectors.get(id);
    if (!plugin) continue;
    const connected = plugin.enabled && plugin.configured;
    rows.push({
      id,
      label: plugin.name || label,
      ready: connected,
      status: connected
        ? "Connected"
        : plugin.enabled
          ? "Enabled — needs setup"
          : "Not connected",
      action: "Connect",
    });
  }
  return rows;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
}

/** Resolve a typed fire result into a plain-language outcome card. `noun` names
 * the thing that fired (e.g. "reminder", "check-in", "task"). */
function fireOutcome(fire: FireResult, noun: string): OutcomeCard {
  switch (fire.kind) {
    case "fired":
      return {
        tone: "primary",
        title: "Fired",
        detail: `The scheduler fired the ${noun} and dispatched it to you.`,
      };
    case "skipped":
      return {
        tone: "warning",
        title: "Skipped",
        detail: `Skipped: ${fire.reason ?? "a shouldFire gate denied it"}.`,
      };
    case "dispatch_deferred":
      return {
        tone: "warning",
        title: "Dispatch deferred",
        detail: `The ${noun} fired but dispatch failed transiently${
          fire.nextAttemptAtIso
            ? `; retrying at ${formatTime(fire.nextAttemptAtIso)}`
            : ""
        }.`,
      };
    case "dispatch_failed":
      return {
        tone: "danger",
        title: "Dispatch failed",
        detail: `Dispatch failed: ${fire.error ?? "unknown error"}.`,
      };
    case "raced":
      return {
        tone: "warning",
        title: "Raced",
        detail: "Another scheduler tick claimed this task first.",
      };
  }
}

function taskRow(
  task: ScheduledTaskView,
  firing: ReadonlySet<string>,
  fires: Readonly<Record<string, OutcomeCard>>,
): TaskRowCard {
  return {
    id: task.taskId,
    title: task.promptInstructions || task.kind,
    meta: `${task.kind} • ${task.state.status}`,
    firing: firing.has(task.taskId),
    fire: fires[task.taskId],
  };
}

// ---------------------------------------------------------------------------
// Navigation — open the relevant Settings section. `eliza:navigate:view` with a
// `subview` is the app's settings deep-link channel (App.tsx routes it to the
// SettingsView initial section); `dispatchFocusConnector` marks the connector
// card to auto-open once Settings → Connectors mounts.
// ---------------------------------------------------------------------------

function navigateSettings(subview: string): void {
  if (typeof window === "undefined") return;
  dispatchNavigateViewEvent({
    viewId: "settings",
    viewPath: "/settings",
    subview,
  });
}

function connectModel(): void {
  if (typeof window === "undefined") {
    (client as { sendChatMessage?: (text: string) => void }).sendChatMessage?.(
      "Connect a model provider.",
    );
    return;
  }
  navigateSettings("ai-model");
}

function connectConnector(connectorId: string): void {
  dispatchFocusConnector(connectorId);
  navigateSettings("connectors");
}

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 20_000;

type TasksLoad =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; rows: ScheduledTaskView[] };

interface RunState {
  state: "idle" | "running" | "done";
  kind?: "reminder" | "checkin";
  outcome?: OutcomeCard;
}

export function LifeOpsLiveTestView(): ReactNode {
  const [readiness, setReadiness] = useState<ModelReadiness>("unknown");
  const [connectors, setConnectors] = useState<ChecklistRow[]>([]);
  const [tasks, setTasks] = useState<TasksLoad>({ kind: "loading" });
  const [run, setRun] = useState<RunState>({ state: "idle" });
  const [firing, setFiring] = useState<ReadonlySet<string>>(new Set());
  const [fires, setFires] = useState<Record<string, OutcomeCard>>({});

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const status = await client.getStatus();
      if (mountedRef.current) setReadiness(modelReadiness(status.canRespond));
    } catch {
      // A transient status failure leaves the last-known readiness; the row
      // simply keeps its prior state rather than flapping to an error.
    }
  }, []);

  const loadConnectors = useCallback(async () => {
    try {
      const { plugins } = await client.getPlugins();
      if (mountedRef.current) setConnectors(connectorRows(plugins));
    } catch {
      // Connectors are a checklist aid; a failed plugin list leaves the section
      // empty rather than blocking the run panel.
    }
  }, []);

  const loadTasks = useCallback(async (quiet = false) => {
    if (!quiet) setTasks({ kind: "loading" });
    try {
      const { tasks: rows } = await client.listScheduledTasks();
      if (mountedRef.current) setTasks({ kind: "ready", rows });
    } catch (error) {
      if (!mountedRef.current || quiet) return;
      setTasks({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not load scheduled tasks.",
      });
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadConnectors();
    void loadTasks();
  }, [loadStatus, loadConnectors, loadTasks]);

  // Quiet background refresh so readiness + the task list stay live without a
  // manual reload. Transient poll failures are ignored (see load* above).
  useEffect(() => {
    const id = setInterval(() => {
      void loadStatus();
      void loadTasks(true);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [loadStatus, loadTasks]);

  const runProbe = useCallback(
    async (kind: "reminder" | "checkin") => {
      setRun({ state: "running", kind });
      const noun = kind === "checkin" ? "check-in" : "reminder";
      try {
        const { fire } = await client.runLifeOpsTestProbe(kind);
        if (mountedRef.current) {
          setRun({ state: "done", kind, outcome: fireOutcome(fire, noun) });
        }
        void loadTasks(true);
      } catch (error) {
        if (!mountedRef.current) return;
        setRun({
          state: "done",
          kind,
          outcome: {
            tone: "danger",
            title: "Run failed",
            detail:
              error instanceof Error
                ? error.message
                : "The validation could not be started.",
          },
        });
      }
    },
    [loadTasks],
  );

  const fireTask = useCallback(
    async (taskId: string) => {
      setFiring((prev) => new Set(prev).add(taskId));
      try {
        const { fire } = await client.fireScheduledTask(taskId);
        if (mountedRef.current) {
          setFires((prev) => ({
            ...prev,
            [taskId]: fireOutcome(fire, "task"),
          }));
        }
        void loadTasks(true);
      } catch (error) {
        if (mountedRef.current) {
          setFires((prev) => ({
            ...prev,
            [taskId]: {
              tone: "danger",
              title: "Fire failed",
              detail:
                error instanceof Error
                  ? error.message
                  : "The task could not be fired.",
            },
          }));
        }
      } finally {
        if (mountedRef.current) {
          setFiring((prev) => {
            const next = new Set(prev);
            next.delete(taskId);
            return next;
          });
        }
      }
    },
    [loadTasks],
  );

  const onAction = useCallback(
    (action: string) => {
      if (action === "connect-model") {
        connectModel();
        return;
      }
      if (action.startsWith("connect-connector:")) {
        connectConnector(action.slice("connect-connector:".length));
        return;
      }
      if (action === "run-reminder") {
        void runProbe("reminder");
        return;
      }
      if (action === "run-checkin") {
        void runProbe("checkin");
        return;
      }
      if (action.startsWith("fire:")) {
        void fireTask(action.slice("fire:".length));
        return;
      }
      if (action === "retry") {
        void loadTasks();
      }
    },
    [runProbe, fireTask, loadTasks],
  );

  const snapshot = useMemo<LifeOpsLiveTestSnapshot>(
    () => ({
      model: modelRow(readiness),
      connectors,
      run: { state: run.state, kind: run.kind, outcome: run.outcome },
      tasks:
        tasks.kind === "loading"
          ? { state: "loading", rows: [] }
          : tasks.kind === "error"
            ? { state: "error", error: tasks.message, rows: [] }
            : {
                state: "ready",
                rows: tasks.rows.map((task) => taskRow(task, firing, fires)),
              },
    }),
    [readiness, connectors, run, tasks, firing, fires],
  );

  return <LifeOpsLiveTestSpatialView snapshot={snapshot} onAction={onAction} />;
}

export default LifeOpsLiveTestView;
