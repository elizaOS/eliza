// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", props, children),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement("input", props),
  SurfaceBadge: ({ children }: { children: React.ReactNode }) =>
    React.createElement("span", {}, children),
  SurfaceEmptyState: ({ title, body }: { title: string; body: string }) =>
    React.createElement("div", {}, `${title} ${body}`),
  SurfaceSection: ({
    children,
    title,
  }: {
    children: React.ReactNode;
    title: string;
  }) => React.createElement("section", {}, title, children),
  client: {
    getBaseUrl: vi.fn(() => ""),
    getRestAuthToken: vi.fn(() => "rest-token"),
  },
  selectLatestRunForApp: vi.fn(() => ({ run: null })),
  useApp: () => ({ appRuns: [], setActionNotice: vi.fn() }),
}));

import { interact, ScreenshareTuiView } from "./ScreenshareOperatorSurface";

const sampleCapabilities = {
  platform: "darwin",
  capabilities: {
    screenshot: { available: true, tool: "screencapture" },
    headfulGui: { available: true, tool: "quartz" },
    keyboard: { available: false, tool: "unavailable" },
  },
};

const sampleSession = {
  id: "session-1",
  label: "This machine",
  status: "active",
  createdAt: "2026-05-18T12:00:00.000Z",
  updatedAt: "2026-05-18T12:00:01.000Z",
  stoppedAt: null,
  platform: "darwin",
  frameCount: 2,
  inputCount: 1,
  lastFrameAt: "2026-05-18T12:00:01.000Z",
  lastInputAt: "2026-05-18T12:00:02.000Z",
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/apps/screenshare/capabilities") {
        return jsonResponse(sampleCapabilities);
      }
      if (url === "/api/apps/screenshare/sessions") {
        return jsonResponse({ sessions: [sampleSession] });
      }
      if (url === "/api/apps/screenshare/session" && init?.method === "POST") {
        return jsonResponse({
          session: sampleSession,
          token: "token-1",
          viewerUrl:
            "/api/apps/screenshare/viewer?sessionId=session-1&token=token-1",
        });
      }
      if (url.startsWith("/api/apps/screenshare/session/session-1?")) {
        return jsonResponse({ session: sampleSession });
      }
      if (
        url === "/api/apps/screenshare/session/session-1/stop" &&
        init?.method === "POST"
      ) {
        return jsonResponse({
          session: { ...sampleSession, status: "stopped", stoppedAt: "now" },
        });
      }
      if (
        url === "/api/apps/screenshare/session/session-1/input" &&
        init?.method === "POST"
      ) {
        return jsonResponse({
          success: true,
          message: "Keypress sent.",
          session: { ...sampleSession, inputCount: 2 },
        });
      }
      return jsonResponse({ error: `Unexpected ${url}` }, { status: 404 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("ScreenshareTuiView", () => {
  it("mounts sessions, capabilities, and TUI metadata", async () => {
    mockFetch();

    const { container } = render(React.createElement(ScreenshareTuiView));

    await screen.findByText("session-1 / active");
    expect(screen.getByText(/screenshot via screencapture/)).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(
      "/api/apps/screenshare/capabilities",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer rest-token",
        }),
      }),
    );

    const stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({
      viewType: "tui",
      viewId: "screenshare",
      platform: "darwin",
      sessionCount: 1,
      activeSessionCount: 1,
      capabilities: {
        screenshot: true,
        headfulGui: true,
        keyboard: false,
      },
    });
  });

  it("supports terminal capabilities for state, session lifecycle, input, and viewer URLs", async () => {
    mockFetch();

    await expect(interact("terminal-screenshare-state")).resolves.toMatchObject(
      {
        viewType: "tui",
        capabilities: sampleCapabilities,
        sessions: { sessions: [sampleSession] },
      },
    );

    await expect(
      interact("terminal-screenshare-start", { label: "Terminal" }),
    ).resolves.toMatchObject({
      viewType: "tui",
      session: sampleSession,
      token: "token-1",
    });

    await expect(
      interact("terminal-screenshare-session", {
        sessionId: "session-1",
        token: "token-1",
      }),
    ).resolves.toMatchObject({ viewType: "tui", session: sampleSession });

    await expect(
      interact("terminal-screenshare-input", {
        sessionId: "session-1",
        token: "token-1",
        type: "keypress",
        keys: "Enter",
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      success: true,
      message: "Keypress sent.",
    });

    await expect(
      interact("terminal-screenshare-stop", {
        sessionId: "session-1",
        token: "token-1",
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      session: { status: "stopped" },
    });

    await expect(
      interact("terminal-screenshare-viewer-url", {
        sessionId: "session-1",
        token: "token-1",
        baseUrl: "https://remote.example",
      }),
    ).resolves.toEqual({
      viewType: "tui",
      viewerUrl:
        "https://remote.example/api/apps/screenshare/viewer?sessionId=session-1&token=token-1&remoteBase=https%3A%2F%2Fremote.example",
    });
  });
});
