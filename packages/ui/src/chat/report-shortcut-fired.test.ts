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
  postShortcutReportWithFetch,
  postViewSwitchReportWithFetch,
  reportShortcutFired,
  reportUserViewSwitch,
  SLASH_SHORTCUT_FETCH_TIMEOUT_MS,
  SLASH_VIEW_SWITCH_FETCH_TIMEOUT_MS,
} from "./useSlashCommandController";

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

function stallUntilAborted(label: string): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error(`expected ${label} abort signal`);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

const viewArgs = {
  base: "http://localhost:31337",
  token: "test-token",
  viewId: "wallet",
};

const shortcutArgs = {
  base: "http://localhost:31337",
  token: "test-token",
  shortcutId: "open-command-palette",
  context: "command-palette",
};

describe("slash-command report request deadlines", () => {
  it("keeps a documented view-switch budget", () => {
    expect(SLASH_VIEW_SWITCH_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it("keeps a documented shortcut budget", () => {
    expect(SLASH_SHORTCUT_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled view-switch POST at the injected deadline", async () => {
    await expect(
      postViewSwitchReportWithFetch(
        viewArgs,
        stallUntilAborted("view-switch"),
        10,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("aborts a stalled shortcut POST at the injected deadline", async () => {
    await expect(
      postShortcutReportWithFetch(
        shortcutArgs,
        stallUntilAborted("shortcut"),
        10,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed view-switch POST", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });
    await expect(
      postViewSwitchReportWithFetch(viewArgs, fetchImpl, 1_000),
    ).rejects.toThrow("POST /api/views/wallet/navigate returned HTTP 503");
  });

  it("surfaces a provider error from a completed shortcut POST", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 401, statusText: "Unauthorized" });
    await expect(
      postShortcutReportWithFetch(shortcutArgs, fetchImpl, 1_000),
    ).rejects.toThrow("POST /api/interactions/shortcut returned HTTP 401");
  });

  it("uses the injected fetch for a successful view-switch POST", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Response("{}", { status: 200 });
    };
    const res = await postViewSwitchReportWithFetch(viewArgs, fetchImpl, 1_000);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(res.ok).toBe(true);
  });

  it("uses the injected fetch for a successful shortcut POST", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Response("{}", { status: 200 });
    };
    const res = await postShortcutReportWithFetch(
      shortcutArgs,
      fetchImpl,
      1_000,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(res.ok).toBe(true);
  });
});
