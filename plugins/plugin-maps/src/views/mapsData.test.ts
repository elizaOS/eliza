/**
 * Verifies the browser transport parses only valid route and broker envelopes,
 * and rejects malformed JSON, error envelopes, broker failures, and
 * schema-invalid payloads instead of fabricating healthy state. The CSRF fetch
 * client is mocked; every payload shape matches the real transports.
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaceRef } from "../types.js";

const fetchWithCsrf = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui/api/csrf-client", () => ({ fetchWithCsrf }));

import {
  fetchMapsState,
  planRouteAlternatives,
  searchPlaces,
} from "./mapsData.js";

const pier: PlaceRef = {
  provider: "fixture-maps",
  providerPlaceId: "pier-1",
  name: "Santa Monica Pier",
  coordinates: { latitude: 34.0092, longitude: -118.4973 },
  categories: ["landmark"],
};

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("fetchMapsState", () => {
  it("parses a schema-valid snapshot envelope", async () => {
    fetchWithCsrf.mockResolvedValue(
      response(200, {
        success: true,
        data: {
          providers: [
            { id: "fixture-maps", attribution: null, isDefault: true },
          ],
          providerAvailable: true,
          savedPlaces: { status: "ok", places: [] },
        },
      }),
    );
    const snapshot = await fetchMapsState();
    expect(snapshot.providerAvailable).toBe(true);
    expect(fetchWithCsrf).toHaveBeenCalledWith(
      "/api/maps/state",
      expect.anything(),
    );
  });

  it("rejects a schema-invalid snapshot instead of rendering it", async () => {
    fetchWithCsrf.mockResolvedValue(
      response(200, { success: true, data: { providers: "nope" } }),
    );
    await expect(fetchMapsState()).rejects.toThrow(/invalid state snapshot/);
  });

  it("surfaces structured route errors with their code", async () => {
    fetchWithCsrf.mockResolvedValue(
      response(503, {
        success: false,
        error: { code: "MAPS_PROVIDER_UNAVAILABLE", message: "No provider." },
      }),
    );
    await expect(fetchMapsState()).rejects.toMatchObject({
      message: "No provider.",
      cause: "MAPS_PROVIDER_UNAVAILABLE",
    });
  });

  it("rejects malformed JSON with the parser cause preserved", async () => {
    fetchWithCsrf.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    } as unknown as Response);
    await expect(fetchMapsState()).rejects.toThrow(/malformed JSON/);
  });
});

describe("broker capabilities", () => {
  it("parses a successful search broker envelope", async () => {
    fetchWithCsrf.mockResolvedValue(
      response(200, {
        requestId: "req-1",
        success: true,
        result: {
          success: true,
          text: "ok",
          data: { places: [pier], nextCursor: null },
        },
      }),
    );
    const page = await searchPlaces({ query: "pier" });
    expect(page.places[0]?.name).toBe("Santa Monica Pier");
  });

  it("throws the broker failure text for an unsuccessful capability", async () => {
    fetchWithCsrf.mockResolvedValue(
      response(200, {
        requestId: "req-2",
        success: true,
        result: {
          success: false,
          text: "No maps provider adapter is available.",
          error: { code: "MAPS_PROVIDER_UNAVAILABLE", message: "n/a" },
        },
      }),
    );
    await expect(searchPlaces({ query: "pier" })).rejects.toThrow(
      /No maps provider adapter is available/,
    );
  });

  it("rejects schema-invalid route alternatives", async () => {
    fetchWithCsrf.mockResolvedValue(
      response(200, {
        requestId: "req-3",
        success: true,
        result: { success: true, text: "ok", data: { alternatives: [] } },
      }),
    );
    await expect(
      planRouteAlternatives({
        originPlaceId: "pier-1",
        destinationPlaceId: "cafe-1",
      }),
    ).rejects.toThrow(/invalid route alternatives result/);
  });
});
