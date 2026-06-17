// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CalendarView } from "./CalendarView.js";

/**
 * CalendarView is the registered top-level calendar view and is currently a
 * STUB (see the MIGRATION STATUS banner in CalendarView.tsx): it renders no
 * live event data and its only interaction is the Day/Week/Month tab switcher
 * that toggles `aria-selected` and the tabpanel copy.
 *
 * These tests assert that contract exactly. The "Inline conflicts ... No
 * conflicts detected." assertion is an intentional tripwire: the moment this
 * view is wired to the real feed (CalendarSection / useCalendarWeek) and starts
 * rendering conflicts, this test will fail loudly, forcing the follow-up that
 * replaces these stub assertions with populated-data coverage.
 */
describe("CalendarView (registered stub)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the header and subtitle", () => {
    render(<CalendarView />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Calendar" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Unified Google + Apple calendar feed with inline conflict detection.",
      ),
    ).toBeTruthy();
  });

  it("renders the three view-mode tabs with Week selected by default", () => {
    render(<CalendarView />);

    const tablist = screen.getByRole("tablist", { name: "Calendar view mode" });
    expect(tablist).toBeTruthy();

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Day",
      "Week",
      "Month",
    ]);

    // Default activeTab is "week".
    expect(
      screen.getByRole("tab", { name: "Week" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: "Day" }).getAttribute("aria-selected"),
    ).toBe("false");
    expect(
      screen.getByRole("tab", { name: "Month" }).getAttribute("aria-selected"),
    ).toBe("false");

    // The tabpanel shows the week copy by default.
    expect(screen.getByRole("tabpanel").textContent).toContain(
      "Week view — 7-day event grid.",
    );
  });

  it("switches the active tab and tabpanel copy when a different tab is clicked", () => {
    render(<CalendarView />);

    fireEvent.click(screen.getByRole("tab", { name: "Day" }));
    expect(
      screen.getByRole("tab", { name: "Day" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: "Week" }).getAttribute("aria-selected"),
    ).toBe("false");
    expect(screen.getByRole("tabpanel").textContent).toContain(
      "Day view — events for the selected day.",
    );

    fireEvent.click(screen.getByRole("tab", { name: "Month" }));
    expect(
      screen.getByRole("tab", { name: "Month" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: "Day" }).getAttribute("aria-selected"),
    ).toBe("false");
    expect(screen.getByRole("tabpanel").textContent).toContain(
      "Month view — 5/6-row day grid.",
    );
  });

  it("honors the initialTab prop", () => {
    render(<CalendarView initialTab="month" />);

    expect(
      screen.getByRole("tab", { name: "Month" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toContain(
      "Month view — 5/6-row day grid.",
    );
  });

  it("renders the inline-conflicts aside with its placeholder copy (stub tripwire)", () => {
    render(<CalendarView />);

    const aside = screen.getByRole("complementary", {
      name: "Inline conflicts",
    });
    expect(aside).toBeTruthy();
    expect(aside.textContent).toContain("Inline conflicts");
    expect(aside.textContent).toContain("No conflicts detected.");
  });
});
