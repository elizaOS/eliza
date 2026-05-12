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

describe("useRenderGuard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs at two quick renders and errors at three quick renders", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const events: RenderTelemetryEvent[] = [];
    const onTelemetry = (event: Event) => {
      events.push((event as CustomEvent<RenderTelemetryEvent>).detail);
    };
    window.addEventListener(RENDER_TELEMETRY_EVENT, onTelemetry);

    try {
      const { rerender } = render(<Probe name="RenderProbe" />);

      rerender(<Probe name="RenderProbe" />);
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('"RenderProbe" rendered 2 times'),
        expect.objectContaining({
          name: "RenderProbe",
          renderCount: 2,
          severity: "info",
        }),
      );

      rerender(<Probe name="RenderProbe" />);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('"RenderProbe" rendered 3 times'),
        expect.objectContaining({
          name: "RenderProbe",
          renderCount: 3,
          severity: "error",
        }),
      );
      expect(events.map((event) => event.severity)).toEqual(["info", "error"]);
    } finally {
      window.removeEventListener(RENDER_TELEMETRY_EVENT, onTelemetry);
    }
  });
});
