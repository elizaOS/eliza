// Exhaustive coverage for the TUI `interact` capability handler: every input
// dispatch type (click/double-click/move/type/keypress/scroll) and every
// missing-arg guard + unknown-capability error branch. The existing
// ScreenshareTuiView.test.tsx covers the happy path for state/start/session/
// stop/viewer-url plus keypress; this file fills the input-type and error gaps.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: vi.fn(() => ""),
    getRestAuthToken: vi.fn(() => "rest-token"),
  },
}));

import { interact } from "./ScreenshareOperatorSurface.interact";

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
