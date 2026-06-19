/**
 * FocusView — overlay view for the Focus / blocker app.
 *
 * Data-fetching view over `GET {base}/api/website-blocker`, which returns a
 * `SelfControlStatus`. It renders one of six distinct states (loading, error,
 * unavailable, permission-needed, empty, active) and instruments its primary
 * controls through the agent surface so the floating chat can drive them.
 *
 * The default fetcher builds the URL from `client.getBaseUrl()`; tests inject a
 * `fetchStatus` so they stay offline.
 */

import { client } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SelfControlStatus } from "../../services/website-blocker/index.ts";

/**
 * Optional schedule / active-session render overrides retained for back-compat
 * with the original prop-driven stub. When supplied they replace the fetched
 * sections; the primary path is fetch-driven.
 */
export interface FocusScheduleEntry {
  id: string;
  label: string;
  target: "app" | "website";
  startsAt: string;
  endsAt: string;
}

export interface FocusActiveSession {
  id: string;
  startedAt: string;
  endsAt: string | null;
  ruleCount: number;
}

interface FocusViewProps {
  /** Test/host injection seam. Defaults to a real `/api/website-blocker` GET. */
  fetchStatus?: () => Promise<SelfControlStatus>;
  /** Test/host injection seam. Defaults to `client.stopWebsiteBlock()`. */
  releaseBlock?: () => Promise<unknown>;
  /** Back-compat override: render this schedule list instead of fetching. */
  schedule?: ReadonlyArray<FocusScheduleEntry>;
  /** Back-compat override: render this active session instead of fetching. */
  activeSession?: FocusActiveSession | null;
}

async function defaultFetchStatus(): Promise<SelfControlStatus> {
  const response = await fetch(`${client.getBaseUrl()}/api/website-blocker`);
  if (!response.ok) {
    throw new Error(
      `Website blocker status request failed (${response.status}).`,
    );
  }
  return (await response.json()) as SelfControlStatus;
}

function defaultReleaseBlock(): Promise<unknown> {
  return client.stopWebsiteBlock();
}

// ---------------------------------------------------------------------------
// Styling — light surface, CSS vars, orange accent only.
// ---------------------------------------------------------------------------

const STYLE_TAG_ID = "focus-view-styles";

const FOCUS_VIEW_CSS = `
.focus-view-btn {
  min-height: 44px;
  min-width: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.focus-view-btn-primary {
  background: var(--primary, #ff8a24);
  color: #ffffff;
  border: 1px solid var(--primary, #ff8a24);
}
.focus-view-btn-primary:hover {
  background: color-mix(in srgb, var(--primary, #ff8a24) 82%, black);
  border-color: color-mix(in srgb, var(--primary, #ff8a24) 82%, black);
}
.focus-view-btn-neutral {
  background: var(--surface, rgba(255, 255, 255, 0.7));
  color: var(--foreground, #0a1220);
  border: 1px solid var(--border, rgba(10, 18, 32, 0.08));
}
.focus-view-btn-neutral:hover {
  background: color-mix(in srgb, var(--foreground, #0a1220) 6%, transparent);
}
.focus-view-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
`;

function useFocusViewStyles(): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_TAG_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_TAG_ID;
    style.textContent = FOCUS_VIEW_CSS;
    document.head.appendChild(style);
  }, []);
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: 24,
  height: "100%",
  boxSizing: "border-box",
  background: "var(--background, #eef8ff)",
  color: "var(--foreground, #0a1220)",
  fontFamily: "system-ui, sans-serif",
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

const titleRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
};

const h1Style: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 600 };
const h2Style: CSSProperties = { margin: 0, fontSize: 16, fontWeight: 600 };

// A panel is a single light, flat field — at most one hairline edge, no
// card-in-card boxes or shadows.
const cardStyle: CSSProperties = {
  padding: 16,
  borderRadius: 12,
  background: "var(--surface, rgba(255, 255, 255, 0.7))",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const dimStyle: CSSProperties = {
  opacity: 0.65,
  fontSize: 13,
  lineHeight: 1.5,
};

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};

// Borderless tinted text chips — orange wash, no box edge.
const chipStyle: CSSProperties = {
  padding: "3px 10px",
  borderRadius: 6,
  background: "rgba(255, 138, 36, 0.08)",
  color: "var(--foreground, #0a1220)",
  fontSize: 12,
};

type StatusTone = "active" | "idle" | "permission" | "error";

const STATUS_DOT_COLOR: Record<StatusTone, string> = {
  active: "#3fa34d",
  idle: "rgba(10, 18, 32, 0.35)",
  permission: "#ff8a24",
  error: "#ef4444",
};

function StatusDot({ tone }: { tone: StatusTone }): ReactNode {
  return (
    <span
      aria-hidden
      style={{
        width: 9,
        height: 9,
        borderRadius: "50%",
        flex: "0 0 auto",
        background: STATUS_DOT_COLOR[tone],
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Agent-instrumented control buttons (hooks cannot run inside .map()).
// ---------------------------------------------------------------------------

function ReleaseButton({
  onActivate,
  disabled,
}: {
  onActivate: () => void;
  disabled: boolean;
}): ReactNode {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "focus-release",
    role: "button",
    label: "Release focus block",
    group: "focus-actions",
    description: "Remove the active website block early",
    onActivate,
  });
  return (
    <button
      ref={ref}
      type="button"
      className="focus-view-btn focus-view-btn-primary"
      onClick={onActivate}
      disabled={disabled}
      aria-label="Release focus block"
      {...agentProps}
    >
      Release block
    </button>
  );
}

// ---------------------------------------------------------------------------
// Back-compat override sections (render-only, used when props are supplied).
// ---------------------------------------------------------------------------

function ActiveSessionCard({
  session,
}: {
  session: FocusActiveSession | null | undefined;
}): ReactNode {
  if (!session) {
    return (
      <div style={{ ...cardStyle, ...dimStyle }}>No active focus session.</div>
    );
  }
  return (
    <div style={cardStyle}>
      <div style={{ fontWeight: 600 }}>Focus session active</div>
      <div style={dimStyle}>
        Started {session.startedAt}
        {session.endsAt ? ` · ends ${session.endsAt}` : ""}
      </div>
      <div style={dimStyle}>{session.ruleCount} rules enforced</div>
    </div>
  );
}

function ScheduleList({
  schedule,
}: {
  schedule: ReadonlyArray<FocusScheduleEntry> | undefined;
}): ReactNode {
  if (!schedule || schedule.length === 0) {
    return (
      <div style={{ ...cardStyle, ...dimStyle }}>No scheduled blocks.</div>
    );
  }
  return (
    <ul
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {schedule.map((entry) => (
        <li key={entry.id} style={cardStyle}>
          <div style={{ fontWeight: 600 }}>{entry.label}</div>
          <div style={dimStyle}>
            {entry.target} · {entry.startsAt} → {entry.endsAt}
          </div>
        </li>
      ))}
    </ul>
  );
}

function OverrideView({
  schedule,
  activeSession,
}: {
  schedule?: ReadonlyArray<FocusScheduleEntry>;
  activeSession?: FocusActiveSession | null;
}): ReactNode {
  return (
    <div style={containerStyle} data-testid="focus-overrides">
      <header style={titleRowStyle}>
        <h1 style={h1Style}>Focus</h1>
      </header>
      <section style={sectionStyle}>
        <ActiveSessionCard session={activeSession ?? null} />
      </section>
      <section style={sectionStyle}>
        <ScheduleList schedule={schedule} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; status: SelfControlStatus };

function formatTime(value: string | null): string {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function FocusHeader({ tone }: { tone: StatusTone }): ReactNode {
  return (
    <header style={titleRowStyle}>
      <StatusDot tone={tone} />
      <h1 style={h1Style}>Focus</h1>
    </header>
  );
}

export function FocusView({
  fetchStatus = defaultFetchStatus,
  releaseBlock = defaultReleaseBlock,
  schedule,
  activeSession,
}: FocusViewProps = {}): ReactNode {
  useFocusViewStyles();

  // Back-compat: explicit render overrides bypass the fetch path entirely.
  const hasOverride = schedule !== undefined || activeSession !== undefined;

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [releasing, setReleasing] = useState(false);
  const fetchRef = useRef(fetchStatus);
  fetchRef.current = fetchStatus;
  const releaseRef = useRef(releaseBlock);
  releaseRef.current = releaseBlock;

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetchRef
      .current()
      .then((status) => {
        if (!cancelled) setState({ kind: "ready", status });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load website blocking status.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const release = useCallback(() => {
    setReleasing(true);
    releaseRef
      .current()
      .catch(() => {
        // The follow-up refetch surfaces whatever state the engine is in; a
        // failed release leaves the active block visible rather than hidden.
      })
      .finally(() => {
        setReleasing(false);
        load();
      });
  }, [load]);

  // Initial fetch + settle-chained polling. The first load shows the loading
  // skeleton; thereafter we quietly refresh status in place (no skeleton flash)
  // ~15s after each settle, so the panel stays fresh with no Refresh button
  // required. Chaining off settle (rather than a fixed interval) means an
  // in-flight request never stacks a second timer.
  useEffect(() => {
    if (hasOverride) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const teardown = load();

    const scheduleQuietRefresh = () => {
      if (cancelled) return;
      timer = setTimeout(() => {
        fetchRef
          .current()
          .then((status) => {
            if (!cancelled) setState({ kind: "ready", status });
          })
          .catch(() => {
            // Keep the last good state on a transient failure; the next tick
            // re-attempts.
          })
          .finally(scheduleQuietRefresh);
      }, 15000);
    };
    scheduleQuietRefresh();

    return () => {
      cancelled = true;
      teardown();
      if (timer) clearTimeout(timer);
    };
  }, [hasOverride, load]);

  if (hasOverride) {
    return <OverrideView schedule={schedule} activeSession={activeSession} />;
  }

  if (state.kind === "loading") {
    return (
      <div style={containerStyle} data-testid="focus-loading">
        <FocusHeader tone="idle" />
        <div style={dimStyle}>Loading focus status…</div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div style={containerStyle} data-testid="focus-error">
        <FocusHeader tone="error" />
        <div style={sectionStyle}>
          <div style={dimStyle}>
            Couldn’t load focus status — <span>{state.message}</span>
          </div>
          <div>
            <button
              type="button"
              className="focus-view-btn focus-view-btn-primary"
              onClick={load}
              aria-label="Retry loading focus status"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { status } = state;

  // Disconnected / engine not available on this platform.
  if (!status.available) {
    return (
      <div style={containerStyle} data-testid="focus-unavailable">
        <FocusHeader tone="idle" />
        <div style={sectionStyle}>
          <div style={{ fontWeight: 600 }}>Focus blocking is unavailable</div>
          <div style={dimStyle}>
            The website-blocking engine isn’t available on this device
            (platform: {status.platform}).
          </div>
          {status.reason ? <div style={dimStyle}>{status.reason}</div> : null}
        </div>
      </div>
    );
  }

  // Permission / elevation required before a block can be applied.
  if (status.requiresElevation && !status.active) {
    return (
      <div style={containerStyle} data-testid="focus-permission">
        <FocusHeader tone="permission" />
        <div style={sectionStyle}>
          <div style={{ fontWeight: 600 }}>Permission needed</div>
          <div style={dimStyle}>
            Eliza needs administrator/root approval to edit the system hosts
            file before it can block websites.
          </div>
          {status.elevationPromptMethod ? (
            <div style={dimStyle}>
              Approval method: {status.elevationPromptMethod}
            </div>
          ) : (
            <div style={dimStyle}>
              This device can’t raise an approval prompt automatically.
            </div>
          )}
          {status.reason ? <div style={dimStyle}>{status.reason}</div> : null}
          <div style={dimStyle}>
            Ask the assistant to “enable website blocking” and approve the
            system prompt when it appears.
          </div>
        </div>
      </div>
    );
  }

  // Active block session.
  if (status.active) {
    return (
      <div style={containerStyle} data-testid="focus-active">
        <FocusHeader tone="active" />
        <section style={sectionStyle}>
          <div style={{ ...sectionStyle, gap: 8 }}>
            <div style={headerRowStyle}>
              <h2 style={h2Style}>Focus session active</h2>
              {status.canUnblockEarly ? (
                <ReleaseButton onActivate={release} disabled={releasing} />
              ) : null}
            </div>
            <div style={dimStyle}>
              Started {formatTime(status.startedAt)}
              {status.endsAt
                ? ` · ends ${formatTime(status.endsAt)}`
                : " · no end time"}
            </div>
            <div style={dimStyle}>Match mode: {status.matchMode}</div>
            <div style={dimStyle}>
              {status.blockedWebsites.length} website
              {status.blockedWebsites.length === 1 ? "" : "s"} blocked
            </div>
            {status.blockedWebsites.length > 0 ? (
              <ul style={listStyle} aria-label="Blocked websites">
                {status.blockedWebsites.map((site) => (
                  <li key={site} style={chipStyle}>
                    {site}
                  </li>
                ))}
              </ul>
            ) : null}
            {!status.canUnblockEarly && status.requiresElevation ? (
              <div style={dimStyle}>
                Releasing this block needs administrator/root approval. Ask the
                assistant to release it.
              </div>
            ) : null}
          </div>
        </section>
      </div>
    );
  }

  // Available, not active, nothing blocked.
  return (
    <div style={containerStyle} data-testid="focus-empty">
      <FocusHeader tone="idle" />
      <div style={sectionStyle}>
        <div style={dimStyle}>No active focus session.</div>
        <div style={dimStyle}>
          Say “block distractions for 1 hour” to start one.
        </div>
      </div>
    </div>
  );
}

export default FocusView;
