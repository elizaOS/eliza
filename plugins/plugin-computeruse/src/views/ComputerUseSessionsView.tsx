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
  id: string;
  label: string;
  target: { kind: SessionKind; targetId?: string; viewerUrl?: string };
  status: "idle" | "running" | "closed";
  sequence: number;
  createdAt: string;
  updatedAt: string;
  leaseExpiresAt?: string;
  cursor?: { x: number; y: number; displayId?: number; updatedAt: string };
  lastCommand?: string;
  lastError?: string;
}

export interface SessionFrame {
  mimeType: "image/png" | "image/jpeg";
  data: string;
  capturedAt: string;
  width?: number;
  height?: number;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; sessions: SessionSnapshot[] };

const SNAPSHOT_POLL_MS = 1_500;
const FRAME_POLL_MS = 2_000;

export interface ComputerUseSessionsViewApi {
  closeSession(sessionId: string, signal?: AbortSignal): Promise<void>;
  getFrame(sessionId: string, signal?: AbortSignal): Promise<SessionFrame>;
  listSessions(signal?: AbortSignal): Promise<SessionSnapshot[]>;
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
  async getFrame(sessionId, signal) {
    const response = await client.fetch<{ frame: SessionFrame }>(
      `/api/computer-use/sessions/${encodeURIComponent(sessionId)}/frame`,
      { signal },
      { timeoutMs: 10_000 },
    );
    return response.frame;
  },
  async listSessions(signal) {
    const response = await client.fetch<{ sessions: SessionSnapshot[] }>(
      "/api/computer-use/sessions",
      { signal },
    );
    if (!Array.isArray(response.sessions)) {
      throw new Error("Computer sessions returned an invalid response");
    }
    return response.sessions;
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
  if (status === "closed") return "bg-muted text-muted-foreground";
  return "bg-orange-500/15 text-orange-700 dark:text-orange-300";
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

function SessionPreview({
  frame,
  session,
}: {
  frame?: SessionFrame;
  session: SessionSnapshot;
}) {
  if (frame) {
    return (
      <div
        className="relative overflow-hidden rounded-xl bg-neutral-950"
        style={{ aspectRatio: "2.4 / 1" }}
      >
        <img
          alt={`${session.label} latest frame`}
          className="h-full w-full object-contain"
          src={frameDataUrl(frame)}
        />
        <CursorOverlay frame={frame} session={session} />
      </div>
    );
  }
  if (session.target.viewerUrl) {
    return (
      <iframe
        className="w-full rounded-xl border-0 bg-neutral-950"
        sandbox="allow-scripts"
        src={session.target.viewerUrl}
        style={{ aspectRatio: "2.4 / 1" }}
        title={`${session.label} viewer`}
      />
    );
  }
  return (
    <div
      className="flex items-center justify-center rounded-xl bg-neutral-950 px-6 text-center text-xs text-neutral-400"
      style={{ aspectRatio: "2.4 / 1" }}
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
        const sessions = await api.listSessions(controller.signal);
        if (!controller.signal.aborted) {
          sessionsRef.current = sessions;
          setState({ kind: "ready", sessions });
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

  const sessions = state.kind === "ready" ? state.sessions : [];
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

  const closeSession = useCallback(
    async (sessionId: string) => {
      setActionError(null);
      try {
        await api.closeSession(sessionId);
        await loadSessions(true);
      } catch (error) {
        // error-policy:J4 a failed close remains visible and retryable.
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
              One physical host cursor; independent targets use virtual cursors.
              Frames update live—select a session to focus it, then close
              isolated targets when finished.
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
          {!shortLandscape ? (
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
                        <button
                          className="min-h-11 px-1 text-xs text-muted-foreground hover:text-orange-500"
                          data-agent-id={`computer-session-close-${session.id}`}
                          onClick={() => void closeSession(session.id)}
                          type="button"
                        >
                          Close
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
                    </div>
                  </article>
                ),
              )}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
