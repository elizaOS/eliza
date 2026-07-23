// @vitest-environment jsdom
//
// Renders the real AppRouteNotFound and drives its recovery actions through the
// real browser-history navigation seam (navigateBrowserPath -> shellHistory):
// slug display, the stale-bookmark "Open <label>" action, and Browse apps.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppRouteNotFound } from "./AppRouteNotFound";

beforeEach(() => {
  window.history.replaceState(null, "", "/apps/ghost");
});

afterEach(() => {
  cleanup();
});

describe("AppRouteNotFound", () => {
  it("names the dead route and states nothing is mounted there", () => {
    render(<AppRouteNotFound slug="ghost" />);
    expect(screen.getByTestId("app-route-not-found")).toBeTruthy();
    expect(screen.getByText("/apps/ghost")).toBeTruthy();
    expect(
      screen.getByText(
        "No app or view is mounted at this address on this device.",
      ),
    ).toBeTruthy();
  });

  it("opens the canonical path when a view id matches the slug elsewhere", () => {
    render(
      <AppRouteNotFound
        slug="settings"
        matchedView={{ label: "Settings", path: "/settings" }}
      />,
    );
    const open = screen.getByTestId("app-route-not-found-open-view");
    expect(open.textContent).toContain("Open Settings");
    fireEvent.click(open);
    expect(window.location.pathname).toBe("/settings");
  });

  it("renders only Browse apps without a match and navigates to the launcher", () => {
    render(<AppRouteNotFound slug="ghost" />);
    expect(screen.queryByTestId("app-route-not-found-open-view")).toBeNull();
    fireEvent.click(screen.getByTestId("app-route-not-found-browse-apps"));
    expect(window.location.pathname).toBe("/apps");
  });
});
