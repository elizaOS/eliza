/**
 * Renders live computer-use sessions as a responsive monitor grid. It polls
 * authenticated snapshots and read-only frames, keeps failures visibly
 * distinct from empty/loading state, and can detach into the desktop host's
 * native always-on-top app window.
 */

import { client } from "@elizaos/ui/api";
import { openDesktopAppWindow } from "@elizaos/ui/bridge";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type SessionKind = "host" | "browser" | "sandbox" | "remote_guest";

export interface SessionSnapshot {
  contractVersion: 2;
  id: string;
  ownerId: string;
  adapterId: string;
  canonicalState:
    | "ready"
    | "running"
    | "paused"
    | "awaiting_confirmation"
    | "stopping"
    | "stopped"
    | "failed";
  isolationMode: string;
  generation: number;
  label: string;
  target: { kind: SessionKind; targetId?: string; viewerUrl?: string };
  status: "idle" | "running" | "paused" | "stopping" | "closed";
  sequence: number;
  createdAt: string;
  updatedAt: string;
  leaseExpiresAt?: string;
  cursor?: { x: number; y: number; displayId?: number; updatedAt: string };
  targetOverlay?: {
    x: number;
    y: number;
    width: number;
    height: number;
    elementIndex?: number;
    appId?: string;
    updatedAt: string;
    physicalPointerMoved: boolean;
  };
  lastCommand?: string;
  lastError?: string;
  lastObservation?: ObservationProvenance;
  lastOutcome?: {
    actionId: string;
    status: string;
    completedAt: string;
    observationId?: string;
    errorCode?: string;
  };
  lastReceipt?: {
    receiptId: string;
    appId: string;
    kind: string;
    executionMode: string;
    changed: boolean;
    physicalPointerMoved: boolean;
    clipboardRestored?: boolean;
    element_index?: number;
  };
}

export interface ObservationProvenance {
  observationId: string;
  sequence: number;
  observedAt: string;
  sha256: string;
  mimeType: "image/png" | "image/jpeg";
  source: SessionKind;
  width?: number;
  height?: number;
}

export interface SessionFrame {
  mimeType: "image/png" | "image/jpeg";
  data: string;
  capturedAt: string;
  width?: number;
  height?: number;
  provenance: ObservationProvenance;
}

export interface SessionEvent {
  eventId: number;
  type: string;
  sessionId: string;
  occurredAt: string;
  command?: string;
  outcomeStatus?: string;
}

export interface ComputerUseReadiness {
  capture: { available: boolean; tool: string };
  input: { available: boolean; tool: string };
  browser: { available: boolean; tool: string };
  accessibility?: {
    available: boolean;
    adapter: string;
    permission: string;
  };
  vision: { available: boolean; modelType: string };
  approvalMode: string;
}

export interface ComputerUseSessionsSnapshot {
  sessions: SessionSnapshot[];
  events: SessionEvent[];
  readiness: ComputerUseReadiness;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshot: ComputerUseSessionsSnapshot };

const SNAPSHOT_POLL_MS = 1_500;
const FRAME_POLL_MS = 2_000;

export interface ComputerUseSessionsViewApi {
  closeSession(sessionId: string, signal?: AbortSignal): Promise<void>;
  pauseSession(sessionId: string, signal?: AbortSignal): Promise<void>;
  resumeSession(sessionId: string, signal?: AbortSignal): Promise<void>;
  stopSession(sessionId: string, signal?: AbortSignal): Promise<void>;
  getFrame(sessionId: string, signal?: AbortSignal): Promise<SessionFrame>;
  listSessions(signal?: AbortSignal): Promise<ComputerUseSessionsSnapshot>;
}

export interface ComputerUseSessionsViewProps {
  api?: ComputerUseSessionsViewApi;
  openFloatingWindow?: () => Promise<boolean>;
  snapshotPollMs?: number;
  framePollMs?: number;
}

const defaultApi: ComputerUseSessionsViewApi = {
  async closeSession(sessionId, signal) {
    await client.fetch(
      `/api/computer-use/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE", signal },
    );
  },
  async pauseSession(sessionId, signal) {
    await client.fetch(
      `/api/computer-use/sessions/${encodeURIComponent(sessionId)}/pause`,
      { method: "POST", signal },
    );
  },
  async resumeSession(sessionId, signal) {
    await client.fetch(
      `/api/computer-use/sessions/${encodeURIComponent(sessionId)}/resume`,
      { method: "POST", signal },
    );
  },
  async stopSession(sessionId, signal) {
    await client.fetch(
      `/api/computer-use/sessions/${encodeURIComponent(sessionId)}/stop`,
      { method: "POST", signal },
    );
  },
  async getFrame(sessionId, signal) {
    const response = await client.fetch<{ frame: SessionFrame }>(
      `/api/computer-use/sessions/${encodeURIComponent(sessionId)}/frame`,
      { signal },
      { timeoutMs: 10_000 },
    );
    return response.frame;
  },
  async listSessions(signal) {
    const response = await client.fetch<ComputerUseSessionsSnapshot>(
      "/api/computer-use/sessions",
      { signal },
    );
    if (!Array.isArray(response.sessions)) {
      throw new Error("Computer sessions returned an invalid response");
    }
    if (!response.readiness || !Array.isArray(response.events)) {
      throw new Error("Computer sessions returned incomplete readiness data");
    }
    return response;
  },
};

async function defaultOpenFloatingWindow(): Promise<boolean> {
  const opened = await openDesktopAppWindow({
    slug: "computer-use-sessions-pip",
    title: "Computer Sessions",
    path: "/computer-use-sessions",
    alwaysOnTop: true,
  });
  return opened !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Computer sessions unavailable";
}

function kindLabel(kind: SessionKind): string {
  if (kind === "remote_guest") return "Remote guest";
  return `${kind.slice(0, 1).toUpperCase()}${kind.slice(1)}`;
}

function statusTone(status: SessionSnapshot["status"]): string {
  if (status === "running") return "bg-orange-500 text-white";
  if (status === "stopping") return "bg-orange-700 text-white";
  if (status === "paused")
    return "bg-amber-500/20 text-amber-800 dark:text-amber-200";
  if (status === "closed") return "bg-muted text-muted-foreground";
  return "bg-orange-500/15 text-orange-700 dark:text-orange-300";
}

function ReadinessPill({
  available,
  label,
}: {
  available: boolean;
  label: string;
}) {
  return (
    <span
      className={`rounded-full px-2 py-1 text-[11px] ${
        available
          ? "bg-orange-500/15 text-orange-700 dark:text-orange-300"
          : "bg-destructive/10 text-destructive"
      }`}
    >
      {label}: {available ? "ready" : "unavailable"}
    </span>
  );
}

function frameDataUrl(frame: SessionFrame): string {
  return `data:${frame.mimeType};base64,${frame.data}`;
}

function CursorOverlay({
  frame,
  session,
}: {
  frame: SessionFrame;
  session: SessionSnapshot;
}) {
  if (!session.cursor || !frame.width || !frame.height) return null;
  const left = Math.max(
    0,
    Math.min(100, (session.cursor.x / frame.width) * 100),
  );
  const top = Math.max(
    0,
    Math.min(100, (session.cursor.y / frame.height) * 100),
  );
  return (
    <span
      aria-label={`Virtual cursor at ${session.cursor.x}, ${session.cursor.y}`}
      className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-orange-500 shadow-[0_0_0_2px_white,0_0_0_4px_rgba(0,0,0,0.45)]"
      role="img"
      style={{ left: `${left}%`, top: `${top}%` }}
    />
  );
}

function AgentTargetOverlay({
  frame,
  session,
}: {
  frame: SessionFrame;
  session: SessionSnapshot;
}) {
  const target = session.targetOverlay;
  if (!target || !frame.width || !frame.height) return null;
  const left = Math.max(0, Math.min(100, (target.x / frame.width) * 100));
  const top = Math.max(0, Math.min(100, (target.y / frame.height) * 100));
  const width = Math.max(
    0.75,
    Math.min(100 - left, (target.width / frame.width) * 100),
  );
  const height = Math.max(
    0.75,
    Math.min(100 - top, (target.height / frame.height) * 100),
  );
  return (
    <span
      aria-label={`Agent target${target.elementIndex ? ` element ${target.elementIndex}` : ""}; ${target.physicalPointerMoved ? "system pointer used" : "system pointer unchanged"}`}
      className="pointer-events-none absolute border-2 border-orange-400 bg-orange-500/10 shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
      role="img"
      style={{
        height: `${height}%`,
        left: `${left}%`,
        top: `${top}%`,
        width: `${width}%`,
      }}
    >
      <span className="absolute -top-5 left-0 rounded bg-orange-500 px-1.5 py-0.5 text-[9px] font-medium text-white">
        Agent target ·{" "}
        {target.physicalPointerMoved ? "pointer used" : "pointer unchanged"}
      </span>
    </span>
  );
}

function SessionPreview({
  compact = false,
  frame,
  session,
}: {
  compact?: boolean;
  frame?: SessionFrame;
  session: SessionSnapshot;
}) {
  if (frame) {
    return (
      <div
        className={`relative overflow-hidden rounded-xl bg-neutral-950 ${compact ? "h-20" : ""}`}
        style={compact ? undefined : { aspectRatio: "2.4 / 1" }}
      >
        <img
          alt={`${session.label} latest frame`}
          className="h-full w-full object-contain"
          src={frameDataUrl(frame)}
        />
        <CursorOverlay frame={frame} session={session} />
        <AgentTargetOverlay frame={frame} session={session} />
      </div>
    );
  }
  if (session.target.viewerUrl) {
    return (
      <iframe
        className={`w-full rounded-xl border-0 bg-neutral-950 ${compact ? "h-20" : ""}`}
        sandbox="allow-scripts"
        src={session.target.viewerUrl}
        style={compact ? undefined : { aspectRatio: "2.4 / 1" }}
        title={`${session.label} viewer`}
      />
    );
  }
  return (
    <div
      className={`flex items-center justify-center rounded-xl bg-neutral-950 px-6 text-center text-xs text-neutral-400 ${compact ? "h-20" : ""}`}
      style={compact ? undefined : { aspectRatio: "2.4 / 1" }}
    >
      Waiting for a frame provider on this target.
    </div>
  );
}

export function ComputerUseSessionsView({
  api = defaultApi,
  openFloatingWindow = defaultOpenFloatingWindow,
  snapshotPollMs = SNAPSHOT_POLL_MS,
  framePollMs = FRAME_POLL_MS,
}: ComputerUseSessionsViewProps = {}): ReactElement {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [frames, setFrames] = useState<Record<string, SessionFrame>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [compactViewport, setCompactViewport] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 639px)").matches,
  );
  const [shortLandscape, setShortLandscape] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-height: 500px) and (orientation: landscape)")
        .matches,
  );
  const activeSnapshotRequest = useRef<AbortController | null>(null);
  const activeFrameRequest = useRef<AbortController | null>(null);
  const sessionsRef = useRef<SessionSnapshot[]>([]);

  const loadSessions = useCallback(
    async (background = false) => {
      activeSnapshotRequest.current?.abort();
      const controller = new AbortController();
      activeSnapshotRequest.current = controller;
      if (!background) setState({ kind: "loading" });
      try {
        const snapshot = await api.listSessions(controller.signal);
        if (!controller.signal.aborted) {
          sessionsRef.current = snapshot.sessions;
          setState({ kind: "ready", snapshot });
        }
      } catch (error) {
        // error-policy:J4 foreground failures render explicitly; background
        // failures preserve the last-good session grid.
        if (!controller.signal.aborted && !background) {
          setState({ kind: "error", message: errorMessage(error) });
        }
      } finally {
        if (activeSnapshotRequest.current === controller) {
          activeSnapshotRequest.current = null;
        }
      }
    },
    [api],
  );

  const sessions = state.kind === "ready" ? state.snapshot.sessions : [];
  const readiness = state.kind === "ready" ? state.snapshot.readiness : null;
  const events = state.kind === "ready" ? state.snapshot.events : [];
  const frameSessionKey = sessions
    .map((session) => `${session.id}:${session.status}`)
    .join("|");

  const loadFrames = useCallback(
    async (current: SessionSnapshot[]) => {
      activeFrameRequest.current?.abort();
      const controller = new AbortController();
      activeFrameRequest.current = controller;
      const updates = await Promise.all(
        current.map(async (session) => {
          if (session.status === "running") return null;
          try {
            const frame = await api.getFrame(session.id, controller.signal);
            return [session.id, frame] as const;
          } catch {
            // error-policy:J4 a target without a frame provider keeps its visible
            // viewer/placeholder; one failed tile must not erase healthy tiles.
            return null;
          }
        }),
      );
      if (controller.signal.aborted) return;
      setFrames((previous) => {
        const next = { ...previous };
        for (const update of updates) {
          if (update) next[update[0]] = update[1];
        }
        return next;
      });
      if (activeFrameRequest.current === controller) {
        activeFrameRequest.current = null;
      }
    },
    [api],
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 639px)");
    const update = () => setCompactViewport(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(
      "(max-height: 500px) and (orientation: landscape)",
    );
    const update = () => setShortLandscape(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    void loadSessions();
    const interval = window.setInterval(
      () => void loadSessions(true),
      snapshotPollMs,
    );
    return () => {
      window.clearInterval(interval);
      activeSnapshotRequest.current?.abort();
    };
  }, [loadSessions, snapshotPollMs]);

  useEffect(() => {
    const loadCurrentFrames = () => {
      if (sessionsRef.current.length > 0) void loadFrames(sessionsRef.current);
    };
    const interval = window.setInterval(loadCurrentFrames, framePollMs);
    return () => {
      window.clearInterval(interval);
      activeFrameRequest.current?.abort();
    };
  }, [framePollMs, loadFrames]);

  useEffect(() => {
    if (frameSessionKey.length > 0) void loadFrames(sessionsRef.current);
  }, [frameSessionKey, loadFrames]);

  useEffect(() => {
    if (sessions.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !sessions.some((session) => session.id === selectedId)) {
      setSelectedId(sessions[0]?.id ?? null);
    }
  }, [selectedId, sessions]);

  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [selectedId, sessions],
  );

  const openFloating = useCallback(async () => {
    setActionError(null);
    try {
      const opened = await openFloatingWindow();
      if (!opened)
        setActionError("Floating windows are available in the desktop app.");
    } catch (error) {
      // error-policy:J4 desktop bridge failures are visible in the view.
      setActionError(errorMessage(error));
    }
  }, [openFloatingWindow]);

  const controlSession = useCallback(
    async (
      session: SessionSnapshot,
      operation: "pause" | "resume" | "stop",
    ) => {
      setActionError(null);
      try {
        if (operation === "pause") await api.pauseSession(session.id);
        else if (operation === "resume") await api.resumeSession(session.id);
        else await api.stopSession(session.id);
        await loadSessions(true);
      } catch (error) {
        // error-policy:J4 session controls remain visibly retryable.
        setActionError(errorMessage(error));
      }
    },
    [api, loadSessions],
  );

  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <h1 className="text-base font-semibold">Computer sessions</h1>
          {!shortLandscape ? (
            <p className="text-xs text-muted-foreground">
              macOS has one true system pointer. Orange target boxes are an
              agent-only overlay and do not move it; guarded coordinate actions
              may use the physical pointer only after policy approval.
            </p>
          ) : null}
        </div>
        <button
          className="min-h-11 rounded-lg bg-orange-500 px-4 text-sm font-medium text-white hover:bg-orange-600"
          data-agent-id="computer-sessions-open-floating"
          onClick={() => void openFloating()}
          type="button"
        >
          Open floating
        </button>
        {readiness ? (
          <fieldset className="flex w-full flex-wrap gap-2">
            <legend className="sr-only">Computer use readiness</legend>
            <ReadinessPill
              available={readiness.capture.available}
              label="Capture"
            />
            <ReadinessPill
              available={readiness.input.available}
              label="Input"
            />
            <ReadinessPill
              available={readiness.browser.available}
              label="Browser"
            />
            <ReadinessPill
              available={readiness.vision.available}
              label="Vision"
            />
            {readiness.accessibility ? (
              <>
                <ReadinessPill
                  available={readiness.accessibility.available}
                  label="AX helper"
                />
                <span className="rounded-full bg-muted px-2 py-1 text-[11px] text-foreground">
                  Accessibility permission:{" "}
                  {readiness.accessibility.permission.replaceAll("_", " ")}
                </span>
              </>
            ) : null}
            <span className="rounded-full bg-muted px-2 py-1 text-[11px] text-foreground">
              Approval: {readiness.approvalMode.replaceAll("_", " ")}
            </span>
          </fieldset>
        ) : null}
      </header>

      {actionError ? (
        <div className="mx-4 mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      {state.kind === "loading" ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading sessions…
        </div>
      ) : state.kind === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-destructive">{state.message}</p>
          <button
            className="min-h-11 rounded-lg border border-border px-4 text-sm hover:bg-orange-500/10"
            onClick={() => void loadSessions()}
            type="button"
          >
            Retry
          </button>
        </div>
      ) : sessions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          No active computer-use sessions.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {compactViewport || shortLandscape ? (
            <nav
              aria-label="Computer session selector"
              className="flex gap-2 overflow-x-auto px-3 py-2"
            >
              {sessions.map((session) => (
                <button
                  className={`min-h-11 shrink-0 rounded-lg px-3 text-xs ${
                    selected?.id === session.id
                      ? "bg-orange-500 text-white"
                      : "bg-card text-muted-foreground"
                  }`}
                  key={session.id}
                  onClick={() => setSelectedId(session.id)}
                  type="button"
                >
                  {session.label}
                </button>
              ))}
            </nav>
          ) : null}
          {shortLandscape && selected ? (
            <article
              className="grid min-h-0 gap-3 overflow-y-auto px-3 pt-1 pb-[var(--eliza-chat-clearance,5.25rem)]"
              style={{
                gridTemplateColumns: "minmax(12rem, 0.9fr) minmax(0, 1.1fr)",
              }}
            >
              <SessionPreview
                compact
                frame={frames[selected.id]}
                session={selected}
              />
              <div className="min-w-0 text-xs text-muted-foreground">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-foreground">
                      {selected.label}
                    </h2>
                    <p className="truncate">
                      {kindLabel(selected.target.kind)}
                      {selected.target.targetId
                        ? ` · ${selected.target.targetId}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-1 text-[11px] ${statusTone(selected.status)}`}
                    >
                      {selected.status}
                    </span>
                    {selected.status === "paused" ? (
                      <button
                        className="min-h-11 px-1 text-xs hover:text-orange-500"
                        onClick={() => void controlSession(selected, "resume")}
                        type="button"
                      >
                        Resume
                      </button>
                    ) : selected.status === "idle" ? (
                      <button
                        className="min-h-11 px-1 text-xs hover:text-orange-500"
                        onClick={() => void controlSession(selected, "pause")}
                        type="button"
                      >
                        Pause
                      </button>
                    ) : null}
                    <button
                      className="min-h-11 px-1 text-xs text-destructive hover:text-orange-600 disabled:opacity-50"
                      data-agent-id={`computer-session-stop-${selected.id}`}
                      disabled={selected.status === "stopping"}
                      onClick={() => void controlSession(selected, "stop")}
                      type="button"
                    >
                      Stop
                    </button>
                  </div>
                </div>
                <p className="truncate">
                  Sequence {selected.sequence}
                  {selected.cursor
                    ? ` · Cursor ${Math.round(selected.cursor.x)}, ${Math.round(selected.cursor.y)}`
                    : " · Cursor pending"}
                </p>
                {selected.lastReceipt ? (
                  <p className="truncate">
                    {selected.lastReceipt.executionMode.replaceAll("_", " ")}
                    {selected.lastReceipt.clipboardRestored
                      ? " · clipboard restored"
                      : ""}
                    {selected.lastReceipt.physicalPointerMoved
                      ? " · physical pointer used"
                      : " · physical pointer unchanged"}
                  </p>
                ) : null}
                {frames[selected.id]?.provenance ? (
                  <p
                    className="truncate"
                    title={frames[selected.id]?.provenance.sha256}
                  >
                    Observation {frames[selected.id]?.provenance.sequence} ·{" "}
                    {frames[selected.id]?.provenance.source} ·{" "}
                    {frames[selected.id]?.provenance.sha256.slice(0, 10)}
                  </p>
                ) : null}
                <p className="truncate">
                  {selected.lastOutcome
                    ? `Outcome: ${selected.lastOutcome.status}${
                        selected.lastOutcome.errorCode
                          ? ` · ${selected.lastOutcome.errorCode}`
                          : ""
                      }`
                    : selected.lastCommand
                      ? `Last: ${selected.lastCommand}`
                      : "Waiting for first action"}
                </p>
              </div>
            </article>
          ) : (
            <div className="grid min-h-0 flex-1 content-start items-start gap-3 overflow-y-auto ps-3 pt-2 pb-[var(--eliza-chat-clearance,5.25rem)] pe-[var(--eliza-chat-side-clearance,0px)] md:grid-cols-2 xl:grid-cols-3">
              {sessions.map((session) =>
                (compactViewport || shortLandscape) &&
                selected?.id !== session.id ? null : (
                  <article
                    className={`flex min-h-0 flex-col gap-3 rounded-2xl p-3 ${
                      selected?.id === session.id
                        ? "bg-orange-500/5 shadow-[inset_3px_0_0_rgb(249_115_22)]"
                        : "bg-card"
                    }`}
                    key={session.id}
                  >
                    <div className="flex min-h-11 items-start justify-between gap-2">
                      <button
                        className="min-w-0 flex-1 text-left"
                        data-agent-id={`computer-session-select-${session.id}`}
                        onClick={() => setSelectedId(session.id)}
                        type="button"
                      >
                        <div className="min-w-0">
                          <h2 className="truncate text-sm font-semibold">
                            {session.label}
                          </h2>
                          <p className="truncate text-xs text-muted-foreground">
                            {kindLabel(session.target.kind)}
                            {session.target.targetId
                              ? ` · ${session.target.targetId}`
                              : ""}
                          </p>
                        </div>
                      </button>
                      <div className="flex shrink-0 items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-1 text-[11px] ${statusTone(session.status)}`}
                        >
                          {session.status}
                        </span>
                        {session.status === "paused" ? (
                          <button
                            className="min-h-11 px-1 text-xs text-muted-foreground hover:text-orange-500"
                            onClick={() =>
                              void controlSession(session, "resume")
                            }
                            type="button"
                          >
                            Resume
                          </button>
                        ) : session.status === "idle" ? (
                          <button
                            className="min-h-11 px-1 text-xs text-muted-foreground hover:text-orange-500"
                            onClick={() =>
                              void controlSession(session, "pause")
                            }
                            type="button"
                          >
                            Pause
                          </button>
                        ) : null}
                        <button
                          className="min-h-11 px-1 text-xs text-destructive hover:text-orange-600 disabled:opacity-50"
                          data-agent-id={`computer-session-stop-${session.id}`}
                          disabled={session.status === "stopping"}
                          onClick={() => void controlSession(session, "stop")}
                          type="button"
                        >
                          Stop
                        </button>
                      </div>
                    </div>

                    <SessionPreview
                      frame={frames[session.id]}
                      session={session}
                    />

                    <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                      <span>Sequence {session.sequence}</span>
                      <span className="text-right">
                        {session.cursor
                          ? `Cursor ${Math.round(session.cursor.x)}, ${Math.round(session.cursor.y)}`
                          : "Cursor pending"}
                      </span>
                      <span className="col-span-2 truncate">
                        {session.lastError
                          ? `Error: ${session.lastError}`
                          : session.lastCommand
                            ? `Last: ${session.lastCommand}`
                            : "Waiting for first action"}
                      </span>
                      {frames[session.id]?.provenance ? (
                        <span
                          className="col-span-2 truncate"
                          title={frames[session.id]?.provenance.sha256}
                        >
                          Observation {frames[session.id]?.provenance.sequence}{" "}
                          · {frames[session.id]?.provenance.source} ·{" "}
                          {frames[session.id]?.provenance.sha256.slice(0, 10)}
                        </span>
                      ) : null}
                      {session.lastOutcome ? (
                        <span className="col-span-2 truncate">
                          Outcome: {session.lastOutcome.status}
                          {session.lastOutcome.errorCode
                            ? ` · ${session.lastOutcome.errorCode}`
                            : ""}
                        </span>
                      ) : null}
                      {session.lastReceipt ? (
                        <span className="col-span-2 truncate">
                          {session.lastReceipt.executionMode.replaceAll(
                            "_",
                            " ",
                          )}
                          {session.lastReceipt.clipboardRestored
                            ? " · clipboard restored"
                            : ""}
                          {session.lastReceipt.physicalPointerMoved
                            ? " · physical pointer used"
                            : " · physical pointer unchanged"}
                        </span>
                      ) : null}
                    </div>
                    {selected?.id === session.id ? (
                      <ol
                        className="space-y-1 border-t border-border/60 pt-2 text-[11px] text-muted-foreground"
                        aria-label={`${session.label} action history`}
                      >
                        {events
                          .filter((event) => event.sessionId === session.id)
                          .slice(-4)
                          .map((event) => (
                            <li key={event.eventId} className="truncate">
                              {event.type}
                              {event.command ? ` · ${event.command}` : ""}
                              {event.outcomeStatus
                                ? ` · ${event.outcomeStatus}`
                                : ""}
                            </li>
                          ))}
                      </ol>
                    ) : null}
                  </article>
                ),
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
