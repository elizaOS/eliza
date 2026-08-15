/**
 * Regression tests for the RelativeTime leaf. Both the long and short render
 * paths must surface future timestamps as "in X" (not collapse to "now"), and
 * the short path must forward the translator for localized future labels.
 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSharedNowForTests } from "../../hooks/useSharedNow";
import { createTranslator } from "../../i18n";
import { RelativeTime } from "./RelativeTime";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// 2026-01-15T12:00:00.000Z — matches format.test.ts for consistency.
const NOW = 1768478400000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  __resetSharedNowForTests();
  cleanup();
});

describe("RelativeTime future timestamps", () => {
  it("renders the long path as 'in X' for a future timestamp", () => {
    render(<RelativeTime ts={NOW + 5 * MINUTE} data-testid="relative-time" />);
    expect(screen.getByTestId("relative-time").textContent).toBe("in 5m");
  });

  it("renders the short path as 'in X' instead of collapsing to 'now'", () => {
    render(
      <RelativeTime
        ts={NOW + 5 * MINUTE}
        short
        data-testid="relative-time-short"
      />,
    );
    expect(screen.getByTestId("relative-time-short").textContent).toBe("in 5m");
  });

  it("forwards the translator on the short path for localized future labels", () => {
    const t = createTranslator("en");
    render(
      <RelativeTime
        ts={NOW + 2 * HOUR}
        short
        t={t}
        data-testid="relative-time-short-i18n"
      />,
    );
    expect(screen.getByTestId("relative-time-short-i18n").textContent).toBe(
      "in 2h",
    );
  });

  it("forwards the translator on the long path for localized future labels", () => {
    const t = createTranslator("en");
    render(
      <RelativeTime
        ts={NOW + 2 * HOUR}
        t={t}
        data-testid="relative-time-long-i18n"
      />,
    );
    expect(screen.getByTestId("relative-time-long-i18n").textContent).toBe(
      "in 2h",
    );
  });

  it("keeps past-direction output unchanged on both paths", () => {
    const { rerender } = render(
      <RelativeTime ts={NOW - 5 * MINUTE} data-testid="relative-time-past" />,
    );
    expect(screen.getByTestId("relative-time-past").textContent).toBe("5m ago");

    rerender(
      <RelativeTime
        ts={NOW - 5 * MINUTE}
        short
        data-testid="relative-time-past-short"
      />,
    );
    expect(screen.getByTestId("relative-time-past-short").textContent).toBe(
      "5m",
    );
  });
});
