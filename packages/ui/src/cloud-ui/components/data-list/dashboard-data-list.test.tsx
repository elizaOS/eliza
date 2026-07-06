// @vitest-environment jsdom

/**
 * Regression guard for the "banner shows N but the table is empty" console bug.
 *
 * The console bundle concatenates two independent Tailwind builds (the app's
 * `@elizaos/ui/styles` and cloud-ui's own `@import "tailwindcss"`). That emits a
 * SECOND base `.hidden{display:none}` AFTER the responsive `.md:block` rule —
 * same specificity, later wins — so any `hidden md:block` element is pinned to
 * `display:none` at every width. Every `DashboardDataListDesktop` table (agents,
 * API keys, …) rendered invisible while its stats banner still showed a count.
 *
 * The fix: the desktop wrapper must hide-below-md via `max-md:hidden` + the div's
 * default block display, and must NOT carry the bare `hidden` base class. This
 * test fails if someone reintroduces `hidden`/`md:block` on the desktop wrapper.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DashboardDataListDesktop,
  DashboardDataListMobile,
} from "./dashboard-data-list";

afterEach(cleanup);

describe("DashboardDataListDesktop — duplicate-Tailwind clobber guard", () => {
  it("hides below md via max-md:hidden and NEVER via the bare `hidden` base class", () => {
    const { getByTestId } = render(
      <DashboardDataListDesktop>
        <div data-testid="row">row</div>
      </DashboardDataListDesktop>,
    );
    const wrapper = getByTestId("row").parentElement as HTMLElement;
    const classes = wrapper.className.split(/\s+/);

    // The bare `hidden` class is the one the duplicated base stylesheet clobbers
    // back on at md+, so it must never appear on this wrapper.
    expect(classes).not.toContain("hidden");
    expect(classes).not.toContain("md:block");
    expect(classes).toContain("max-md:hidden");
  });

  it("renders its children (rows reach the DOM)", () => {
    const { getByTestId } = render(
      <DashboardDataListDesktop>
        <div data-testid="row">row</div>
      </DashboardDataListDesktop>,
    );
    expect(getByTestId("row").textContent).toBe("row");
  });

  it("mobile wrapper still hides at md+ via md:hidden (it has no bare `hidden`)", () => {
    const { getByTestId } = render(
      <DashboardDataListMobile>
        <div data-testid="card">card</div>
      </DashboardDataListMobile>,
    );
    const wrapper = getByTestId("card").parentElement as HTMLElement;
    const classes = wrapper.className.split(/\s+/);
    expect(classes).toContain("md:hidden");
    expect(classes).not.toContain("hidden");
  });
});
