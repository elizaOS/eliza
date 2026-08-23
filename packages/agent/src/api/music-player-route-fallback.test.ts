/**
 * Tests for the `/music-player/status` compatibility fallback used when
 * plugin-music-player is not loaded.
 */

import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { tryHandleMusicPlayerStatusFallback } from "./music-player-route-fallback.ts";

function makeRes(): ServerResponse {
  return {
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
}

function bodyOf(res: ServerResponse): unknown {
  const endMock = res.end as ReturnType<typeof vi.fn>;
  const [payload] = endMock.mock.calls[0] as [string];
  return JSON.parse(payload);
}

const emptyRuntime = (music?: unknown): unknown => ({
  getService: vi.fn((name: string) => (name === "music" ? music : undefined)),
});

describe("tryHandleMusicPlayerStatusFallback", () => {
  it("ignores non-matching paths and methods", () => {
    const res = makeRes();
    const runtime = emptyRuntime();
    expect(
      tryHandleMusicPlayerStatusFallback({
        pathname: "/other",
        method: "GET",
        runtime: runtime as never,
        res,
      }),
    ).toBe(false);
    expect(
      tryHandleMusicPlayerStatusFallback({
        pathname: "/music-player/status",
        method: "POST",
        runtime: runtime as never,
        res,
      }),
    ).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("reports unavailable when no music service is registered", () => {
    const res = makeRes();
    const handled = tryHandleMusicPlayerStatusFallback({
      pathname: "/music-player/status",
      method: "GET",
      runtime: emptyRuntime() as never,
      res,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/json; charset=utf-8",
    );
    expect(bodyOf(res)).toEqual({
      available: false,
      error: "Music player plugin is not enabled",
    });
  });

  it("reports available with no track when the service has no queues", () => {
    const res = makeRes();
    const music = { getQueues: vi.fn(() => undefined) };
    const handled = tryHandleMusicPlayerStatusFallback({
      pathname: "/music-player/status",
      method: "GET",
      runtime: emptyRuntime(music) as never,
      res,
    });
    expect(handled).toBe(true);
    expect(bodyOf(res)).toEqual({
      available: true,
      error: "No track is currently playing",
    });
  });

  it("reports available with no track when queues are empty", () => {
    const res = makeRes();
    const music = { getQueues: vi.fn(() => new Map()) };
    tryHandleMusicPlayerStatusFallback({
      pathname: "/music-player/status",
      method: "GET",
      runtime: emptyRuntime(music) as never,
      res,
    });
    expect(bodyOf(res)).toEqual({
      available: true,
      error: "No track is currently playing",
    });
  });

  it("returns the active guild track with a stream url", () => {
    const res = makeRes();
    const track = {
      id: "t1",
      title: "Song",
      url: "https://cdn/1.mp3",
      duration: 120,
      requestedBy: "user-1",
      addedAt: 1234,
    };
    const music = {
      getQueues: vi.fn(() => new Map([["guild-1", {}]])),
      getCurrentTrack: vi.fn(() => track),
      getIsPaused: vi.fn(() => true),
    };
    tryHandleMusicPlayerStatusFallback({
      pathname: "/music-player/status",
      method: "GET",
      runtime: emptyRuntime(music) as never,
      res,
    });
    expect(bodyOf(res)).toEqual({
      available: true,
      guildId: "guild-1",
      track,
      isPaused: true,
      streamUrl: "/music-player/stream?guildId=guild-1",
    });
  });

  it("defaults isPaused to false when the service omits it", () => {
    const res = makeRes();
    const music = {
      getQueues: vi.fn(() => new Map([["guild-1", {}]])),
      getCurrentTrack: vi.fn(() => ({ title: "Song" })),
    };
    tryHandleMusicPlayerStatusFallback({
      pathname: "/music-player/status",
      method: "GET",
      runtime: emptyRuntime(music) as never,
      res,
    });
    const body = bodyOf(res) as { isPaused: boolean };
    expect(body.isPaused).toBe(false);
  });

  it("skips entries whose guild id is missing or empty", () => {
    const res = makeRes();
    const music = {
      getQueues: vi.fn(
        () =>
          new Map([
            ["", {}],
            ["guild-2", {}],
          ]),
      ),
      getCurrentTrack: vi.fn(() => ({ title: "Song" })),
    };
    tryHandleMusicPlayerStatusFallback({
      pathname: "/music-player/status",
      method: "GET",
      runtime: emptyRuntime(music) as never,
      res,
    });
    expect(music.getCurrentTrack).toHaveBeenCalledWith("guild-2");
    const body = bodyOf(res) as { guildId: string };
    expect(body.guildId).toBe("guild-2");
  });

  it("handles iterable queue entries instead of maps", () => {
    const res = makeRes();
    const music = {
      getQueues: vi.fn(() => [["guild-3", {}]]),
      getCurrentTrack: vi.fn(() => ({ title: "Song" })),
    };
    tryHandleMusicPlayerStatusFallback({
      pathname: "/music-player/status",
      method: "GET",
      runtime: emptyRuntime(music) as never,
      res,
    });
    const body = bodyOf(res) as { guildId: string };
    expect(body.guildId).toBe("guild-3");
  });

  it("encodes the guild id into the stream url", () => {
    const res = makeRes();
    const music = {
      getQueues: vi.fn(() => new Map([["a b&c", {}]])),
      getCurrentTrack: vi.fn(() => ({ title: "Song" })),
    };
    tryHandleMusicPlayerStatusFallback({
      pathname: "/music-player/status",
      method: "GET",
      runtime: emptyRuntime(music) as never,
      res,
    });
    const body = bodyOf(res) as { streamUrl: string };
    expect(body.streamUrl).toBe("/music-player/stream?guildId=a%20b%26c");
  });
});
