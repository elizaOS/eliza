/**
 * Tests the always-visible recording indicator: it communicates state via a
 * word (never icon-only), marks the capturing state on a data attribute, and
 * states processing location honestly while active.
 */

// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AmbientRecordingIndicator } from "./AmbientRecordingIndicator";

afterEach(cleanup);

describe("AmbientRecordingIndicator", () => {
  it("shows a LISTENING word + capturing flag while capturing", () => {
    render(
      <AmbientRecordingIndicator
        status="capturing"
        processingLocation="cloud"
      />,
    );
    const el = screen.getByTestId("ambient-recording-indicator");
    expect(el.getAttribute("data-capturing")).toBe("true");
    expect(screen.getByTestId("ambient-recording-word").textContent).toBe(
      "Listening",
    );
    expect(screen.getByTestId("ambient-processing-location").textContent).toBe(
      "cloud",
    );
  });

  it("shows PAUSED and clears the capturing flag when paused", () => {
    render(
      <AmbientRecordingIndicator
        status="paused"
        processingLocation="on-device"
      />,
    );
    const el = screen.getByTestId("ambient-recording-indicator");
    expect(el.getAttribute("data-capturing")).toBe("false");
    expect(screen.getByTestId("ambient-recording-word").textContent).toBe(
      "Paused",
    );
    expect(screen.getByTestId("ambient-processing-location").textContent).toBe(
      "on-device",
    );
  });

  it("shows OFF and hides the location line when idle", () => {
    render(
      <AmbientRecordingIndicator status="idle" processingLocation="cloud" />,
    );
    expect(screen.getByTestId("ambient-recording-word").textContent).toBe(
      "Off",
    );
    expect(screen.queryByTestId("ambient-processing-location")).toBeNull();
  });
});
