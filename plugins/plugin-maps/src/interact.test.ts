/**
 * Verifies the Maps view broker against a deterministic service seam. Reads
 * dispatch to MapsService while mutation names remain unsupported.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { MapsProviderAdapter } from "./adapter.js";
import { MapsError } from "./errors.js";
import { serverInteract } from "./interact.js";
import { MapsService } from "./service.js";
import type { PlaceRef, RoutePlan } from "./types.js";

const ORIGIN: PlaceRef = {
  provider: "fixture_maps",
  providerPlaceId: "origin",
  name: "Ferry Building",
  formattedAddress: "1 Ferry Building, San Francisco",
  coordinates: { latitude: 37.7955, longitude: -122.3937 },
  categories: ["landmark"],
};

const DESTINATION: PlaceRef = {
  provider: "fixture_maps",
  providerPlaceId: "destination",
  name: "Embarcadero Plaza",
  formattedAddress: "Market Street, San Francisco",
  coordinates: { latitude: 37.7951, longitude: -122.3964 },
  categories: ["park"],
};

const ROUTE: RoutePlan = {
  provider: "fixture_maps",
  routeId: "route-walk",
  origin: ORIGIN,
  destination: DESTINATION,
  travelMode: "walk",
  distanceMeters: 450,
  durationSeconds: 360,
  warnings: [],
};

function harness(over: Partial<MapsProviderAdapter> = {}) {
  let service: MapsService;
  const runtime = {
    getService: vi.fn(() => service),
  } as unknown as IAgentRuntime;
  const adapter: MapsProviderAdapter = {
    id: "fixture_maps",
    connectionId: "conn_fixture_maps_0001",
    searchPlaces: vi.fn(async () => ({
      places: [ORIGIN, DESTINATION],
      nextCursor: null,
    })),
    getPlace: vi.fn(async () => ORIGIN),
    planRoute: vi.fn(async () => ROUTE),
    ...over,
  };
  service = new MapsService(runtime);
  service.registerAdapter(adapter, true);
  return { runtime, service, adapter };
}

describe("Maps view serverInteract", () => {
  it("dispatches normalized search, detail, and route reads", async () => {
    const { runtime, adapter } = harness();

    await expect(
      serverInteract(
        "maps-search-places",
        { query: " waterfront ", limit: 12 },
        { runtime },
      ),
    ).resolves.toMatchObject({
      success: true,
      data: { places: [ORIGIN, DESTINATION], nextCursor: null },
    });
    expect(adapter.searchPlaces).toHaveBeenCalledWith({
      query: "waterfront",
      limit: 12,
    });

    await expect(
      serverInteract(
        "maps-get-place",
        { placeId: ORIGIN.providerPlaceId, provider: ORIGIN.provider },
        { runtime },
      ),
    ).resolves.toMatchObject({ success: true, data: { place: ORIGIN } });

    await expect(
      serverInteract(
        "maps-plan-route",
        { origin: ORIGIN, destination: DESTINATION, travelMode: "walk" },
        { runtime },
      ),
    ).resolves.toMatchObject({ success: true, data: { route: ROUTE } });
  });

  it("returns typed invalid-input and provider failures", async () => {
    const { runtime } = harness({
      searchPlaces: vi.fn(async () => {
        throw new MapsError("Slow down.", {
          code: "MAPS_RATE_LIMITED",
          retryAfterMs: 4_000,
        });
      }),
    });

    await expect(
      serverInteract(
        "maps-plan-route",
        { origin: {}, travelMode: "hover" },
        { runtime },
      ),
    ).resolves.toEqual({
      success: false,
      text: "Maps input is invalid.",
      error: {
        code: "MAPS_INVALID_INPUT",
        message: "Maps input is invalid.",
      },
    });
    await expect(
      serverInteract("maps-search-places", { query: "cafe" }, { runtime }),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "MAPS_RATE_LIMITED", retryAfterMs: 4_000 },
    });

    for (const provider of [
      "contains spaces",
      "-leading-dash",
      "x".repeat(65),
      42,
    ]) {
      await expect(
        serverInteract(
          "maps-search-places",
          { query: "cafe", provider },
          { runtime },
        ),
      ).resolves.toMatchObject({
        success: false,
        error: { code: "MAPS_INVALID_INPUT" },
      });
    }
  });

  it("does not expose a save capability that bypasses receipt settlement", async () => {
    const { runtime, service } = harness();
    const savePlace = vi.spyOn(service, "savePlace");

    await expect(
      serverInteract("maps-save-place", { place: ORIGIN }, { runtime }),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "MAPS_INVALID_INPUT" },
    });
    expect(savePlace).not.toHaveBeenCalled();
  });
});
