import {
  type AnyRenderTelemetryEvent,
  RenderTelemetryProfiler,
  setRenderTelemetrySink,
  useRenderGuard,
} from "@elizaos/ui/cloud-ui/runtime/render-telemetry";
import { act, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

function GuardedRerenderer() {
  useRenderGuard("GuardedRerenderer");
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (count < 2) {
      setCount((value) => value + 1);
    }
  }, [count]);

  return <div>{count}</div>;
}

function ProfiledRerenderer() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (count < 2) {
      setCount((value) => value + 1);
    }
  }, [count]);

  return <div>{count}</div>;
}

describe("render telemetry", () => {
  afterEach(() => {
    setRenderTelemetrySink(null);
    vi.restoreAllMocks();
  });

  it("emits guard telemetry with route and render stack context", async () => {
    const events: AnyRenderTelemetryEvent[] = [];
    setRenderTelemetrySink((event) => events.push(event));
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      render(<GuardedRerenderer />);
    });

    const guardEvent = events.find(
      (event) => event.source === "useRenderGuard",
    );
    expect(guardEvent).toBeDefined();
    expect(guardEvent).toMatchObject({
      source: "useRenderGuard",
      name: "GuardedRerenderer",
      route: "/",
    });
    expect(guardEvent?.sequence).toBeGreaterThan(0);
    expect(guardEvent?.stack).toContain("GuardedRerenderer");
  });

  it("emits profiler telemetry for repeated commits at the app shell", async () => {
    const events: AnyRenderTelemetryEvent[] = [];
    setRenderTelemetrySink((event) => events.push(event));
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await act(async () => {
      render(
        <RenderTelemetryProfiler id="TestRoot">
          <ProfiledRerenderer />
        </RenderTelemetryProfiler>,
      );
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        source: "ReactProfiler",
        name: "TestRoot",
        route: "/",
      }),
    );
  });
});
