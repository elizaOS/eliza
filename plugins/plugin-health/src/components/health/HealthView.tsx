import type { ReactElement, ReactNode } from "react";

/**
 * Minimal HealthView placeholder.
 *
 * MIGRATION STATUS: STUB.
 * TODO(migrate: plugins/plugin-lifeops UI surfaces for health/sleep/screen-time)
 *
 * The fully-realized HealthView (live sleep chart, regularity score,
 * screen-time breakdowns, connector status table) will be ported in a
 * follow-up pass. For now this view renders the five top-level sections so
 * the registered route mounts cleanly and is visually identifiable.
 */

interface SectionProps {
  title: string;
  blurb: string;
  children?: ReactNode;
}

function Section({ title, blurb, children }: SectionProps): ReactElement {
  return (
    <section
      aria-label={title}
      style={{
        border: "1px dashed #333",
        borderRadius: 12,
        padding: "1rem 1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        background: "rgba(255,255,255,0.02)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "1rem",
        }}
      >
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, margin: 0 }}>
          {title}
        </h2>
        <span
          style={{
            fontSize: "0.7rem",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "#888",
          }}
        >
          Placeholder
        </span>
      </header>
      <p style={{ margin: 0, color: "#aaa", fontSize: "0.9rem" }}>{blurb}</p>
      {children}
    </section>
  );
}

export interface HealthViewProps {
  /** Owner display name shown in the header. */
  ownerName?: string;
}

export function HealthView(props: HealthViewProps): ReactElement {
  const ownerName = props.ownerName ?? "Owner";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        padding: "1.5rem",
        gap: "1rem",
        fontFamily: "system-ui, sans-serif",
        overflowY: "auto",
      }}
    >
      <header
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.25rem",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>
          Health
        </h1>
        <p style={{ color: "#888", margin: 0 }}>
          {`Sleep, circadian rhythm, screen-time, and activity for ${ownerName}.`}
        </p>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "1rem",
        }}
      >
        <Section
          title="Sleep"
          blurb="Latest sleep episode, duration, efficiency, and the rolling baseline window."
        />
        <Section
          title="Circadian"
          blurb="Wake / bedtime anchors, regularity score, and current scheduling window."
        />
        <Section
          title="Screen-time"
          blurb="Today vs. weekly average, top apps and sites, plus the active focus window."
        />
        <Section
          title="Activity"
          blurb="Steps, active minutes, calories, heart-rate windows, and recent workouts."
        />
        <Section
          title="Connectors"
          blurb="Apple Health, Google Fit, Strava, Fitbit, Withings, and Oura connection status."
        />
      </div>
    </div>
  );
}

export default HealthView;
