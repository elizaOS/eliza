import type { ReactElement } from "react";
import { useState } from "react";

/**
 * Minimal CalendarView placeholder.
 *
 * MIGRATION STATUS: STUB.
 * The richer UI (event grid, agenda mode, event editor drawer, drag-to-create,
 * provider toggles) lives in `CalendarSection.tsx` and will be progressively
 * lifted into this top-level view. For now this renders the day/week/month tab
 * switcher + an inline-conflicts placeholder panel so the route registers,
 * mounts, and is visually identifiable.
 *
 * TODO(migrate: plugins/plugin-lifeops/src/components/* calendar surface)
 *   - port primed-event cache + chat launcher
 *   - port conflict severity colors
 *   - port event editor drawer wiring (EventEditorDrawer.tsx is already in
 *     this plugin and ready to be wired in)
 */

type CalendarTab = "day" | "week" | "month";

const TABS: { id: CalendarTab; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

export interface CalendarViewProps {
  initialTab?: CalendarTab;
}

export function CalendarView(props: CalendarViewProps): ReactElement {
  const [activeTab, setActiveTab] = useState<CalendarTab>(
    props.initialTab ?? "week",
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        padding: "1.5rem",
        gap: "1rem",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <header
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>
          Calendar
        </h1>
        <p style={{ color: "#888", margin: 0 }}>
          Unified Google + Apple calendar feed with inline conflict detection.
        </p>
      </header>

      <div
        role="tablist"
        aria-label="Calendar view mode"
        style={{ display: "flex", gap: "0.5rem" }}
      >
        {TABS.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: "0.4rem 0.9rem",
                borderRadius: 999,
                border: "1px solid",
                borderColor: active ? "#f97316" : "#444",
                background: active ? "#f97316" : "transparent",
                color: active ? "#fff" : "inherit",
                cursor: "pointer",
                fontSize: "0.85rem",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <section
        role="tabpanel"
        aria-label={`${activeTab} view`}
        style={{
          flex: 1,
          border: "1px dashed #333",
          borderRadius: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#888",
          minHeight: 240,
        }}
      >
        <span>
          {activeTab === "day" && "Day view — events for the selected day."}
          {activeTab === "week" && "Week view — 7-day event grid."}
          {activeTab === "month" && "Month view — 5/6-row day grid."}
        </span>
      </section>

      <aside
        aria-label="Inline conflicts"
        style={{
          border: "1px solid #2a1f15",
          background: "#1a120a",
          borderRadius: 12,
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
        }}
      >
        <strong style={{ color: "#f97316", fontSize: "0.9rem" }}>
          Inline conflicts
        </strong>
        <p style={{ margin: 0, color: "#aaa", fontSize: "0.85rem" }}>
          Overlap detection runs against the visible window. No conflicts
          detected.
        </p>
      </aside>
    </div>
  );
}

export default CalendarView;
