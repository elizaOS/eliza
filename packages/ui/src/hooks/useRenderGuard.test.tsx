// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RENDER_TELEMETRY_EVENT,
  type RenderTelemetryEvent,
  useRenderGuard,
} from "./useRenderGuard";

function Probe({ name }: { name: string }) {
  useRenderGuard(name);
  return null;
}

function collectTelemetry(): {
  events: RenderTelemetryEvent[];
  dispose: () => void;
} {
  const events: RenderTelemetryEvent[] = [];
  const onTelemetry = (event: Event) => {
    events.push((event as CustomEvent<RenderTelemetryEvent>).detail);
  };
  window.addEventListener(RENDER_TELEMETRY_EVENT, onTelemetry);
  return {
    events,
    dispose: () =>
      window.removeEventListener(RENDER_TELEMETRY_EVENT, onTelemetry),
  };
}

describe("useRenderGuard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays silent for an ordinary burst of renders", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const { rerender } = render(<Probe name="Quiet" />);
    // A dozen quick renders models startup churn / a few interactions — well
    // below the loop thresholds, so it must produce no telemetry.
    for (let i = 0; i < 12; i += 1) {
      rerender(<Probe name="Quiet" />);
    }

    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("escalates info then error under a runaway render loop", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { events, dispose } = collectTelemetry();

    try {
      const { rerender } = render(<Probe name="Loop" />);
      // Far exceed ERROR_THRESHOLD within a single sub-second tick.
      for (let i = 0; i < 200; i += 1) {
        rerender(<Probe name="Loop" />);
      }

      const severities = events.map((event) => event.severity);
      expect(severities).toContain("info");
      expect(severities).toContain("error");
      // Escalation order: info is emitted before error.
      expect(severities.indexOf("info")).toBeLessThan(
        severities.indexOf("error"),
      );
      // Error latches, so it is emitted at most once.
      expect(
        severities.filter((severity) => severity === "error"),
      ).toHaveLength(1);
      expect(events.every((event) => event.name === "Loop")).toBe(true);
    } finally {
      dispose();
    }
  });

  it("does not carry render counts across telemetry names", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { events, dispose } = collectTelemetry();

    try {
      const { rerender } = render(<Probe name="First" />);
      // Switch names before reaching any threshold; the window resets.
      rerender(<Probe name="Second" />);
      for (let i = 0; i < 200; i += 1) {
        rerender(<Probe name="Second" />);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.name === "Second")).toBe(true);
    } finally {
      dispose();
    }
  });
});
