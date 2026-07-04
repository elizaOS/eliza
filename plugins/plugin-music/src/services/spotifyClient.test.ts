/**
 * Deterministic Spotify recommendation tests for seed truncation and outbound
 * request construction using a stubbed fetch implementation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpotifyClient, testExports } from "./spotifyClient";

describe("SpotifyClient recommendations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("caps recommendation seeds to five total in deterministic priority order", () => {
    const params = new URLSearchParams();

    testExports.appendSeedParams(params, {
      seedArtists: ["artist-1", "artist-2", "artist-3"],
      seedTracks: ["track-1", "track-2", "track-3"],
      seedGenres: ["rock", "jazz", "pop"],
    });

    expect(params.get("seed_artists")).toBe("artist-1,artist-2,artist-3");
    expect(params.get("seed_tracks")).toBe("track-1,track-2");
    expect(params.has("seed_genres")).toBe(false);
  });

  it("sends no more than five total seeds to the recommendations endpoint", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const urlText = String(url);
      if (urlText.includes("/api/token")) {
        return Response.json({
          access_token: "spotify-token",
          expires_in: 3600,
        });
      }
      return Response.json({ tracks: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new SpotifyClient("client-id", "client-secret");
    await client.getRecommendations({
      seedArtists: ["artist-1", "artist-2", "artist-3"],
      seedTracks: ["track-1", "track-2", "track-3"],
      seedGenres: ["rock", "jazz", "pop"],
      limit: 10,
    });

    const recommendationUrl = fetchMock.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.includes("/recommendations"));
    expect(recommendationUrl).toBeDefined();
    const params = new URL(recommendationUrl as string).searchParams;
    const totalSeeds = ["seed_artists", "seed_tracks", "seed_genres"]
      .flatMap((key) => params.get(key)?.split(",") ?? [])
      .filter(Boolean);

    expect(totalSeeds).toEqual([
      "artist-1",
      "artist-2",
      "artist-3",
      "track-1",
      "track-2",
    ]);
    expect(params.get("limit")).toBe("10");
  });
});
