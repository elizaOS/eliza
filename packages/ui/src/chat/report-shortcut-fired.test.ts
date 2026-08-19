/** Verifies reportShortcutFired (#8792) through the package's configured test harness. */
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

import {
  reportShortcutFired,
  reportUserViewSwitch,
} from "./useSlashCommandController";

const fetchMock = vi.fn(() => Promise.resolve(new Response("{}")));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("POSTs a view switch to /api/views/:id/navigate with a deadline", () => {
    reportUserViewSwitch("wallet", "/wallet");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://localhost:31337/api/views/wallet/navigate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      source: "user",
      path: "/wallet",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
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

describe("slash-command report request deadlines", () => {
  it.each([
    ["view switch", () => reportUserViewSwitch("wallet", "/wallet")],
    ["shortcut", () => reportShortcutFired("open-command-palette")],
  ])("bounds and consumes the %s response", async (_label, report) => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const budgets: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      budgets.push(milliseconds);
      return nativeTimeout(10);
    });
    let resolveAborted: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    const arrayBuffer = vi.fn(async () => {
      const [, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      const signal = init.signal;
      if (!signal) throw new Error("expected report abort signal");
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            resolveAborted?.();
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer,
    } as unknown as Response);

    report();

    await vi.waitFor(() => expect(arrayBuffer).toHaveBeenCalledTimes(1));
    await aborted;
    expect(budgets).toEqual([15_000]);
  });
});
