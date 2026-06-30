// Exhaustive coverage for the TUI `interact` capability handler: the happy path
// for every capability (state/start/session/stop/input/viewer-url), every input
// dispatch type (click/double-click/move/type/keypress/scroll), and every
// missing-arg guard + unknown-capability error branch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: vi.fn(() => ""),
    getRestAuthToken: vi.fn(() => "rest-token"),
  },
}));

import { interact } from "./screenshare-interact";

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith("/input") && init?.method === "POST") {
        return jsonResponse({ success: true, message: "ok" });
      }
      return jsonResponse({ error: `Unexpected ${url}` }, 404);
    }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function lastInputBody(): Record<string, unknown> {
  const call = fetchCalls.find((c) => c.url.endsWith("/input"));
  expect(call).toBeTruthy();
  expect(call?.url).toBe("/api/apps/screenshare/session/s1/input");
  return JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
}

describe("interact terminal-screenshare-input — all dispatch types", () => {
  const base = { sessionId: "s1", token: "t1" } as const;

  it("click forwards x/y/button", async () => {
    await interact("terminal-screenshare-input", {
      ...base,
      type: "click",
      x: 10,
      y: 20,
      button: "left",
    });
    expect(lastInputBody()).toMatchObject({
      token: "t1",
      type: "click",
      x: 10,
      y: 20,
      button: "left",
    });
  });

  it("double-click forwards x/y/button", async () => {
    await interact("terminal-screenshare-input", {
      ...base,
      type: "double-click",
      x: 5,
      y: 6,
      button: "right",
    });
    expect(lastInputBody()).toMatchObject({
      type: "double-click",
      x: 5,
      y: 6,
      button: "right",
    });
  });

  it("move forwards x/y (no button)", async () => {
    await interact("terminal-screenshare-input", {
      ...base,
      type: "move",
      x: 100,
      y: 200,
    });
    const body = lastInputBody();
    expect(body).toMatchObject({ type: "move", x: 100, y: 200 });
    expect(body.button).toBeUndefined();
  });

  it("type forwards text", async () => {
    await interact("terminal-screenshare-input", {
      ...base,
      type: "type",
      text: "hello world",
    });
    expect(lastInputBody()).toMatchObject({
      type: "type",
      text: "hello world",
    });
  });

  it("keypress forwards keys", async () => {
    await interact("terminal-screenshare-input", {
      ...base,
      type: "keypress",
      keys: "Enter",
    });
    expect(lastInputBody()).toMatchObject({ type: "keypress", keys: "Enter" });
  });

  it("scroll forwards deltaY (deltaX is not part of the interact body)", async () => {
    await interact("terminal-screenshare-input", {
      ...base,
      type: "scroll",
      deltaY: -120,
    });
    expect(lastInputBody()).toMatchObject({ type: "scroll", deltaY: -120 });
  });

  it("defaults type to keypress when omitted", async () => {
    await interact("terminal-screenshare-input", { ...base, keys: "Tab" });
    expect(lastInputBody()).toMatchObject({ type: "keypress", keys: "Tab" });
  });

  it("sends the token in the X-Screenshare-Token header", async () => {
    await interact("terminal-screenshare-input", {
      ...base,
      type: "move",
      x: 1,
      y: 1,
    });
    const call = fetchCalls.find((c) => c.url.endsWith("/input"));
    expect(
      (call?.init?.headers as Record<string, string>)["X-Screenshare-Token"],
    ).toBe("t1");
  });
});

describe("interact — missing-arg guards", () => {
  for (const capability of [
    "terminal-screenshare-session",
    "terminal-screenshare-stop",
    "terminal-screenshare-input",
    "terminal-screenshare-viewer-url",
  ]) {
    it(`${capability} throws when sessionId is missing`, async () => {
      await expect(interact(capability, { token: "t1" })).rejects.toThrow(
        "sessionId is required",
      );
    });

    it(`${capability} throws when token is missing`, async () => {
      await expect(interact(capability, { sessionId: "s1" })).rejects.toThrow(
        "token is required",
      );
    });
  }

  it("blank/whitespace sessionId is treated as missing", async () => {
    await expect(
      interact("terminal-screenshare-session", {
        sessionId: "   ",
        token: "t1",
      }),
    ).rejects.toThrow("sessionId is required");
  });
});

describe("interact — unknown capability", () => {
  it("throws for an unsupported capability name", async () => {
    await expect(interact("terminal-screenshare-bogus")).rejects.toThrow(
      'Unsupported capability "terminal-screenshare-bogus"',
    );
  });
});

// Happy-path coverage for the remaining capabilities (state/start/session/stop/
// viewer-url) against a full route mock; the input dispatch types and missing-arg
// guards are covered above.
describe("interact — terminal capability happy paths", () => {
  const sampleCapabilities = {
    platform: "darwin",
    capabilities: {
      screenshot: { available: true, tool: "screencapture (built-in)" },
      computerUse: { available: true, tool: "cliclick" },
      windowList: { available: false, tool: "none (grant Accessibility)" },
      headfulGui: { available: true, tool: "desktop session" },
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

  function mockFullRoutes() {
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
        if (
          url === "/api/apps/screenshare/session" &&
          init?.method === "POST"
        ) {
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
        return jsonResponse({ error: `Unexpected ${url}` }, 404);
      }),
    );
  }

  it("supports state, session lifecycle, input, and viewer URLs", async () => {
    mockFullRoutes();

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
