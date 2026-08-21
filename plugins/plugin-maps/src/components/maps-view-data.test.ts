/** Verifies browser validation at the authenticated Maps view-broker boundary. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithCsrf = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui/api/csrf-client", () => ({ fetchWithCsrf }));

import { mapsViewTransport } from "./maps-view-data.js";

const PLACE = {
  provider: "fixture_maps",
  providerPlaceId: "ferry-building",
  name: "Ferry Building",
  coordinates: { latitude: 37.7955, longitude: -122.3937 },
  formattedAddress: "1 Ferry Building, San Francisco",
  categories: ["landmark"],
};

const PROVIDER = {
  id: "fixture_maps",
  attribution: "Map data © Fixture Maps",
  generation: 7,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("mapsViewTransport", () => {
  beforeEach(() => fetchWithCsrf.mockReset());

  it("validates a successful search page and its captured provider generation", async () => {
    fetchWithCsrf.mockResolvedValue(
      response({
        requestId: "maps-request-1",
        success: true,
        result: {
          success: true,
          data: {
            page: { places: [PLACE], nextCursor: null },
            provider: PROVIDER,
          },
        },
      }),
    );

    await expect(mapsViewTransport.search("ferry")).resolves.toEqual({
      page: { places: [PLACE], nextCursor: null },
      provider: PROVIDER,
    });
    expect(fetchWithCsrf).toHaveBeenCalledWith(
      "/api/views/maps/interact",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          capability: "maps-search-places",
          params: { query: "ferry", limit: 24 },
        }),
      }),
    );
  });

  it("rejects malformed success data and explicit broker failures", async () => {
    fetchWithCsrf.mockResolvedValueOnce(
      response({
        requestId: "maps-request-2",
        success: true,
        result: {
          success: true,
          data: {
            page: {
              places: [
                { ...PLACE, coordinates: { latitude: 900, longitude: 0 } },
              ],
              nextCursor: null,
            },
            provider: PROVIDER,
          },
        },
      }),
    );
    await expect(mapsViewTransport.search("bad data")).rejects.toThrow();

    fetchWithCsrf.mockResolvedValueOnce(
      response({
        requestId: "maps-request-3",
        success: false,
        error: { message: "Connection expired." },
      }),
    );
    await expect(mapsViewTransport.search("expired")).rejects.toThrow(
      "Connection expired.",
    );
  });

  it("rejects malformed JSON without converting it to an empty result", async () => {
    fetchWithCsrf.mockResolvedValue(
      new Response("{not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(mapsViewTransport.search("broken")).rejects.toThrow(
      "Maps returned malformed JSON.",
    );
  });

  it("forwards opaque cursors with the exact provider generation", async () => {
    fetchWithCsrf.mockResolvedValueOnce(
      response({ error: { message: "Maps authorization expired." } }, 401),
    );
    await expect(mapsViewTransport.search("museum")).rejects.toThrow(
      "Maps authorization expired.",
    );

    fetchWithCsrf.mockResolvedValueOnce(
      response({ error: { message: "Maps authorization revoked." } }, 403),
    );
    await expect(
      mapsViewTransport.search("museum", undefined, "opaque-page-2", PROVIDER),
    ).rejects.toThrow("Maps authorization revoked.");
    expect(fetchWithCsrf).toHaveBeenLastCalledWith(
      "/api/views/maps/interact",
      expect.objectContaining({
        body: JSON.stringify({
          capability: "maps-search-places",
          params: {
            query: "museum",
            limit: 24,
            cursor: "opaque-page-2",
            provider: "fixture_maps",
            providerGeneration: 7,
          },
        }),
      }),
    );
  });
});
