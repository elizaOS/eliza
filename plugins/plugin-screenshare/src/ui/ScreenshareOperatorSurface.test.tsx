// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The operator surface reads from useApp()/selectLatestRunForApp(), renders
// @elizaos/ui primitives (Button/Input/SurfaceSection/SurfaceEmptyState), and
// pulls useAgentElement from @elizaos/ui/agent-surface. We mock both module
// specifiers with deterministic DOM so we can assert real behavior of every
// control without dragging in the full UI runtime.

// vi.mock factories are hoisted above imports, so the spies they reference must
// be created via vi.hoisted (not plain top-level const).
const { setActionNotice, getBaseUrl, getRestAuthToken, selectLatestRunResult } =
  vi.hoisted(() => ({
    setActionNotice: vi.fn(),
    getBaseUrl: vi.fn(() => ""),
    getRestAuthToken: vi.fn(() => "rest-token"),
    // Mutable so individual tests can inject a launched run with a viewer URL.
    selectLatestRunResult: { run: null } as {
      run: { viewer?: { url?: string } } | null;
    },
  }));

vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    type: _type,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    // The operator surface always renders type="button"; pin the literal so the
    // mock stays a11y-lint-clean while behavior is unchanged.
    React.createElement("button", { type: "button", ...props }, children),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement("input", props),
  SurfaceEmptyState: ({ title, body }: { title: string; body: string }) =>
    React.createElement(
      "div",
      { "data-testid": "empty-state" },
      `${title} ${body}`,
    ),
  SurfaceSection: ({
    children,
    title,
  }: {
    children: React.ReactNode;
    title: string;
  }) =>
    React.createElement(
      "section",
      { "aria-label": title },
      React.createElement("h3", {}, title),
      children,
    ),
  client: {
    getBaseUrl,
    getRestAuthToken,
  },
  selectLatestRunForApp: vi.fn(() => selectLatestRunResult),
  useApp: () => ({ appRuns: [], setActionNotice }),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import { ScreenshareOperatorSurface } from "./ScreenshareOperatorSurface";

// REAL DesktopControlCapabilities shape (matches @elizaos/plugin-computeruse
// detectDesktopControlCapabilities(): keys screenshot/computerUse/windowList/
// headfulGui, each { available, tool }). Verified against the live function in
// ScreenshareOperatorSurface.contract.test.ts.
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
      if (override) {
        return override;
      }
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
const writeText = vi.fn(() => Promise.resolve());

beforeEach(() => {
  selectLatestRunResult.run = null;
  getBaseUrl.mockReturnValue("");
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

function capabilitiesUrls(): string[] {
  return fetchCalls
    .map((call) => call.url)
    .filter((url) => url === "/api/apps/screenshare/capabilities");
}

describe("ScreenshareOperatorSurface — populated data", () => {
  it("renders the three host metric tiles and a capability tile per real key", async () => {
    installFetch();
    render(React.createElement(ScreenshareOperatorSurface, { focus: "all" }));

    // Capabilities load on mount; wait for the Capabilities section to appear.
    await screen.findByRole("region", { name: "Capabilities" });

    // Host metric tiles (role="status", aria-label "<label>: <value>").
    expect(screen.getByLabelText("Session: idle")).toBeTruthy();
    // Platform value comes from capabilities.platform.
    expect(screen.getByLabelText("Platform: linux")).toBeTruthy();
    // GUI tile value is the literal "GUI" string; the icon is driven by
    // headfulGui.available. We assert the active class on the tile container.
    const guiTile = screen.getByLabelText("GUI: GUI");
    expect(guiTile.className).toContain("border-ok/35");

    // Capabilities section renders one tile per REAL capability key.
    const capsSection = screen.getByRole("region", { name: "Capabilities" });
    for (const name of [
      "headfulGui",
      "screenshot",
      "computerUse",
      "windowList",
    ]) {
      expect(within(capsSection).getByText(name)).toBeTruthy();
    }
    // Tile title is `${name}: ${tool}` — verify both an available and an
    // unavailable capability render with their real tool string.
    expect(
      capsSection.querySelector('[title="screenshot: scrot"]'),
    ).toBeTruthy();
    expect(
      capsSection.querySelector(
        '[title="windowList: none (install wmctrl or xdotool)"]',
      ),
    ).toBeTruthy();
  });

  it("renders the chat-focus empty state instead of the host surface", () => {
    installFetch();
    render(React.createElement(ScreenshareOperatorSurface, { focus: "chat" }));

    expect(
      screen.getByText(
        "Screen Share Remote desktop control is available from the actions surface.",
      ),
    ).toBeTruthy();
    // No host controls in the chat branch.
    expect(screen.queryByText("Start session")).toBeNull();
  });
});

describe("ScreenshareOperatorSurface — host lifecycle controls", () => {
  it("starts a session (POST body label), shows the telemetry grid, and flips the button to Rotate", async () => {
    installFetch();
    render(React.createElement(ScreenshareOperatorSurface, { focus: "all" }));
    await screen.findByRole("region", { name: "Capabilities" });

    // Initially idle; telemetry grid (Frames/Inputs) not rendered.
    expect(screen.getByLabelText("Session: idle")).toBeTruthy();
    expect(screen.queryByLabelText(/^Frames:/)).toBeNull();

    fireEvent.click(screen.getByText("Start session"));

    // Session becomes active and the button label flips.
    await screen.findByText("Rotate session");
    expect(screen.getByLabelText("Session: active")).toBeTruthy();

    // POST body carried the host label.
    const startCall = fetchCalls.find(
      (c) =>
        c.url === "/api/apps/screenshare/session" && c.init?.method === "POST",
    );
    expect(startCall).toBeTruthy();
    expect(JSON.parse(String(startCall?.init?.body))).toEqual({
      label: "This machine",
    });

    // Telemetry grid appears with the fixture's real counts + formatted times.
    expect(screen.getByLabelText("Frames: 7")).toBeTruthy();
    expect(screen.getByLabelText("Inputs: 3")).toBeTruthy();
    const lastFrame = new Date(activeSession.lastFrameAt).toLocaleTimeString();
    expect(screen.getByLabelText(`Last frame: ${lastFrame}`)).toBeTruthy();

    expect(setActionNotice).toHaveBeenCalledWith(
      "Screen share session started.",
      "success",
      2400,
    );
  });

  it("stops the active session via POST /stop with the X-Screenshare-Token header and body token", async () => {
    installFetch();
    render(React.createElement(ScreenshareOperatorSurface, { focus: "all" }));
    await screen.findByRole("region", { name: "Capabilities" });

    fireEvent.click(screen.getByText("Start session"));
    await screen.findByText("Rotate session");

    fireEvent.click(screen.getByText("Stop"));

    await vi.waitFor(() => {
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

    // Session reverts to stopped status in the tile.
    await screen.findByLabelText("Session: stopped");
  });

  it("Open host viewer is disabled until a session exists, then opens the host viewer URL", async () => {
    installFetch();
    render(React.createElement(ScreenshareOperatorSurface, { focus: "all" }));
    await screen.findByRole("region", { name: "Capabilities" });

    const openButton = screen.getByText("Open").closest("button");
    expect(openButton?.disabled).toBe(true);

    fireEvent.click(screen.getByText("Start session"));
    await screen.findByText("Rotate session");

    expect(screen.getByText("Open").closest("button")?.disabled).toBe(false);
    fireEvent.click(screen.getByText("Open"));
    expect(openSpy).toHaveBeenCalledWith(
      "/api/apps/screenshare/viewer?sessionId=host-1&token=host-token",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("Copy host details writes the connection JSON to the clipboard", async () => {
    installFetch();
    render(React.createElement(ScreenshareOperatorSurface, { focus: "all" }));
    await screen.findByRole("region", { name: "Capabilities" });

    expect(screen.getByText("Copy").closest("button")?.disabled).toBe(true);

    fireEvent.click(screen.getByText("Start session"));
    await screen.findByText("Rotate session");

    fireEvent.click(screen.getByText("Copy"));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    const payload = JSON.parse(writeText.mock.calls[0][0] as string);
    expect(payload).toMatchObject({
      sessionId: "host-1",
      token: "host-token",
      viewerUrl:
        "/api/apps/screenshare/viewer?sessionId=host-1&token=host-token",
    });
    expect(setActionNotice).toHaveBeenCalledWith(
      "Screen share details copied.",
      "success",
      1800,
    );
  });
});

describe("ScreenshareOperatorSurface — connect form", () => {
  it("enables Connect only after id+token are filled and opens the built viewer URL with remoteBase", async () => {
    installFetch();
    render(React.createElement(ScreenshareOperatorSurface, { focus: "all" }));
    await screen.findByRole("region", { name: "Capabilities" });

    // The Connect button carries aria-label "Connect to remote"; getByText
    // "Connect" alone collides with the section title, so target by role+name.
    const connectButton = () =>
      screen.getByRole("button", { name: "Connect to remote" });
    expect(connectButton().disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Server URL"), {
      target: { value: "https://remote.example/" },
    });
    fireEvent.change(screen.getByPlaceholderText("Session"), {
      target: { value: "remote-session" },
    });
    // Still disabled with only id filled.
    expect(connectButton().disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Token"), {
      target: { value: "remote-token" },
    });
    expect(connectButton().disabled).toBe(false);

    fireEvent.click(connectButton());
    // Trailing slash on base is stripped; remoteBase query param is appended.
    expect(openSpy).toHaveBeenCalledWith(
      "https://remote.example/api/apps/screenshare/viewer?sessionId=remote-session&token=remote-token&remoteBase=https%3A%2F%2Fremote.example",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("Refresh capabilities re-fetches GET /capabilities", async () => {
    installFetch();
    render(React.createElement(ScreenshareOperatorSurface, { focus: "all" }));
    await screen.findByRole("region", { name: "Capabilities" });

    expect(capabilitiesUrls().length).toBe(1);

    fireEvent.click(screen.getByLabelText("Refresh capabilities"));
    await vi.waitFor(() => expect(capabilitiesUrls().length).toBe(2));
  });
});

describe("ScreenshareOperatorSurface — launched session", () => {
  it("parses run.viewer.url and loads the session via GET /session/:id?token=", async () => {
    selectLatestRunResult.run = {
      viewer: {
        url: "/api/apps/screenshare/viewer?sessionId=host-1&token=host-token",
      },
    };
    installFetch();
    render(React.createElement(ScreenshareOperatorSurface, { focus: "all" }));

    // The launched-session effect fires GET /session/host-1?token=host-token.
    await vi.waitFor(() => {
      const sessionCall = fetchCalls.find((c) =>
        c.url.startsWith("/api/apps/screenshare/session/host-1?token="),
      );
      expect(sessionCall).toBeTruthy();
    });

    // Host metrics populate from the launched session (active + telemetry).
    await screen.findByLabelText("Session: active");
    expect(screen.getByLabelText("Frames: 7")).toBeTruthy();
    expect(screen.getByLabelText("Inputs: 3")).toBeTruthy();
  });
});
