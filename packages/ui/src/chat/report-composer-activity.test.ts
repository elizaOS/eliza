/** Verifies reportComposerActivity (#14679) through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Covers composer activity reporting (#14679): draft lifecycle metadata POSTs
 * to `/api/interactions/composer` without sending unsent draft text.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { elizaGlobalsMock } = vi.hoisted(() => ({
  elizaGlobalsMock: {
    base: "http://localhost:31337",
    token: "test-token",
  },
}));
vi.mock("../utils/eliza-globals", () => ({
  getElizaApiBase: () => elizaGlobalsMock.base,
  getElizaApiToken: () => elizaGlobalsMock.token,
}));

import {
  COMPOSER_ACTIVITY_FETCH_TIMEOUT_MS,
  postComposerActivityWithFetch,
  reportComposerActivity,
} from "./report-composer-activity";

const fetchMock = vi.fn(() => Promise.resolve(new Response("{}")));

beforeEach(() => {
  elizaGlobalsMock.base = "http://localhost:31337";
  elizaGlobalsMock.token = "test-token";
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("reportComposerActivity (#14679)", () => {
  it("POSTs composer metadata with auth and no draft text", () => {
    reportComposerActivity({
      activity: "typing_paused",
      surface: "chat_overlay",
      conversationId: "conversation-1",
      draftLength: 17,
      idleForMs: 2000,
      occurredAt: "2026-06-01T12:00:02.000Z",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://localhost:31337/api/interactions/composer");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      activity: "typing_paused",
      surface: "chat_overlay",
      conversationId: "conversation-1",
      draftLength: 17,
      idleForMs: 2000,
      occurredAt: "2026-06-01T12:00:02.000Z",
    });
    expect(body).not.toHaveProperty("text");
    expect(body).not.toHaveProperty("draft");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a cleared draft reason", () => {
    reportComposerActivity({
      activity: "draft_abandoned",
      surface: "chat_overlay",
      draftLength: 0,
      reason: "cleared",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual(
      expect.objectContaining({
        activity: "draft_abandoned",
        reason: "cleared",
        draftLength: 0,
      }),
    );
  });

  it("is fire-and-forget when fetch rejects", () => {
    fetchMock.mockReturnValueOnce(Promise.reject(new Error("offline")));
    expect(() =>
      reportComposerActivity({
        activity: "typing_started",
        surface: "chat_overlay",
        draftLength: 3,
      }),
    ).not.toThrow();
  });

  it("skips direct cloud-agent bases that do not expose composer telemetry", () => {
    elizaGlobalsMock.base =
      "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai";

    reportComposerActivity({
      activity: "typing_started",
      surface: "chat_overlay",
      draftLength: 3,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected composer abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

const composerArgs = {
  base: "http://localhost:31337",
  token: "test-token",
  report: {
    activity: "typing_paused" as const,
    surface: "chat_overlay",
    conversationId: "conversation-1",
    draftLength: 17,
    idleForMs: 2000,
    occurredAt: "2026-06-01T12:00:02.000Z",
  },
};

describe("composer-activity request deadline", () => {
  it("keeps a documented composer-report budget", () => {
    expect(COMPOSER_ACTIVITY_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled composer POST at the injected deadline", async () => {
    await expect(
      postComposerActivityWithFetch(composerArgs, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed composer POST", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });
    await expect(
      postComposerActivityWithFetch(composerArgs, fetchImpl, 1_000),
    ).rejects.toThrow("POST /api/interactions/composer returned HTTP 503");
  });

  it("uses the injected fetch for a successful composer POST", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Response("{}", { status: 200 });
    };
    const res = await postComposerActivityWithFetch(
      composerArgs,
      fetchImpl,
      1_000,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(res.ok).toBe(true);
  });
});
