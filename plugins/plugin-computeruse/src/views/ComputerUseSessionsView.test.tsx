// @vitest-environment jsdom
/**
 * Exercises the session monitor with an injected authenticated API boundary.
 * The deterministic harness verifies frames, virtual cursors, floating-window
 * intent, mutation handling, and explicit transport failure state.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputerUseSessionsView,
  type ComputerUseSessionsViewApi,
  type SessionSnapshot,
} from "./ComputerUseSessionsView.js";

const sessions: SessionSnapshot[] = [
  {
    contractVersion: 2,
    id: "browser-1",
    ownerId: "local-owner",
    adapterId: "computeruse.browser",
    canonicalState: "ready",
    isolationMode: "managed_browser",
    generation: 1,
    label: "Chrome research",
    target: { kind: "browser", targetId: "chrome-profile" },
    status: "idle",
    sequence: 4,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:01.000Z",
    cursor: { x: 640, y: 360, updatedAt: "2026-08-18T00:00:01.000Z" },
    lastCommand: "click",
    lastControlMode: "coordinate_fallback",
    lastPhysicalPointerBorrowed: true,
    lastFallbackDisclosure: "Coordinate fallback restored the pointer.",
  },
  {
    contractVersion: 2,
    id: "guest-1",
    ownerId: "local-owner",
    adapterId: "computeruse.remote_guest",
    canonicalState: "running",
    isolationMode: "remote_session",
    generation: 1,
    label: "Linux guest",
    target: {
      kind: "remote_guest",
      targetId: "qemu-linux",
      viewerUrl: "https://viewer.example.test/session",
    },
    status: "running",
    sequence: 9,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:02.000Z",
  },
];

function makeApi(): ComputerUseSessionsViewApi & {
  closeSession: ReturnType<typeof vi.fn>;
  getFrame: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  pauseSession: ReturnType<typeof vi.fn>;
  resumeSession: ReturnType<typeof vi.fn>;
  stopSession: ReturnType<typeof vi.fn>;
} {
  return {
    closeSession: vi.fn(async () => undefined),
    pauseSession: vi.fn(async () => undefined),
    resumeSession: vi.fn(async () => undefined),
    stopSession: vi.fn(async () => undefined),
    getFrame: vi.fn(async () => ({
      mimeType: "image/png" as const,
      data: "iVBORw0KGgo=",
      capturedAt: "2026-08-18T00:00:03.000Z",
      width: 1280,
      height: 720,
      provenance: {
        observationId: "browser-1:observation:5",
        sequence: 5,
        observedAt: "2026-08-18T00:00:03.000Z",
        sha256:
          "8f8cbb7dcf46e0bc7d53265749a6c17d116093a6ba95e442764060c76fd4a86c",
        mimeType: "image/png" as const,
        source: "browser" as const,
      },
    })),
    listSessions: vi.fn(async () => ({
      sessions,
      events: [
        {
          eventId: 1,
          type: "observation.captured",
          sessionId: "browser-1",
          occurredAt: "2026-08-18T00:00:03.000Z",
        },
      ],
      readiness: {
        capture: { available: true, tool: "fixture" },
        input: { available: true, tool: "fixture" },
        browser: { available: true, tool: "fixture" },
        vision: { available: true, modelType: "IMAGE_DESCRIPTION" },
        approvalMode: "smart_approve",
      },
    })),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ComputerUseSessionsView", () => {
  it("renders independent targets, a frame, and a virtual cursor", async () => {
    const api = makeApi();
    render(
      <ComputerUseSessionsView
        api={api}
        snapshotPollMs={60_000}
        framePollMs={60_000}
      />,
    );

    expect(screen.getByText("Loading sessions…")).toBeTruthy();
    await screen.findByText("Chrome research");
    expect(screen.getByText("Linux guest")).toBeTruthy();
    await waitFor(() =>
      expect(api.getFrame).toHaveBeenCalledWith("browser-1", expect.anything()),
    );
    expect(
      await screen.findByAltText("Chrome research latest frame"),
    ).toBeTruthy();
    expect(screen.getByLabelText("Virtual cursor at 640, 360")).toBeTruthy();
    expect(
      screen.getByText("Coordinate fallback restored the pointer."),
    ).toBeTruthy();
    expect(screen.getByText("Capture: ready")).toBeTruthy();
    expect(screen.getByText("Vision: ready")).toBeTruthy();
    expect(
      screen.getByText(/Observation 5 · browser · 8f8cbb7dcf/),
    ).toBeTruthy();
    expect(screen.getByText("observation.captured")).toBeTruthy();
    expect(
      screen.getByTitle("Linux guest viewer").getAttribute("sandbox"),
    ).toBe("allow-scripts");
  });

  it("requests a native always-on-top viewer and exposes pause and stop", async () => {
    const api = makeApi();
    const openFloatingWindow = vi.fn(async () => true);
    render(
      <ComputerUseSessionsView
        api={api}
        framePollMs={60_000}
        openFloatingWindow={openFloatingWindow}
        snapshotPollMs={60_000}
      />,
    );

    await screen.findByText("Chrome research");
    fireEvent.click(screen.getByText("Open floating"));
    await waitFor(() => expect(openFloatingWindow).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(api.pauseSession).toHaveBeenCalledWith("browser-1"),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Stop" })[0]);
    await waitFor(() =>
      expect(api.stopSession).toHaveBeenCalledWith("browser-1"),
    );
  });

  it("keeps the selected live session visible in a short landscape viewport", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("max-height: 500px"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      })),
    );
    const api = makeApi();
    render(
      <ComputerUseSessionsView
        api={api}
        snapshotPollMs={60_000}
        framePollMs={60_000}
      />,
    );

    expect(
      await screen.findByAltText("Chrome research latest frame"),
    ).toBeTruthy();
    expect(screen.getByText("Sequence 4 · Cursor 640, 360")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("keeps list failures distinct and retryable", async () => {
    const api = makeApi();
    api.listSessions.mockRejectedValueOnce(
      new Error("session transport offline"),
    );
    render(
      <ComputerUseSessionsView
        api={api}
        snapshotPollMs={60_000}
        framePollMs={60_000}
      />,
    );

    expect(await screen.findByText("session transport offline")).toBeTruthy();
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByText("Chrome research")).toBeTruthy();
  });
});
