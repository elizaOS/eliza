// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  type FocusActiveSession,
  type FocusScheduleEntry,
  FocusView,
} from "./FocusView.js";

/**
 * FocusView is currently a props-driven display STUB (see the migration banner
 * in FocusView.tsx): no interactive controls exist yet, so these tests cover
 * the full display contract — the static header, both empty-state branches, and
 * every populated-data branch with specific values.
 *
 * The verbatim migration subtitle assertion in the first test is an intentional
 * tripwire: when the real schedule / override controls are wired in and the
 * subtitle changes, this test fails loudly, forcing interaction coverage to be
 * added alongside the new controls.
 */
describe("FocusView", () => {
  afterEach(() => {
    cleanup();
  });

  const MIGRATION_SUBTITLE =
    "Website + app blocking. Migration in progress — schedule and override controls land alongside the plugin-lifeops extraction.";

  it("renders the static header and both empty states when called with no props", () => {
    render(<FocusView />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Focus" }),
    ).toBeTruthy();
    // Verbatim subtitle — stub tripwire for the controls migration.
    expect(screen.getByText(MIGRATION_SUBTITLE)).toBeTruthy();

    expect(
      screen.getByRole("heading", { level: 2, name: "Active" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Schedule" }),
    ).toBeTruthy();

    expect(screen.getByText("No active focus session.")).toBeTruthy();
    expect(screen.getByText("No scheduled blocks.")).toBeTruthy();
  });

  it("shows the empty active-session state for both null and undefined activeSession", () => {
    // `activeSession ?? null` then `if (!session)` — exercise both inputs.
    const { rerender } = render(<FocusView activeSession={null} />);
    expect(screen.getByText("No active focus session.")).toBeTruthy();
    expect(screen.queryByText("Focus session active")).toBeNull();

    rerender(<FocusView activeSession={undefined} />);
    expect(screen.getByText("No active focus session.")).toBeTruthy();
    expect(screen.queryByText("Focus session active")).toBeNull();
  });

  it("renders a populated active session WITH an end time", () => {
    const session: FocusActiveSession = {
      id: "session-1",
      startedAt: "10:00",
      endsAt: "11:30",
      ruleCount: 7,
    };

    render(<FocusView activeSession={session} />);

    expect(screen.getByText("Focus session active")).toBeTruthy();
    // The "Started {startedAt} · ends {endsAt}" branch renders as one node.
    const startedLine = screen.getByText(/Started 10:00/);
    expect(startedLine.textContent).toBe("Started 10:00 · ends 11:30");
    expect(screen.getByText("7 rules enforced")).toBeTruthy();

    expect(screen.queryByText("No active focus session.")).toBeNull();
  });

  it("renders a populated active session WITHOUT an end time (omits the 'ends' suffix)", () => {
    const session: FocusActiveSession = {
      id: "session-2",
      startedAt: "08:15",
      endsAt: null,
      ruleCount: 1,
    };

    render(<FocusView activeSession={session} />);

    expect(screen.getByText("Focus session active")).toBeTruthy();
    const startedLine = screen.getByText(/Started 08:15/);
    expect(startedLine.textContent).toBe("Started 08:15");
    expect(startedLine.textContent).not.toContain("ends");
    expect(screen.getByText("1 rules enforced")).toBeTruthy();
  });

  it("renders a populated schedule with multiple entries (website + app targets)", () => {
    const schedule: ReadonlyArray<FocusScheduleEntry> = [
      {
        id: "entry-web",
        label: "Deep work",
        target: "website",
        startsAt: "09:00",
        endsAt: "17:00",
      },
      {
        id: "entry-app",
        label: "Lunch detox",
        target: "app",
        startsAt: "12:00",
        endsAt: "13:00",
      },
    ];

    render(<FocusView schedule={schedule} />);

    const list = screen.getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);

    // Per-entry label.
    expect(within(items[0]).getByText("Deep work")).toBeTruthy();
    expect(within(items[1]).getByText("Lunch detox")).toBeTruthy();

    // The "{target} · {startsAt} → {endsAt}" dim line, for both targets.
    expect(screen.getByText("website · 09:00 → 17:00")).toBeTruthy();
    expect(screen.getByText("app · 12:00 → 13:00")).toBeTruthy();

    expect(screen.queryByText("No scheduled blocks.")).toBeNull();
  });

  it("shows the empty schedule state for both undefined and an empty array", () => {
    // `!schedule || schedule.length === 0` — exercise both inputs.
    const { rerender } = render(<FocusView schedule={undefined} />);
    expect(screen.getByText("No scheduled blocks.")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();

    rerender(<FocusView schedule={[]} />);
    expect(screen.getByText("No scheduled blocks.")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("renders active session and schedule together without leaking either empty state", () => {
    const session: FocusActiveSession = {
      id: "session-3",
      startedAt: "06:00",
      endsAt: "07:00",
      ruleCount: 3,
    };
    const schedule: ReadonlyArray<FocusScheduleEntry> = [
      {
        id: "entry-1",
        label: "Morning focus",
        target: "website",
        startsAt: "06:00",
        endsAt: "08:00",
      },
    ];

    render(<FocusView activeSession={session} schedule={schedule} />);

    expect(screen.getByText("Focus session active")).toBeTruthy();
    expect(screen.getByText("3 rules enforced")).toBeTruthy();
    expect(screen.getByText("Morning focus")).toBeTruthy();
    expect(screen.getByText("website · 06:00 → 08:00")).toBeTruthy();

    // Neither empty placeholder should appear when both regions are populated.
    expect(screen.queryByText("No active focus session.")).toBeNull();
    expect(screen.queryByText("No scheduled blocks.")).toBeNull();
  });
});
