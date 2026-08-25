/**
 * SpotifyApiClient contract tests against protocol-faithful mock responses:
 * success and designed-empty paths, offset pagination, the single-retry 401
 * refresh loop, revoked auth, 403 premium/scope mapping, 404 device mapping,
 * 429 Retry-After, malformed upstream payloads, and upstream failure. The
 * harness is a fetch double; the client under test is the real implementation.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { SpotifyApiClient } from "../client";
import {
  jsonResponse,
  MockSpotify,
  pagedEnvelope,
  rawDevice,
  rawPlaylist,
  rawTrack,
  spotifyError,
} from "./mock-spotify";

const API = "https://api.spotify.test";

function makeClient(mock: MockSpotify, tokens: string[] = ["token-1"]) {
  let calls = 0;
  const issued: boolean[] = [];
  const client = new SpotifyApiClient({
    getAccessToken: async ({ forceRefresh }) => {
      issued.push(forceRefresh);
      const token = tokens[Math.min(calls, tokens.length - 1)] ?? "token-1";
      calls += 1;
      return token;
    },
    fetchImpl: mock.fetch,
    apiBase: API,
  });
  return { client, issued };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<ElizaError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ElizaError);
  const error = caught as ElizaError;
  expect(error.code).toBe(code);
  return error;
}

describe("SpotifyApiClient", () => {
  it("searches tracks and sends bearer auth", async () => {
    const mock = new MockSpotify().on("GET", `${API}/v1/search`, () =>
      jsonResponse(200, {
        tracks: pagedEnvelope({
          items: [rawTrack("t1", "Song One", "Band")],
          total: 1,
          offset: 0,
          limit: 10,
          base: `${API}/v1/search`,
        }),
      })
    );
    const { client } = makeClient(mock);
    const result = await client.search("song", ["track"]);
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({
      id: "t1",
      uri: "spotify:track:t1",
      name: "Song One",
      album: "Song One Album",
    });
    const request = mock.requests[0];
    expect(request?.headers.authorization).toBe("Bearer token-1");
    expect(request?.url).toContain("q=song");
    expect(request?.url).toContain("type=track");
  });

  it("returns designed-empty search results without inventing items", async () => {
    const mock = new MockSpotify().on("GET", `${API}/v1/search`, () =>
      jsonResponse(200, {
        tracks: pagedEnvelope({
          items: [],
          total: 0,
          offset: 0,
          limit: 10,
          base: `${API}/v1/search`,
        }),
      })
    );
    const { client } = makeClient(mock);
    const result = await client.search("nothing", ["track"]);
    expect(result.tracks).toEqual([]);
    expect(result.playlists).toEqual([]);
  });

  it("rejects an empty search query as invalid input before any request", async () => {
    const mock = new MockSpotify();
    const { client } = makeClient(mock);
    await expectCode(client.search("   ", ["track"]), "SPOTIFY_INVALID_INPUT");
    expect(mock.requests).toHaveLength(0);
  });

  it("pages saved tracks and reports nextOffset until the last page", async () => {
    const mock = new MockSpotify().on("GET", `${API}/v1/me/tracks`, (request) => {
      const offset = Number(new URL(request.url).searchParams.get("offset") ?? "0");
      const items =
        offset === 0
          ? [{ track: rawTrack("a", "A") }, { track: rawTrack("b", "B") }]
          : [{ track: rawTrack("c", "C") }];
      return jsonResponse(
        200,
        pagedEnvelope({ items, total: 3, offset, limit: 2, base: `${API}/v1/me/tracks` })
      );
    });
    const { client } = makeClient(mock);
    const first = await client.listSavedTracks({ limit: 2, offset: 0 });
    expect(first.items.map((t) => t.id)).toEqual(["a", "b"]);
    expect(first.nextOffset).toBe(2);
    const second = await client.listSavedTracks({ limit: 2, offset: first.nextOffset ?? 0 });
    expect(second.items.map((t) => t.id)).toEqual(["c"]);
    expect(second.nextOffset).toBeNull();
  });

  it("retries exactly once with a refreshed token on 401 then succeeds", async () => {
    const mock = new MockSpotify()
      .on(
        "GET",
        `${API}/v1/me/player/devices`,
        () => spotifyError(401, "The access token expired"),
        1
      )
      .on("GET", `${API}/v1/me/player/devices`, () =>
        jsonResponse(200, { devices: [rawDevice("d1", "Desk", true)] })
      );
    const { client, issued } = makeClient(mock, ["stale", "fresh"]);
    const devices = await client.listDevices();
    expect(devices).toHaveLength(1);
    expect(issued).toEqual([false, true]);
    expect(mock.requests[1]?.headers.authorization).toBe("Bearer fresh");
  });

  it("maps a second consecutive 401 to SPOTIFY_AUTH_REVOKED", async () => {
    const mock = new MockSpotify().on("GET", `${API}/v1/me/player/devices`, () =>
      spotifyError(401, "The access token expired")
    );
    const { client } = makeClient(mock, ["stale", "still-stale"]);
    await expectCode(client.listDevices(), "SPOTIFY_AUTH_REVOKED");
    expect(mock.requests).toHaveLength(2);
  });

  it("maps 403 PREMIUM_REQUIRED to SPOTIFY_PREMIUM_REQUIRED", async () => {
    const mock = new MockSpotify().on("PUT", `${API}/v1/me/player/play`, () =>
      spotifyError(403, "Player command failed: Premium required", "PREMIUM_REQUIRED")
    );
    const { client } = makeClient(mock);
    await expectCode(client.play(), "SPOTIFY_PREMIUM_REQUIRED");
  });

  it("maps other 403s to SPOTIFY_SCOPE_INSUFFICIENT (scope escalation)", async () => {
    const mock = new MockSpotify().on("PUT", `${API}/v1/me/tracks`, () =>
      spotifyError(403, "Insufficient client scope")
    );
    const { client } = makeClient(mock);
    await expectCode(client.saveTracks(["t1"]), "SPOTIFY_SCOPE_INSUFFICIENT");
  });

  it("maps 404 NO_ACTIVE_DEVICE to SPOTIFY_NO_ACTIVE_DEVICE", async () => {
    const mock = new MockSpotify().on("PUT", `${API}/v1/me/player/pause`, () =>
      spotifyError(404, "Player command failed: No active device found", "NO_ACTIVE_DEVICE")
    );
    const { client } = makeClient(mock);
    await expectCode(client.pause(), "SPOTIFY_NO_ACTIVE_DEVICE");
  });

  it("maps 429 to SPOTIFY_RATE_LIMITED and surfaces Retry-After seconds", async () => {
    const mock = new MockSpotify().on(
      "GET",
      `${API}/v1/search`,
      () =>
        new Response(JSON.stringify({ error: { status: 429, message: "rate limited" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "7" },
        })
    );
    const { client } = makeClient(mock);
    const error = await expectCode(client.search("x", ["track"]), "SPOTIFY_RATE_LIMITED");
    expect(error.context?.retryAfterSeconds).toBe(7);
  });

  it("rejects malformed upstream payloads instead of returning defaults", async () => {
    const mock = new MockSpotify().on("GET", `${API}/v1/me/tracks`, () =>
      jsonResponse(200, { unexpected: true })
    );
    const { client } = makeClient(mock);
    await expectCode(client.listSavedTracks(), "SPOTIFY_UPSTREAM_INVALID");
  });

  it("rejects unparseable 2xx JSON as a protocol violation", async () => {
    const mock = new MockSpotify().on(
      "GET",
      `${API}/v1/me`,
      () => new Response("<html>not json</html>", { status: 200 })
    );
    const { client } = makeClient(mock);
    await expectCode(client.getProfile(), "SPOTIFY_UPSTREAM_INVALID");
  });

  it("maps 5xx to SPOTIFY_UPSTREAM_FAILED", async () => {
    const mock = new MockSpotify().on("GET", `${API}/v1/me`, () =>
      spotifyError(502, "Bad gateway")
    );
    const { client } = makeClient(mock);
    await expectCode(client.getProfile(), "SPOTIFY_UPSTREAM_FAILED");
  });

  it("treats a 204 playback state as designed-empty (null), not an error", async () => {
    const mock = new MockSpotify().on(
      "GET",
      `${API}/v1/me/player`,
      () => new Response(null, { status: 204 })
    );
    const { client } = makeClient(mock);
    expect(await client.getPlaybackState()).toBeNull();
  });

  it("parses a full playback state including device and track", async () => {
    const mock = new MockSpotify().on("GET", `${API}/v1/me/player`, () =>
      jsonResponse(200, {
        is_playing: true,
        progress_ms: 12345,
        shuffle_state: false,
        repeat_state: "context",
        device: rawDevice("d1", "Kitchen", true),
        item: rawTrack("t9", "Now Playing"),
      })
    );
    const { client } = makeClient(mock);
    const state = await client.getPlaybackState();
    expect(state).toMatchObject({
      isPlaying: true,
      progressMs: 12345,
      repeat: "context",
      device: { id: "d1", name: "Kitchen", isActive: true },
      track: { id: "t9", name: "Now Playing" },
    });
  });

  it("creates a playlist and adds tracks with exact request bodies", async () => {
    const mock = new MockSpotify()
      .on("POST", `${API}/v1/users/user-1/playlists`, () =>
        jsonResponse(201, rawPlaylist("p1", "Focus", 0))
      )
      .on("POST", `${API}/v1/playlists/p1/tracks`, () =>
        jsonResponse(201, { snapshot_id: "snap" })
      );
    const { client } = makeClient(mock);
    const playlist = await client.createPlaylist("user-1", { name: "Focus" });
    expect(playlist.id).toBe("p1");
    await client.addTracksToPlaylist("p1", ["spotify:track:a", "spotify:track:b"]);
    expect(JSON.parse(mock.requests[0]?.body ?? "{}")).toMatchObject({
      name: "Focus",
      public: false,
    });
    expect(JSON.parse(mock.requests[1]?.body ?? "{}")).toEqual({
      uris: ["spotify:track:a", "spotify:track:b"],
    });
  });

  it("rejects empty id lists for library writes before any request", async () => {
    const mock = new MockSpotify();
    const { client } = makeClient(mock);
    await expectCode(client.saveTracks([]), "SPOTIFY_INVALID_INPUT");
    await expectCode(client.removeSavedTracks([" "]), "SPOTIFY_INVALID_INPUT");
    await expectCode(client.addTracksToPlaylist("p1", []), "SPOTIFY_INVALID_INPUT");
    await expectCode(client.transferPlayback("  "), "SPOTIFY_INVALID_INPUT");
    expect(mock.requests).toHaveLength(0);
  });

  it("transfers playback (device handoff) with the documented body", async () => {
    const mock = new MockSpotify().on(
      "PUT",
      `${API}/v1/me/player`,
      () => new Response(null, { status: 204 })
    );
    const { client } = makeClient(mock);
    await client.transferPlayback("device-9", { play: true });
    expect(JSON.parse(mock.requests[0]?.body ?? "{}")).toEqual({
      device_ids: ["device-9"],
      play: true,
    });
  });

  it("wraps transport failures as SPOTIFY_UPSTREAM_FAILED", async () => {
    const failingFetch = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    const client = new SpotifyApiClient({
      getAccessToken: async () => "t",
      fetchImpl: failingFetch,
      apiBase: API,
    });
    await expectCode(client.getProfile(), "SPOTIFY_UPSTREAM_FAILED");
  });
});
