// @vitest-environment jsdom

/**
 * Covers composer activity reporting (#14679): draft lifecycle metadata POSTs
 * to `/api/interactions/composer` without sending unsent draft text.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/eliza-globals", () => ({
  getElizaApiBase: () => "http://localhost:31337",
  getElizaApiToken: () => "test-token",
}));

import { reportComposerActivity } from "./report-composer-activity";

const fetchMock = vi.fn(() => Promise.resolve(new Response("{}")));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("reportComposerActivity (#14679)", () => {
  it("POSTs composer metadata with auth and no draft text", () => {
    reportComposerActivity({
      activity: "typing_paused",
      surface: "continuous_chat_overlay",
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
      surface: "continuous_chat_overlay",
      conversationId: "conversation-1",
      draftLength: 17,
      idleForMs: 2000,
      occurredAt: "2026-06-01T12:00:02.000Z",
    });
    expect(body).not.toHaveProperty("text");
    expect(body).not.toHaveProperty("draft");
  });

  it("reports a cleared draft reason", () => {
    reportComposerActivity({
      activity: "draft_abandoned",
      surface: "continuous_chat_overlay",
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
        surface: "continuous_chat_overlay",
        draftLength: 3,
      }),
    ).not.toThrow();
  });
});
