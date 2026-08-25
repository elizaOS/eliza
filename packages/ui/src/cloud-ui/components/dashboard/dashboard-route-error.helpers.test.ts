/**
 * Tests for the dashboard route error message formatter
 * (`formatDashboardRouteErrorMessage`): the pure branch table that maps an
 * unknown route-error value to user-facing text. Deterministic, no I/O.
 */
import { describe, expect, it } from "vitest";
import { formatDashboardRouteErrorMessage } from "./dashboard-route-error.helpers";

const FALLBACK = "An unexpected error occurred while loading this page.";

describe("formatDashboardRouteErrorMessage", () => {
  it("returns the message of a plain Error instance", () => {
    expect(formatDashboardRouteErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns the message of an Error subclass via instanceof", () => {
    expect(
      formatDashboardRouteErrorMessage(new TypeError("not a function")),
    ).toBe("not a function");
  });

  it("returns an empty string for an Error constructed with an empty message", () => {
    expect(formatDashboardRouteErrorMessage(new Error(""))).toBe("");
  });

  it("passes a non-empty string through unchanged", () => {
    expect(formatDashboardRouteErrorMessage("network unreachable")).toBe(
      "network unreachable",
    );
  });

  it("preserves whitespace and unicode in string input", () => {
    expect(formatDashboardRouteErrorMessage("  402: 支払いが必要 🚧 ")).toBe(
      "  402: 支払いが必要 🚧 ",
    );
  });

  it("returns an empty string for empty-string input instead of the fallback", () => {
    expect(formatDashboardRouteErrorMessage("")).toBe("");
  });

  it("falls back for null", () => {
    expect(formatDashboardRouteErrorMessage(null)).toBe(FALLBACK);
  });

  it("falls back for undefined", () => {
    expect(formatDashboardRouteErrorMessage(undefined)).toBe(FALLBACK);
  });

  it("uses one stable fallback string shared by both nullish branches", () => {
    expect(formatDashboardRouteErrorMessage(null)).toBe(
      formatDashboardRouteErrorMessage(undefined),
    );
  });
});
