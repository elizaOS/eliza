/**
 * FocusView — overlay view for the Focus / blocker app.
 *
 * Shows the user's block schedule, active block sessions, and a placeholder
 * affordance for starting a new focus session. This is the minimal view
 * scaffold; the real interactive controls will be wired up alongside the
 * service migration from plugin-lifeops.
 */

import type { CSSProperties, ReactNode } from "react";

interface FocusViewProps {
  /** Optional list of scheduled blocks to render. */
  schedule?: ReadonlyArray<FocusScheduleEntry>;
  /** Currently active block session, when one exists. */
  activeSession?: FocusActiveSession | null;
}

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

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: 24,
  height: "100%",
  boxSizing: "border-box",
  background: "var(--background, #0a0a0a)",
  color: "var(--foreground, #f5f5f5)",
  fontFamily: "system-ui, sans-serif",
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const headerStyle: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 600,
};

const cardStyle: CSSProperties = {
  padding: 12,
  borderRadius: 8,
  border: "1px solid var(--border, rgba(255,255,255,0.08))",
  background: "var(--surface, rgba(255,255,255,0.02))",
};

const dimStyle: CSSProperties = {
  opacity: 0.6,
  fontSize: 13,
};

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

export function FocusView({
  schedule,
  activeSession,
}: FocusViewProps = {}): ReactNode {
  return (
    <div style={containerStyle}>
      <header style={sectionStyle}>
        <h1 style={headerStyle}>Focus</h1>
        <div style={dimStyle}>
          Website + app blocking. Migration in progress — schedule and override
          controls land alongside the plugin-lifeops extraction.
        </div>
      </header>
      <section style={sectionStyle}>
        <h2 style={headerStyle}>Active</h2>
        <ActiveSessionCard session={activeSession ?? null} />
      </section>
      <section style={sectionStyle}>
        <h2 style={headerStyle}>Schedule</h2>
        <ScheduleList schedule={schedule} />
      </section>
    </div>
  );
}

export default FocusView;
