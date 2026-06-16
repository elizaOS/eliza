// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { HealthView } from "./HealthView.js";

/**
 * HealthView is currently a STUB (see the migration banner in HealthView.tsx):
 * it renders no live data and exposes no interactive controls. Its only
 * dynamic behavior is the `ownerName`-interpolated subtitle, and its de-facto
 * contract is the set of five named sections with their verbatim blurbs.
 *
 * These tests assert that contract exactly. The five "Placeholder" badge
 * assertions are an intentional tripwire: the moment a section is wired to real
 * data and drops its badge, this test fails loudly, forcing the follow-up that
 * replaces these stub assertions with populated-data + interaction coverage.
 */
describe("HealthView", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the header and falls back to the 'Owner' subtitle when no ownerName prop is given", () => {
    render(<HealthView />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Health" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Sleep, circadian rhythm, screen-time, and activity for Owner.",
      ),
    ).toBeTruthy();
  });

  it("renders all five named sections with their verbatim blurbs", () => {
    render(<HealthView />);

    const sections: Array<{ name: string; blurb: string }> = [
      {
        name: "Sleep",
        blurb:
          "Latest sleep episode, duration, efficiency, and the rolling baseline window.",
      },
      {
        name: "Circadian",
        blurb:
          "Wake / bedtime anchors, regularity score, and current scheduling window.",
      },
      {
        name: "Screen-time",
        blurb:
          "Today vs. weekly average, top apps and sites, plus the active focus window.",
      },
      {
        name: "Activity",
        blurb:
          "Steps, active minutes, calories, heart-rate windows, and recent workouts.",
      },
      {
        name: "Connectors",
        blurb:
          "Apple Health, Google Fit, Strava, Fitbit, Withings, and Oura connection status.",
      },
    ];

    for (const { name, blurb } of sections) {
      // each Section sets aria-label={title}, so the region is addressable by name
      const region = screen.getByRole("region", { name });
      expect(region).toBeTruthy();
      // section heading + blurb are scoped to the matching region
      expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
      expect(region.textContent).toContain(blurb);
    }
  });

  it("renders exactly five 'Placeholder' stub badges (tripwire for the live-data migration)", () => {
    render(<HealthView />);
    expect(screen.getAllByText("Placeholder")).toHaveLength(5);
  });

  it("interpolates the supplied ownerName into the subtitle and drops the 'Owner' fallback", () => {
    render(<HealthView ownerName="Dana" />);

    expect(
      screen.getByText(
        "Sleep, circadian rhythm, screen-time, and activity for Dana.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Sleep, circadian rhythm, screen-time, and activity for Owner.",
      ),
    ).toBeNull();
  });
});
