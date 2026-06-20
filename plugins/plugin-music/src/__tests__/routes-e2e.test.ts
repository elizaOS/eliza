/**
 * Route-level e2e for plugin-music (issue #8802).
 *
 * Boots the plugin's declared `musicPlayerRoutes` through the real production
 * dispatcher (`tryHandleRuntimePluginRoute`) over a loopback `http.createServer`
 * — exercising the real auth gate, JSON body parsing, query/param parsing, and
 * handler dispatch — with a faked `MusicService` standing in for the only
 * external dependency. No mocked `json`/`error` functions: every assertion is on
 * a real HTTP response (status + body) from the real dispatcher.
 *
 * Streaming routes are exercised only on their non-streaming early-return
 * branches (400 guildId-required / 503 service-unavailable / 404 no-track) so no
 * test hangs on an open audio stream.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { musicPlayerRoutes } from "../routes.ts";

// The package-wide setup file (`core-test-mock.ts`) replaces `@elizaos/core`
// with a minimal stub that omits the HTTP helpers the real route dispatcher
// imports (`writeJsonError`, `readRequestBodyBuffer`, `isJsonObjectBody`,
// `setRuntimeRouteHostContext`). Restore the real module for this file so the
// dispatcher exercises its genuine body-parsing + error paths.
vi.mock("@elizaos/core", async () => {
  return await vi.importActual<typeof import("@elizaos/core")>("@elizaos/core");
});

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
});

interface FakeTrack {
  id: string;
  title: string;
  url: string;
  duration: number;
  requestedBy: string;
  addedAt: number;
}

function fakeTrack(overrides: Partial<FakeTrack> = {}): FakeTrack {
  return {
    id: "track-1",
    title: "Test Song",
    url: "https://example.com/test",
    duration: 180_000,
    requestedBy: "entity-1",
    addedAt: 1,
    ...overrides,
  };
}

interface FakeState {
  /** guildId → current track (null means no track playing for that guild) */
  current: Map<string, FakeTrack | null>;
  /** guildId → queue list */
  queues: Map<string, FakeTrack[]>;
  paused: Map<string, boolean>;
  /** ordered control calls for assertion */
  calls: string[];
  /** when set, skip() resolves to this value (default: true if a track exists) */
  skipResult?: boolean;
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    current: new Map(),
    queues: new Map(),
    paused: new Map(),
    calls: [],
    ...overrides,
  };
}

function makeMusicService(state: FakeState) {
  return {
    getCurrentTrack: (guildId: string) => state.current.get(guildId) ?? null,
    getQueueList: (guildId: string) => state.queues.get(guildId) ?? [],
    // statusHandler iterates over getQueues() keys, then calls getCurrentTrack.
    getQueues: () => {
      const m = new Map<string, unknown>();
      for (const guildId of state.current.keys()) m.set(guildId, {});
      for (const guildId of state.queues.keys()) m.set(guildId, {});
      return m;
    },
    getIsPaused: (guildId: string) => state.paused.get(guildId) ?? false,
    pause: async (guildId: string) => {
      state.calls.push(`pause:${guildId}`);
      state.paused.set(guildId, true);
    },
    resume: async (guildId: string) => {
      state.calls.push(`resume:${guildId}`);
      state.paused.set(guildId, false);
    },
    stopPlayback: async (guildId: string) => {
      state.calls.push(`stop:${guildId}`);
    },
    clear: (guildId: string) => {
      state.calls.push(`clear:${guildId}`);
      state.current.set(guildId, null);
    },
    skip: async (guildId: string) => {
      state.calls.push(`skip:${guildId}`);
      if (state.skipResult !== undefined) return state.skipResult;
      return state.current.get(guildId) != null;
    },
    // getBroadcast is only reached after the no-track early return; never called
    // in these tests because we always drive the early-return branches.
    getBroadcast: () => {
      throw new Error("getBroadcast should not be reached in route-e2e tests");
    },
  };
}

function makeRuntime(
  state: FakeState,
  options: { withService?: boolean } = {},
): AgentRuntime {
  const { withService = true } = options;
  const service = makeMusicService(state);
  return {
    routes: musicPlayerRoutes,
    character: { name: "Test Agent" },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    getService: (key: string) =>
      withService && key === "music" ? service : null,
  } as unknown as AgentRuntime;
}

async function startServer(
  runtime: AgentRuntime,
  isAuthorized: () => boolean = () => true,
): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      runtime,
      isAuthorized,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postJson(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    // The legacy music control handlers read the request stream themselves.
    // Sending application/json would make the runtime dispatcher pre-read the
    // body first, leaving the handler waiting on an already-consumed stream.
    headers: { "content-type": "text/plain" },
    body: JSON.stringify(body),
  });
}

describe("plugin-music routes (real dispatch)", () => {
  // ── Public radio GETs ───────────────────────────────────────────────────

  it("now-playing returns 200 with the current track (query guildId)", async () => {
    const state = makeState();
    state.current.set("g1", fakeTrack({ title: "Now Playing Song" }));
    const base = await startServer(makeRuntime(state));

    const res = await fetch(`${base}/now-playing?guildId=g1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      track: { id: string; title: string };
      streamUrl: string;
    };
    expect(body.track.id).toBe("track-1");
    expect(body.track.title).toBe("Now Playing Song");
    expect(body.streamUrl).toBe("/music-player/stream?guildId=g1");
  });

  it("now-playing/:guildId returns 200 via the path param", async () => {
    const state = makeState();
    state.current.set("guild-path", fakeTrack());
    const base = await startServer(makeRuntime(state));

    const res = await fetch(`${base}/now-playing/guild-path`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { track: { id: string } };
    expect(body.track.id).toBe("track-1");
  });

  it("now-playing returns 400 when guildId is missing", async () => {
    const base = await startServer(makeRuntime(makeState()));
    const res = await fetch(`${base}/now-playing`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "guildId is required",
    );
  });

  it("now-playing returns 404 when no track is playing", async () => {
    const base = await startServer(makeRuntime(makeState()));
    const res = await fetch(`${base}/now-playing?guildId=g1`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain(
      "No track is currently playing",
    );
  });

  it("now-playing returns 503 when the music service is unavailable", async () => {
    const base = await startServer(
      makeRuntime(makeState(), { withService: false }),
    );
    const res = await fetch(`${base}/now-playing?guildId=g1`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain(
      "Music service is not available",
    );
  });

  it("queue returns 200 with current track and queue list", async () => {
    const state = makeState();
    state.current.set("g1", fakeTrack({ id: "cur", title: "Current" }));
    state.queues.set("g1", [
      fakeTrack({ id: "q1", title: "Queued One" }),
      fakeTrack({ id: "q2", title: "Queued Two" }),
    ]);
    const base = await startServer(makeRuntime(state));

    const res = await fetch(`${base}/queue?guildId=g1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      currentTrack: { id: string } | null;
      queue: { id: string }[];
      queueLength: number;
    };
    expect(body.currentTrack?.id).toBe("cur");
    expect(body.queueLength).toBe(2);
    expect(body.queue.map((t) => t.id)).toEqual(["q1", "q2"]);
  });

  it("queue/:guildId returns 200 via the path param", async () => {
    const state = makeState();
    state.queues.set("gp", [fakeTrack({ id: "only" })]);
    const base = await startServer(makeRuntime(state));

    const res = await fetch(`${base}/queue/gp`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      currentTrack: unknown;
      queueLength: number;
    };
    expect(body.currentTrack).toBeNull();
    expect(body.queueLength).toBe(1);
  });

  it("queue returns 400 when guildId is missing and 503 without service", async () => {
    const base = await startServer(makeRuntime(makeState()));
    expect((await fetch(`${base}/queue`)).status).toBe(400);

    const noSvc = await startServer(
      makeRuntime(makeState(), { withService: false }),
    );
    expect((await fetch(`${noSvc}/queue?guildId=g1`)).status).toBe(503);
  });

  it("status (no guildId) returns the first active guild + track", async () => {
    const state = makeState();
    state.current.set("active-guild", fakeTrack({ id: "active" }));
    state.paused.set("active-guild", true);
    const base = await startServer(makeRuntime(state));

    const res = await fetch(`${base}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      guildId: string;
      track: { id: string };
      isPaused: boolean;
      streamUrl: string;
    };
    expect(body.guildId).toBe("active-guild");
    expect(body.track.id).toBe("active");
    expect(body.isPaused).toBe(true);
    expect(body.streamUrl).toContain("guildId=active-guild");
  });

  it("status returns 200 with no-track message when nothing is playing", async () => {
    const base = await startServer(makeRuntime(makeState()));
    const res = await fetch(`${base}/status`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { error: string }).error).toContain(
      "No track is currently playing",
    );
  });

  it("status returns 503 when the music service is unavailable", async () => {
    const base = await startServer(
      makeRuntime(makeState(), { withService: false }),
    );
    const res = await fetch(`${base}/status`);
    expect(res.status).toBe(503);
  });

  it("public GET routes still serve when auth is denied", async () => {
    const state = makeState();
    state.current.set("g1", fakeTrack());
    const base = await startServer(makeRuntime(state), () => false);
    expect((await fetch(`${base}/now-playing?guildId=g1`)).status).toBe(200);
    expect((await fetch(`${base}/queue?guildId=g1`)).status).toBe(200);
    expect((await fetch(`${base}/status`)).status).toBe(200);
  });

  // ── Streaming route early-return branches (no open stream) ───────────────

  it("stream returns 400 (no guildId), 404 (no track), 503 (no service)", async () => {
    const state = makeState();
    const base = await startServer(makeRuntime(state));

    // No guildId → 400 before any service lookup.
    const missing = await fetch(`${base}/stream`);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain(
      "guildId is required",
    );

    // Service present, no current track → 404 before broadcast subscription.
    const noTrack = await fetch(`${base}/stream?guildId=g1`);
    expect(noTrack.status).toBe(404);
    expect(((await noTrack.json()) as { error: string }).error).toContain(
      "No track is currently playing",
    );

    // No service → 503.
    const noSvc = await startServer(
      makeRuntime(makeState(), { withService: false }),
    );
    const svcRes = await fetch(`${noSvc}/stream?guildId=g1`);
    expect(svcRes.status).toBe(503);
    expect(((await svcRes.json()) as { error: string }).error).toContain(
      "Music service is not available",
    );
  });

  it("stream/:guildId returns 404 via path param when no track is playing", async () => {
    const base = await startServer(makeRuntime(makeState()));
    const res = await fetch(`${base}/stream/guild-x`);
    expect(res.status).toBe(404);
  });

  // ── Authenticated DJ-booth control POSTs ─────────────────────────────────

  it("control/pause pauses the active guild and returns 200", async () => {
    const state = makeState();
    state.current.set("g1", fakeTrack());
    const base = await startServer(makeRuntime(state));

    const res = await postJson(base, "/control/pause", { guildId: "g1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      guildId: string;
      state: string;
    };
    expect(body.ok).toBe(true);
    expect(body.guildId).toBe("g1");
    expect(body.state).toBe("paused");
    expect(state.calls).toContain("pause:g1");
  });

  it("control/resume resumes and returns state playing", async () => {
    const state = makeState();
    state.current.set("g1", fakeTrack());
    const base = await startServer(makeRuntime(state));

    const res = await postJson(base, "/control/resume", { guildId: "g1" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe("playing");
    expect(state.calls).toContain("resume:g1");
  });

  it("control/stop stops + clears and returns state stopped", async () => {
    const state = makeState();
    state.current.set("g1", fakeTrack());
    const base = await startServer(makeRuntime(state));

    const res = await postJson(base, "/control/stop", { guildId: "g1" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe("stopped");
    expect(state.calls).toContain("stop:g1");
    expect(state.calls).toContain("clear:g1");
  });

  it("control/skip returns 200 with the next track", async () => {
    const state = makeState();
    state.current.set("g1", fakeTrack({ id: "next-track", title: "Next" }));
    state.skipResult = true;
    const base = await startServer(makeRuntime(state));

    const res = await postJson(base, "/control/skip", { guildId: "g1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      nextTrack: { id: string; title: string } | null;
    };
    expect(body.ok).toBe(true);
    expect(body.nextTrack?.id).toBe("next-track");
    expect(state.calls).toContain("skip:g1");
  });

  it("control/skip returns 404 when there is no track to skip", async () => {
    const state = makeState();
    state.current.set("g1", fakeTrack());
    state.skipResult = false;
    const base = await startServer(makeRuntime(state));

    const res = await postJson(base, "/control/skip", { guildId: "g1" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain(
      "No track to skip",
    );
  });

  it("control routes return 404 when no guildId resolves to an active guild", async () => {
    const base = await startServer(makeRuntime(makeState()));
    const res = await postJson(base, "/control/pause", {});
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain(
      "No active playback to pause",
    );
  });

  it("control routes return 503 when the music service is unavailable", async () => {
    const base = await startServer(
      makeRuntime(makeState(), { withService: false }),
    );
    const res = await postJson(base, "/control/pause", { guildId: "g1" });
    expect(res.status).toBe(503);
  });

  it("control routes enforce the auth gate (401 when unauthorized)", async () => {
    const state = makeState();
    state.current.set("g1", fakeTrack());
    const base = await startServer(makeRuntime(state), () => false);

    for (const path of [
      "/control/pause",
      "/control/resume",
      "/control/stop",
      "/control/skip",
    ]) {
      const res = await postJson(base, path, { guildId: "g1" });
      expect(res.status).toBe(401);
    }
    // The auth gate fires before any handler runs → service untouched.
    expect(state.calls).toHaveLength(0);
  });
});
