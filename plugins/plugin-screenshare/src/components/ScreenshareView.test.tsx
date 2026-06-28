// @vitest-environment jsdom

// Drives the unified ScreenshareView (the single GUI/XR data wrapper) through
// the rendered DOM: the same component the bundle exports for both the "gui"
// and "xr" modalities. Asserts the host lifecycle (start/rotate/stop), the
// open-viewer + copy controls, the editable remote-connect fields + connect,
// the capability list, the refresh, and the error path all reach the screenshare
// API with the exact arguments — the single source of truth for the GUI/XR
// surface now that the per-modality operator/TUI duplicates are retired.

import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

configure({ asyncUtilTimeout: 5000 });

// Mutable so individual tests can inject a launched run with a viewer URL.
const uiState = vi.hoisted(() => ({
  appRuns: [] as unknown[],
  run: null as { viewer?: { url?: string } } | null,
  getBaseUrl: vi.fn(() => ""),
  getRestAuthToken: vi.fn(() => "rest-token"),
}));

vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: uiState.getBaseUrl,
    getRestAuthToken: uiState.getRestAuthToken,
  },
  selectLatestRunForApp: vi.fn(() => ({ run: uiState.run })),
  useAppSelector: <T,>(selector: (s: { appRuns: unknown[] }) => T): T =>
    selector({ appRuns: uiState.appRuns }),
}));

import { ScreenshareView } from "./ScreenshareView";

const realShapeCapabilities = {
  platform: "linux",
  capabilities: {
    headfulGui: { available: true, tool: "desktop session" },
    screenshot: { available: true, tool: "scrot" },
    computerUse: { available: true, tool: "xdotool" },
    windowList: { available: false, tool: "none (install wmctrl or xdotool)" },
  },
};

const activeSession = {
  id: "host-1",
  label: "This machine",
  status: "active" as const,
  createdAt: "2026-05-18T12:00:00.000Z",
  updatedAt: "2026-05-18T12:00:01.000Z",
  stoppedAt: null,
  platform: "linux",
  frameCount: 7,
  inputCount: 3,
  lastFrameAt: "2026-05-18T12:00:05.000Z",
  lastInputAt: "2026-05-18T12:00:06.000Z",
};

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(
  routes?: (url: string, init?: RequestInit) => Response | undefined,
) {
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      const override = routes?.(url, init);
      if (override) return override;
      if (url === "/api/apps/screenshare/capabilities") {
        return jsonResponse(realShapeCapabilities);
      }
      if (url === "/api/apps/screenshare/session" && init?.method === "POST") {
        return jsonResponse({
          session: activeSession,
          token: "host-token",
          viewerUrl:
            "/api/apps/screenshare/viewer?sessionId=host-1&token=host-token",
        });
      }
      if (
        url === "/api/apps/screenshare/session/host-1/stop" &&
        init?.method === "POST"
      ) {
        return jsonResponse({
          session: { ...activeSession, status: "stopped", stoppedAt: "now" },
        });
      }
      if (url.startsWith("/api/apps/screenshare/session/host-1?")) {
        return jsonResponse({ session: activeSession });
      }
      return jsonResponse({ error: `Unexpected ${url}` }, 404);
    }),
  );
}

const openSpy = vi.fn();
const writeText = vi.fn((_text: string) => Promise.resolve());

function agentEl(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

function capabilitiesUrls(): string[] {
  return fetchCalls
    .map((call) => call.url)
    .filter((url) => url === "/api/apps/screenshare/capabilities");
}

beforeEach(() => {
  uiState.run = null;
  uiState.appRuns = [];
  uiState.getBaseUrl.mockReturnValue("");
  vi.stubGlobal("open", openSpy);
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("ScreenshareView — capabilities + host lifecycle", () => {
  it("loads capabilities on mount and renders one row per real capability key", async () => {
    installFetch();
    render(React.createElement(ScreenshareView));

    await screen.findByText("headfulGui");
    expect(capabilitiesUrls().length).toBe(1);
    for (const name of [
      "headfulGui",
      "screenshot",
      "computerUse",
      "windowList",
    ]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    // The capability tool strings render alongside each name.
    expect(screen.getByText("scrot")).toBeTruthy();
  });

  it("starts a session (POST body label), shows telemetry, and flips Start → Rotate", async () => {
    installFetch();
    render(React.createElement(ScreenshareView));
    await screen.findByText("headfulGui");

    expect(agentEl("start").textContent).toBe("Start host session");

    fireEvent.click(agentEl("start"));

    await waitFor(() =>
      expect(agentEl("start").textContent).toBe("Rotate host session"),
    );

    const startCall = fetchCalls.find(
      (c) =>
        c.url === "/api/apps/screenshare/session" && c.init?.method === "POST",
    );
    expect(startCall).toBeTruthy();
    expect(JSON.parse(String(startCall?.init?.body))).toEqual({
      label: "This machine",
    });

    // Telemetry now reflects the fixture counts.
    expect(screen.getByText("Frames: 7")).toBeTruthy();
    expect(screen.getByText("Inputs: 3")).toBeTruthy();
  });

  it("stops the active session via POST /stop with token body + header", async () => {
    installFetch();
    render(React.createElement(ScreenshareView));
    await screen.findByText("headfulGui");

    fireEvent.click(agentEl("start"));
    await waitFor(() =>
      expect(agentEl("start").textContent).toBe("Rotate host session"),
    );

    fireEvent.click(agentEl("stop"));

    await waitFor(() => {
      const stopCall = fetchCalls.find(
        (c) => c.url === "/api/apps/screenshare/session/host-1/stop",
      );
      expect(stopCall).toBeTruthy();
      expect(stopCall?.init?.method).toBe("POST");
      expect(JSON.parse(String(stopCall?.init?.body))).toEqual({
        token: "host-token",
      });
      expect(
        (stopCall?.init?.headers as Record<string, string>)[
          "X-Screenshare-Token"
        ],
      ).toBe("host-token");
    });
  });

  it("Open viewer is disabled until a session exists, then opens the host viewer URL", async () => {
    installFetch();
    render(React.createElement(ScreenshareView));
    await screen.findByText("headfulGui");

    expect(agentEl("open-viewer").hasAttribute("disabled")).toBe(true);

    fireEvent.click(agentEl("start"));
    await waitFor(() =>
      expect(agentEl("start").textContent).toBe("Rotate host session"),
    );

    expect(agentEl("open-viewer").hasAttribute("disabled")).toBe(false);
    fireEvent.click(agentEl("open-viewer"));
    expect(openSpy).toHaveBeenCalledWith(
      "/api/apps/screenshare/viewer?sessionId=host-1&token=host-token",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("Copy writes the host connection JSON to the clipboard", async () => {
    installFetch();
    render(React.createElement(ScreenshareView));
    await screen.findByText("headfulGui");

    fireEvent.click(agentEl("start"));
    await waitFor(() =>
      expect(agentEl("start").textContent).toBe("Rotate host session"),
    );

    fireEvent.click(agentEl("copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    const payload = JSON.parse(writeText.mock.calls[0][0] as string);
    expect(payload).toMatchObject({
      sessionId: "host-1",
      token: "host-token",
      viewerUrl:
        "/api/apps/screenshare/viewer?sessionId=host-1&token=host-token",
    });
  });
});

describe("ScreenshareView — connect form", () => {
  it("enables Connect only once session id + token are filled, then opens the built viewer URL", async () => {
    installFetch();
    render(React.createElement(ScreenshareView));
    await screen.findByText("headfulGui");

    expect(agentEl("connect").hasAttribute("disabled")).toBe(true);

    fireEvent.change(agentEl("input-remote-base"), {
      target: { value: "https://remote.example/" },
    });
    fireEvent.change(agentEl("input-remote-session"), {
      target: { value: "remote-session" },
    });
    // Still disabled with only id filled.
    expect(agentEl("connect").hasAttribute("disabled")).toBe(true);

    fireEvent.change(agentEl("input-remote-token"), {
      target: { value: "remote-token" },
    });
    await waitFor(() =>
      expect(agentEl("connect").hasAttribute("disabled")).toBe(false),
    );

    fireEvent.click(agentEl("connect"));
    expect(openSpy).toHaveBeenCalledWith(
      "https://remote.example/api/apps/screenshare/viewer?sessionId=remote-session&token=remote-token&remoteBase=https%3A%2F%2Fremote.example",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("Refresh re-fetches GET /capabilities", async () => {
    installFetch();
    render(React.createElement(ScreenshareView));
    await screen.findByText("headfulGui");
    expect(capabilitiesUrls().length).toBe(1);

    fireEvent.click(agentEl("refresh"));
    await waitFor(() => expect(capabilitiesUrls().length).toBe(2));
  });
});

describe("ScreenshareView — launched session + errors", () => {
  it("parses run.viewer.url and loads the session via GET /session/:id?token=", async () => {
    uiState.run = {
      viewer: {
        url: "/api/apps/screenshare/viewer?sessionId=host-1&token=host-token",
      },
    };
    installFetch();
    render(React.createElement(ScreenshareView));

    await waitFor(() => {
      const sessionCall = fetchCalls.find((c) =>
        c.url.startsWith("/api/apps/screenshare/session/host-1?token="),
      );
      expect(sessionCall).toBeTruthy();
    });

    await screen.findByText("This machine");
    expect(screen.getByText("Frames: 7")).toBeTruthy();
  });

  it("renders the error text when the capability fetch rejects", async () => {
    installFetch((url) =>
      url === "/api/apps/screenshare/capabilities"
        ? jsonResponse({ error: "caps exploded" }, 500)
        : undefined,
    );
    render(React.createElement(ScreenshareView));
    await screen.findByText("caps exploded");
  });
});
