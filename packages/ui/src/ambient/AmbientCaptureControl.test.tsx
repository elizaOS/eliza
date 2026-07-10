/**
 * Tests the ambient capture control surface: consent gate before first start,
 * lifecycle buttons per state, duration formatting, and honest unsupported
 * copy.
 */

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AmbientCaptureControl,
  formatAmbientDuration,
} from "./AmbientCaptureControl";
import type { AmbientSessionSnapshot } from "./ambient-session-adapter";

afterEach(cleanup);

function snapshot(
  overrides: Partial<AmbientSessionSnapshot> = {},
): AmbientSessionSnapshot {
  return {
    status: "idle",
    transport: "batch",
    processingLocation: "on-device",
    deviceName: null,
    capturing: false,
    supported: true,
    error: null,
    ...overrides,
  };
}

const handlers = {
  onGrantConsent: vi.fn(),
  onStart: vi.fn(),
  onPause: vi.fn(),
  onResume: vi.fn(),
  onStop: vi.fn(),
};

describe("formatAmbientDuration", () => {
  it("formats mm:ss under an hour and h:mm:ss past it", () => {
    expect(formatAmbientDuration(0)).toBe("00:00");
    expect(formatAmbientDuration(65_000)).toBe("01:05");
    expect(formatAmbientDuration(3_725_000)).toBe("1:02:05");
  });
});

describe("AmbientCaptureControl", () => {
  it("shows the consent gate before consent is granted", () => {
    render(
      <AmbientCaptureControl
        snapshot={snapshot()}
        consent="ungranted"
        elapsedMs={0}
        resolvedCount={0}
        pendingCount={0}
        {...handlers}
      />,
    );
    expect(screen.getByTestId("ambient-consent-gate")).toBeTruthy();
    expect(screen.queryByTestId("ambient-start")).toBeNull();
  });

  it("shows Start once consent is granted", () => {
    render(
      <AmbientCaptureControl
        snapshot={snapshot()}
        consent="granted"
        elapsedMs={0}
        resolvedCount={0}
        pendingCount={0}
        {...handlers}
      />,
    );
    expect(screen.queryByTestId("ambient-consent-gate")).toBeNull();
    fireEvent.click(screen.getByTestId("ambient-start"));
    expect(handlers.onStart).toHaveBeenCalled();
  });

  it("shows Pause + Stop while capturing, with session stats", () => {
    render(
      <AmbientCaptureControl
        snapshot={snapshot({ status: "capturing", capturing: true })}
        consent="granted"
        elapsedMs={65_000}
        resolvedCount={3}
        pendingCount={1}
        {...handlers}
      />,
    );
    expect(screen.getByTestId("ambient-duration").textContent).toBe("01:05");
    expect(screen.getByTestId("ambient-segment-count").textContent).toContain(
      "3",
    );
    fireEvent.click(screen.getByTestId("ambient-pause"));
    expect(handlers.onPause).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("ambient-stop"));
    expect(handlers.onStop).toHaveBeenCalled();
  });

  it("shows Resume while paused", () => {
    render(
      <AmbientCaptureControl
        snapshot={snapshot({ status: "paused" })}
        consent="granted"
        elapsedMs={0}
        resolvedCount={0}
        pendingCount={0}
        {...handlers}
      />,
    );
    fireEvent.click(screen.getByTestId("ambient-resume"));
    expect(handlers.onResume).toHaveBeenCalled();
  });

  it("shows honest unsupported copy and no controls when unsupported", () => {
    render(
      <AmbientCaptureControl
        snapshot={snapshot({ status: "unsupported", supported: false })}
        consent="ungranted"
        elapsedMs={0}
        resolvedCount={0}
        pendingCount={0}
        {...handlers}
      />,
    );
    expect(screen.getByTestId("ambient-unsupported")).toBeTruthy();
    expect(screen.queryByTestId("ambient-consent-gate")).toBeNull();
    expect(screen.queryByTestId("ambient-start")).toBeNull();
  });
});
