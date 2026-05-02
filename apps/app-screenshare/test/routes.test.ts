import { Buffer } from "node:buffer";
import type http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const desktop = vi.hoisted(() => ({
  captureDesktopScreenshot: vi.fn(() => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  detectDesktopControlCapabilities: vi.fn(() => ({
    headfulGui: { available: true, tool: "desktop session" },
    screenshot: { available: true, tool: "screencapture" },
    computerUse: { available: true, tool: "AppleScript" },
    windowList: { available: true, tool: "AppleScript" },
  })),
  getDesktopPlatformName: vi.fn(() => "darwin" as NodeJS.Platform),
  listDesktopWindows: vi.fn(() => [
    { id: "1", app: "Finder", title: "Desktop" },
  ]),
  performDesktopClick: vi.fn(),
  performDesktopDoubleClick: vi.fn(),
  performDesktopKeypress: vi.fn(),
  performDesktopMouseMove: vi.fn(),
  performDesktopScroll: vi.fn(),
  performDesktopTextInput: vi.fn(),
}));

vi.mock("@elizaos/agent/services/desktop-control", () => desktop);

import { handleAppRoutes, prepareLaunch } from "../src/routes";

interface PublicSession {
  id: string;
  label: string;
  status: "active" | "stopped";
  frameCount: number;
  inputCount: number;
}

interface StartSessionResponse {
  session: PublicSession;
  token: string;
  viewerUrl: string;
}

interface CapturedResponse {
  handled: boolean;
  status: number;
  headers: Record<string, string | number | readonly string[]>;
  json: unknown;
  error: string | null;
  body: Buffer | string | null;
}

type RouteContext = Parameters<typeof handleAppRoutes>[0];

async function callRoute(
  method: string,
  path: string,
  body?: Record<string, unknown> | null,
  headers: http.IncomingHttpHeaders = {},
): Promise<CapturedResponse> {
  const url = new URL(path, "http://localhost");
  const captured: CapturedResponse = {
    handled: false,
    status: 200,
    headers: {},
    json: null,
    error: null,
    body: null,
  };
  const res = {
    writeHead(
      status: number,
      responseHeaders: Record<string, string | number | readonly string[]>,
    ) {
      captured.status = status;
      captured.headers = responseHeaders;
    },
    end(data?: Buffer | string) {
      captured.body = data ?? null;
    },
  };

  const ctx: RouteContext = {
    method,
    pathname: url.pathname,
    url,
    req: { headers } as http.IncomingMessage,
    res,
    runtime: null,
    json: (_response, data, status = 200) => {
      captured.status = status;
      captured.json = data;
    },
    error: (_response, message, status = 500) => {
      captured.status = status;
      captured.error = message;
      captured.json = { error: message };
    },
    readJsonBody: async <T extends object = Record<string, unknown>>() =>
      body === null ? null : ((body ?? {}) as T),
  };

  captured.handled = await handleAppRoutes(ctx);
  return captured;
}

function asStartResponse(response: CapturedResponse): StartSessionResponse {
  return response.json as StartSessionResponse;
}

function asSessionResponse(response: CapturedResponse): {
  session: PublicSession;
} {
  return response.json as { session: PublicSession };
}

function htmlBody(response: CapturedResponse): string {
  return Buffer.isBuffer(response.body)
    ? response.body.toString("utf8")
    : String(response.body ?? "");
}

describe("app-screenshare routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts one active host session and stops the previous local session", async () => {
    const first = asStartResponse(
      await callRoute("POST", "/api/apps/screenshare/session", {
        label: "Support Mac",
      }),
    );

    expect(first.session.label).toBe("Support Mac");
    expect(first.session.status).toBe("active");
    expect(first.token).toBeTruthy();
    expect(first.viewerUrl).toContain(encodeURIComponent(first.session.id));

    const firstFrame = await callRoute(
      "GET",
      `/api/apps/screenshare/session/${first.session.id}/frame?token=${encodeURIComponent(
        first.token,
      )}`,
    );
    expect(firstFrame.status).toBe(200);
    expect(firstFrame.headers["Content-Type"]).toBe("image/png");

    const second = asStartResponse(
      await callRoute("POST", "/api/apps/screenshare/session", {
        label: "Rotated Mac",
      }),
    );

    expect(second.session.id).not.toBe(first.session.id);
    expect(second.token).not.toBe(first.token);

    const staleFrame = await callRoute(
      "GET",
      `/api/apps/screenshare/session/${first.session.id}/frame?token=${encodeURIComponent(
        first.token,
      )}`,
    );
    expect(staleFrame.status).toBe(409);
    expect(staleFrame.error).toBe("Screen share session is stopped.");
  });

  it("requires the session token for frames and input", async () => {
    const started = asStartResponse(
      await callRoute("POST", "/api/apps/screenshare/session"),
    );

    const deniedFrame = await callRoute(
      "GET",
      `/api/apps/screenshare/session/${started.session.id}/frame?token=wrong`,
    );
    expect(deniedFrame.status).toBe(403);

    const deniedInput = await callRoute(
      "POST",
      `/api/apps/screenshare/session/${started.session.id}/input`,
      { token: "wrong", type: "click", x: 10, y: 20, button: "left" },
    );
    expect(deniedInput.status).toBe(403);
    expect(desktop.performDesktopClick).not.toHaveBeenCalled();
  });

  it("validates keypresses before sending desktop input", async () => {
    const started = asStartResponse(
      await callRoute("POST", "/api/apps/screenshare/session"),
    );

    const rejected = await callRoute(
      "POST",
      `/api/apps/screenshare/session/${started.session.id}/input`,
      { token: started.token, type: "keypress", keys: "Command+Shift+💥" },
    );
    expect(rejected.status).toBe(400);
    expect(desktop.performDesktopKeypress).not.toHaveBeenCalled();

    const accepted = await callRoute(
      "POST",
      `/api/apps/screenshare/session/${started.session.id}/input`,
      { token: started.token, type: "keypress", keys: "Enter" },
    );
    expect(accepted.status).toBe(200);
    expect(desktop.performDesktopKeypress).toHaveBeenCalledWith("Enter");
    expect(asSessionResponse(accepted).session.inputCount).toBe(1);
  });

  it("stops sessions and leaves stopped streams inaccessible", async () => {
    const started = asStartResponse(
      await callRoute("POST", "/api/apps/screenshare/session"),
    );

    const stopped = await callRoute(
      "POST",
      `/api/apps/screenshare/session/${started.session.id}/stop`,
      { token: started.token },
    );
    expect(asSessionResponse(stopped).session.status).toBe("stopped");

    const stoppedFrame = await callRoute(
      "GET",
      `/api/apps/screenshare/session/${started.session.id}/frame?token=${encodeURIComponent(
        started.token,
      )}`,
    );
    expect(stoppedFrame.status).toBe(409);
  });

  it("serves a usable viewer shell with connection and control affordances", async () => {
    const viewer = await callRoute("GET", "/api/apps/screenshare/viewer");
    const html = htmlBody(viewer);

    expect(viewer.status).toBe(200);
    expect(viewer.headers["Content-Type"]).toContain("text/html");
    expect(html).toContain("Remote desktop stream");
    expect(html).toContain('id="connect"');
    expect(html).toContain('data-key="Enter"');
    expect(html).toContain('disconnect("Stopped")');
  });

  it("prepares app launch with an embedded authenticated viewer", async () => {
    const launch = await prepareLaunch(
      {} as Parameters<typeof prepareLaunch>[0],
    );

    expect(launch.launchUrl).toContain("/api/apps/screenshare/viewer?");
    expect(launch.viewer?.url).toBe(launch.launchUrl);
    expect(launch.viewer?.sandbox).toContain("allow-pointer-lock");
    expect(launch.skipRuntimePluginRegistration).toBe(true);
    expect(launch.diagnostics).toEqual([]);
  });
});
