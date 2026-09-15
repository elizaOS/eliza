/**
 * Verifies that the shared home-dashboard fixture preserves the typed response
 * contracts consumed by shell services mounted alongside the widgets.
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { installHomeWidgetFetchMock } from "./home-widget-mock-data";

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

describe("home widget fetch fixture", () => {
  it("returns the canonical empty pending-actions response", async () => {
    restoreFetch = installHomeWidgetFetchMock();

    const response = await window.fetch("/api/approvals");

    await expect(response.json()).resolves.toEqual({ pending: [] });
  });
});
