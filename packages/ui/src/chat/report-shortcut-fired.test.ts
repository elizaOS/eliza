// @vitest-environment jsdom

/**
 * Covers `reportShortcutFired` (#8792): a fired shortcut POSTs to
 * `/api/interactions/shortcut` with the auth header and shortcut/source body.
 * `fetch` and the eliza-globals base/token are stubbed under jsdom.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/eliza-globals", () => ({
  getElizaApiBase: () => "http://localhost:31337",
  getElizaApiToken: () => "test-token",
}));

import { reportShortcutFired } from "./useSlashCommandController";

const fetchMock = vi.fn(() => Promise.resolve(new Response("{}")));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("reportShortcutFired (#8792)", () => {
  it("POSTs the shortcut to /api/interactions/shortcut with auth + body", () => {
    reportShortcutFired("open-command-palette", "command-palette");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://localhost:31337/api/interactions/shortcut");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      shortcutId: "open-command-palette",
      context: "command-palette",
    });
  });

  it("omits context when not provided", () => {
    reportShortcutFired("show-keyboard-shortcuts");
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual({
      shortcutId: "show-keyboard-shortcuts",
    });
  });

  it("is fire-and-forget — a rejected fetch never throws", () => {
    fetchMock.mockReturnValueOnce(Promise.reject(new Error("offline")));
    expect(() => reportShortcutFired("toggle-terminal")).not.toThrow();
  });
});
