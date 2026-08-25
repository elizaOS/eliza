/**
 * SPOTIFY umbrella-action tests: subaction routing, invalid-input rejection,
 * write receipts, and the mapping from typed service errors (premium
 * required, no active device, rate limited, revoked auth) to distinct
 * user-facing failures. The runtime is a stub carrying a SpotifyService
 * backed by the protocol-faithful fetch harness — the action, service, and
 * client under test are all real.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { spotifyAction } from "../actions";
import { SPOTIFY_TOKEN_ENDPOINT } from "../auth";
import { SpotifyService } from "../service";
import {
  jsonResponse,
  MockSpotify,
  pagedEnvelope,
  rawDevice,
  rawTrack,
  spotifyError,
  tokenGrantBody,
} from "./mock-spotify";

const API = "https://api.spotify.test";

function makeRuntime(mock: MockSpotify): IAgentRuntime {
  let service: SpotifyService | undefined;
  const runtime = {
    agentId: "agent-1",
    getSetting: (key: string) =>
      ({
        SPOTIFY_CLIENT_ID: "id",
        SPOTIFY_CLIENT_SECRET: "secret",
        SPOTIFY_REFRESH_TOKEN: "rt",
      })[key as "SPOTIFY_CLIENT_ID"],
    getService: (type: string) => (type === "spotify" ? (service ?? null) : null),
    reportError: () => {},
  } as unknown as IAgentRuntime;
  service = new SpotifyService(runtime, { fetchImpl: mock.fetch, apiBase: API });
  return runtime;
}

function tokenRoute(mock: MockSpotify): MockSpotify {
  return mock.on("POST", SPOTIFY_TOKEN_ENDPOINT, () =>
    jsonResponse(200, tokenGrantBody({ accessToken: "at" }))
  );
}

const message = { content: { text: "spotify request" } } as unknown as Memory;

async function run(runtime: IAgentRuntime, parameters: Record<string, unknown>) {
  const replies: string[] = [];
  const result = await spotifyAction.handler(
    runtime,
    message,
    undefined,
    { parameters },
    async (content) => {
      if (typeof content.text === "string") replies.push(content.text);
      return [];
    }
  );
  return { result, replies };
}

describe("SPOTIFY action", () => {
  it("declares the mixed read/write and effect-receipt contract", () => {
    expect(spotifyAction.tags).toEqual(
      expect.arrayContaining(["capability:read", "capability:write", "effect:receipt-required"])
    );
  });

  it("rejects a missing/unknown subaction with the allowed list", async () => {
    const runtime = makeRuntime(new MockSpotify());
    const { result } = await run(runtime, {});
    expect(result?.success).toBe(false);
    expect(result?.userFacingText).toContain("search");
    const { result: unknown } = await run(runtime, { action: "teleport" });
    expect(unknown?.success).toBe(false);
  });

  it("search returns a summary and structured tracks", async () => {
    const mock = tokenRoute(new MockSpotify()).on("GET", `${API}/v1/search`, () =>
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
    const runtime = makeRuntime(mock);
    const { result, replies } = await run(runtime, { action: "search", query: "song" });
    expect(result?.success).toBe(true);
    expect(result?.userFacingText).toContain("Song One — Band");
    expect(replies[0]).toContain("Song One");
    const data = (result?.data ?? {}) as { tracks: unknown[] };
    expect(data.tracks).toHaveLength(1);
  });

  it("search without a query is invalid input, not an upstream call", async () => {
    const mock = tokenRoute(new MockSpotify());
    const runtime = makeRuntime(mock);
    const { result } = await run(runtime, { action: "search" });
    expect(result?.success).toBe(false);
    expect(result?.userFacingText).toContain("needs a query");
    expect(mock.requests.filter((r) => r.url.includes("/v1/search"))).toHaveLength(0);
  });

  it("library_save returns a receipt naming the exact mutation", async () => {
    const mock = tokenRoute(new MockSpotify()).on(
      "PUT",
      `${API}/v1/me/tracks`,
      () => new Response(null, { status: 200 })
    );
    const runtime = makeRuntime(mock);
    const { result } = await run(runtime, { action: "library_save", trackIds: ["t1", "t2"] });
    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      receipt: { operation: "library_save", target: "me/tracks", detail: "t1,t2" },
    });
  });

  it("premium-gated playback reads as a premium failure, not a generic error", async () => {
    const mock = tokenRoute(new MockSpotify()).on("PUT", `${API}/v1/me/player/play`, () =>
      spotifyError(403, "Premium required", "PREMIUM_REQUIRED")
    );
    const runtime = makeRuntime(mock);
    const { result } = await run(runtime, { action: "play" });
    expect(result?.success).toBe(false);
    expect(result?.userFacingText).toContain("Premium");
    expect(result?.data).toMatchObject({ errorCode: "SPOTIFY_PREMIUM_REQUIRED" });
  });

  it("no-active-device suggests a device handoff", async () => {
    const mock = tokenRoute(new MockSpotify()).on("POST", `${API}/v1/me/player/next`, () =>
      spotifyError(404, "No active device found", "NO_ACTIVE_DEVICE")
    );
    const runtime = makeRuntime(mock);
    const { result } = await run(runtime, { action: "next" });
    expect(result?.success).toBe(false);
    expect(result?.userFacingText).toContain("transfer");
    expect(result?.data).toMatchObject({ errorCode: "SPOTIFY_NO_ACTIVE_DEVICE" });
  });

  it("rate limiting maps to a retry-later failure", async () => {
    const mock = tokenRoute(new MockSpotify()).on(
      "GET",
      `${API}/v1/me/tracks`,
      () =>
        new Response(JSON.stringify({ error: { status: 429, message: "limited" } }), {
          status: 429,
          headers: { "Retry-After": "3" },
        })
    );
    const runtime = makeRuntime(mock);
    const { result } = await run(runtime, { action: "library_list" });
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ errorCode: "SPOTIFY_RATE_LIMITED" });
  });

  it("devices + transfer route through to the handoff endpoint", async () => {
    const mock = tokenRoute(new MockSpotify())
      .on("GET", `${API}/v1/me/player/devices`, () =>
        jsonResponse(200, { devices: [rawDevice("d1", "Desk", false)] })
      )
      .on("PUT", `${API}/v1/me/player`, () => new Response(null, { status: 204 }));
    const runtime = makeRuntime(mock);
    const { result: devices } = await run(runtime, { action: "devices" });
    expect(devices?.success).toBe(true);
    expect(devices?.userFacingText).toContain("Desk");
    const { result: transfer } = await run(runtime, { action: "transfer", deviceId: "d1" });
    expect(transfer?.success).toBe(true);
    const handoff = mock.requests.find(
      (r) => r.method === "PUT" && r.url.endsWith("/v1/me/player")
    );
    expect(JSON.parse(handoff?.body ?? "{}")).toEqual({ device_ids: ["d1"], play: true });
  });

  it("transfer without a deviceId is invalid input", async () => {
    const runtime = makeRuntime(tokenRoute(new MockSpotify()));
    const { result } = await run(runtime, { action: "transfer" });
    expect(result?.success).toBe(false);
    expect(result?.userFacingText).toContain("deviceId");
  });

  it("validate() requires the service to be registered", async () => {
    const runtime = makeRuntime(new MockSpotify());
    expect(await spotifyAction.validate(runtime, message)).toBe(true);
    const bare = { getService: () => null } as unknown as IAgentRuntime;
    expect(await spotifyAction.validate(bare, message)).toBe(false);
  });

  it("does not translate unexpected programming failures into provider results", async () => {
    const bug = new TypeError("implementation bug");
    const runtime = {
      getService: () => ({
        resolveAccountId: async () => "acct",
        search: async () => {
          throw bug;
        },
      }),
    } as unknown as IAgentRuntime;

    await expect(run(runtime, { action: "search", query: "song" })).rejects.toBe(bug);
  });
});
