// @vitest-environment jsdom

/**
 * GoalsView is currently a SCAFFOLD (see the banner in GoalsView.tsx): it renders
 * static frames so the view bundles and registers correctly, with no live data
 * wiring (goalsTable / routinesTable / remindersTable / alarmsTable /
 * GoalsCheckinService) and no interactive controls. Its de-facto contract is:
 *   - the "Goals" <h1> header + description,
 *   - three sections (Life Goals / Routines / Today) with verbatim subtitles +
 *     placeholder copy,
 *   - a "Self-care" panel with two cards (Morning check-in / Gratitude / journal)
 *     and their verbatim copy.
 *
 * These tests assert that contract verbatim, then assert — as a tripwire — that
 * the view exposes ZERO interactive controls (buttons / inputs / links). When
 * the four tables + check-in service are wired and the first real control or
 * data row lands, the relevant assertion fails loudly, forcing the follow-up
 * that replaces these scaffold assertions with populated-data + interaction
 * coverage.
 *
 * External-API contract test: N/A. The view performs no fetch / no /api call /
 * no parser hook (dataSource: none), so there is no real API shape to validate.
 *
 * TUI / XR contract test: N/A. The plugin declares a single `gui` view and no
 * `interact()` capability, so there is no terminal surface to exercise.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { GoalsView } from "../src/components/goals/GoalsView.tsx";

afterEach(() => {
  cleanup();
});

describe("GoalsView (scaffold contract)", () => {
  it("renders the page header and description", () => {
    render(<GoalsView />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Goals" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Owner-set long-horizon goals, recurring routines, reminders, alarms, and today's check-in.",
      ),
    ).toBeTruthy();
  });

  it("renders the three primary sections with their verbatim subtitles + placeholder copy", () => {
    render(<GoalsView />);

    const sections: Array<{ title: string; subtitle: string; body: string }> = [
      {
        title: "Life Goals",
        subtitle: "Long-horizon direction (quarter / year / life)",
        body: "No goals yet. Tell the agent what you want to head toward this year.",
      },
      {
        title: "Routines",
        subtitle: "Daily and weekly cadences",
        body: "Routine list will appear here once routines are seeded.",
      },
      {
        title: "Today",
        subtitle: "Reminders + alarms + the day's intentions",
        body: "Today's reminders and alarms will appear here.",
      },
    ];

    for (const { title, subtitle, body } of sections) {
      // the section heading is an <h2>; its enclosing <section> is the contract unit
      const heading = screen.getByRole("heading", { level: 2, name: title });
      expect(heading).toBeTruthy();
      const section = heading.closest("section");
      expect(section).toBeTruthy();
      const region = within(section as HTMLElement);
      expect(region.getByText(subtitle)).toBeTruthy();
      expect(region.getByText(body)).toBeTruthy();
    }
  });

  it("renders the Self-care panel with both cards and their verbatim copy", () => {
    render(<GoalsView />);

    const selfCareHeading = screen.getByRole("heading", {
      level: 2,
      name: "Self-care",
    });
    expect(selfCareHeading).toBeTruthy();
    const selfCare = selfCareHeading.closest("section");
    expect(selfCare).toBeTruthy();
    const region = within(selfCare as HTMLElement);

    expect(
      region.getByText(
        "Mood, journal, gratitude — capture how you actually are",
      ),
    ).toBeTruthy();

    // Card 1: Morning check-in
    expect(region.getByText("Morning check-in")).toBeTruthy();
    expect(region.getByText("Not yet recorded today.")).toBeTruthy();

    // Card 2: Gratitude / journal
    expect(region.getByText("Gratitude / journal")).toBeTruthy();
    expect(region.getByText("Tap the agent to capture a note.")).toBeTruthy();
  });

  it("renders exactly four <section> frames (3 primary + self-care)", () => {
    const { container } = render(<GoalsView />);
    expect(container.querySelectorAll("section")).toHaveLength(4);
  });

  it("exposes ZERO interactive controls (tripwire for the data-wiring migration)", () => {
    const { container } = render(<GoalsView />);

    // No ARIA-addressable interactive roles.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);

    // No raw interactive DOM elements either.
    expect(
      container.querySelectorAll("button, input, a, select, textarea"),
    ).toHaveLength(0);
  });
});
