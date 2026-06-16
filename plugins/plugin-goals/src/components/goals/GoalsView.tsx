/**
 * GoalsView — life direction surface.
 *
 * Three primary sections (Life Goals / Routines / Today) plus a self-care
 * panel for mood + journal capture. Scaffold UI: renders static frames so the
 * view bundles and registers correctly. Real data wiring (goals repository,
 * GoalsCheckinService, follow-up watcher) comes in the foundations pass.
 */

import {
  CalendarCheck,
  HeartPulse,
  ListChecks,
  Sparkles,
  Sun,
  Target,
} from "lucide-react";
import type { ReactElement } from "react";

interface SectionProps {
  readonly title: string;
  readonly subtitle: string;
  readonly icon: ReactElement;
  readonly children?: ReactElement | ReactElement[] | string;
}

function Section({
  title,
  subtitle,
  icon,
  children,
}: SectionProps): ReactElement {
  return (
    <section
      style={{
        background: "rgba(255, 255, 255, 0.03)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        borderRadius: 16,
        padding: 20,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ display: "inline-flex" }}>{icon}</span>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{title}</h2>
          <p style={{ fontSize: 12, opacity: 0.65, margin: 0 }}>{subtitle}</p>
        </div>
      </header>
      <div style={{ fontSize: 13, opacity: 0.8 }}>{children}</div>
    </section>
  );
}

export function GoalsView(): ReactElement {
  return (
    <div
      style={{
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 24,
        height: "100%",
        overflowY: "auto",
      }}
    >
      <header>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Goals</h1>
        <p style={{ opacity: 0.65, marginTop: 6, fontSize: 13 }}>
          Owner-set long-horizon goals, recurring routines, reminders, alarms,
          and today's check-in.
        </p>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 16,
        }}
      >
        <Section
          title="Life Goals"
          subtitle="Long-horizon direction (quarter / year / life)"
          icon={<Target size={18} />}
        >
          {/* TODO(wire): list goals from goalsTable scoped by owner entity. */}
          No goals yet. Tell the agent what you want to head toward this year.
        </Section>

        <Section
          title="Routines"
          subtitle="Daily and weekly cadences"
          icon={<CalendarCheck size={18} />}
        >
          {/* TODO(wire): list routines from routinesTable; show next occurrence. */}
          Routine list will appear here once routines are seeded.
        </Section>

        <Section
          title="Today"
          subtitle="Reminders + alarms + the day's intentions"
          icon={<ListChecks size={18} />}
        >
          {/* TODO(wire): merge remindersTable + alarmsTable for today. */}
          Today's reminders and alarms will appear here.
        </Section>
      </div>

      <Section
        title="Self-care"
        subtitle="Mood, journal, gratitude — capture how you actually are"
        icon={<HeartPulse size={18} />}
      >
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div
            style={{
              flex: "1 1 200px",
              padding: 12,
              borderRadius: 12,
              background: "rgba(255, 255, 255, 0.04)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Sun size={16} />
            <div>
              <div style={{ fontWeight: 600 }}>Morning check-in</div>
              <div style={{ opacity: 0.65, fontSize: 12 }}>
                Not yet recorded today.
              </div>
            </div>
          </div>
          <div
            style={{
              flex: "1 1 200px",
              padding: 12,
              borderRadius: 12,
              background: "rgba(255, 255, 255, 0.04)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Sparkles size={16} />
            <div>
              <div style={{ fontWeight: 600 }}>Gratitude / journal</div>
              <div style={{ opacity: 0.65, fontSize: 12 }}>
                Tap the agent to capture a note.
              </div>
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}

export default GoalsView;
