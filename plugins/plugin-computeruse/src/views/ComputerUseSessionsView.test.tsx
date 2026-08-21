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
    id: "browser-1",
    label: "Chrome research",
    target: { kind: "browser", targetId: "chrome-profile" },
    status: "idle",
    sequence: 4,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:01.000Z",
    cursor: { x: 640, y: 360, updatedAt: "2026-08-18T00:00:01.000Z" },
    lastCommand: "click",
  },
  {
    id: "guest-1",
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
} {
  return {
    closeSession: vi.fn(async () => undefined),
    getFrame: vi.fn(async () => ({
      mimeType: "image/png" as const,
      data: "iVBORw0KGgo=",
      capturedAt: "2026-08-18T00:00:03.000Z",
      width: 1280,
      height: 720,
    })),
    listSessions: vi.fn(async () => sessions),
  };
}

afterEach(() => cleanup());

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
      screen.getByTitle("Linux guest viewer").getAttribute("sandbox"),
    ).toBe("allow-scripts");
  });

  it("requests a native always-on-top viewer and closes a selected session", async () => {
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
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() =>
      expect(api.closeSession).toHaveBeenCalledWith("browser-1"),
    );
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
