/**
 * Exercises the /maps view broker against a real AgentRuntime, a real
 * MapsService, and a deterministic in-memory provider adapter — the fixture
 * data path the routed view renders in audits, independent of live APIs.
 * Covers success, designed-empty, invalid input, pagination, provider
 * unavailability, auth expiry, rate limiting, partial route alternatives,
 * malformed provider data, and unknown capabilities.
 */

import {
  AgentRuntime,
  createCharacter,
  InMemoryDatabaseAdapter,
  type UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MapsProviderAdapter } from "./adapter.js";
import { MapsError } from "./errors.js";
import { serverInteract } from "./interact.js";
import { MAPS_SERVICE_TYPE, MapsService } from "./service.js";
import type { PlacePage, PlaceRef } from "./types.js";
import { buildMapsViewSnapshot, mapsViewSnapshotSchema } from "./view-state.js";

const AGENT_ID = "11111111-1111-4111-a111-111111111111" as UUID;
const OWNER_ID = "22222222-2222-4222-a222-222222222222" as UUID;

const pier: PlaceRef = {
  provider: "fixture-maps",
  providerPlaceId: "pier-1",
  name: "Santa Monica Pier",
  coordinates: { latitude: 34.0092, longitude: -118.4973 },
  formattedAddress: "200 Santa Monica Pier",
  categories: ["landmark"],
};
const cafe: PlaceRef = {
  ...pier,
  providerPlaceId: "cafe-1",
  name: "Harbor Cafe",
  coordinates: { latitude: 34.0101, longitude: -118.4931 },
  categories: ["cafe"],
};

function fixtureAdapter(
  overrides: Partial<MapsProviderAdapter> = {},
): MapsProviderAdapter {
  return {
    id: "fixture-maps",
    connectionId: "conn_fixture1234567890",
    attribution: "Map data © Fixture Maps contributors",
    async searchPlaces(request): Promise<PlacePage> {
      if (request.query === "empty") return { places: [], nextCursor: null };
      if (request.cursor === "page-2") {
        return { places: [cafe], nextCursor: null };
      }
      return { places: [pier], nextCursor: "page-2" };
    },
    async getPlace(id) {
      if (id === pier.providerPlaceId) return pier;
      if (id === cafe.providerPlaceId) return cafe;
      return null;
    },
    async planRoute(request) {
      if (request.travelMode === "transit") {
        throw new MapsError("Transit routing is not offered here.", {
          code: "MAPS_PROVIDER_REJECTED",
        });
      }
      return {
        provider: "fixture-maps",
        routeId: `route-${request.travelMode}`,
        origin: request.origin,
        destination: request.destination,
        travelMode: request.travelMode,
        distanceMeters: 2_400,
        durationSeconds: 900,
        warnings: [],
      };
    },
    ...overrides,
  };
}

describe("maps view serverInteract", () => {
  let runtime: AgentRuntime;
  let service: MapsService;

  beforeEach(() => {
    runtime = new AgentRuntime({
      agentId: AGENT_ID,
      character: createCharacter({
        name: "Maps View Test",
        settings: { ELIZA_ADMIN_ENTITY_ID: OWNER_ID },
      }),
      adapter: new InMemoryDatabaseAdapter(),
      disableBasicCapabilities: true,
      logLevel: "fatal",
    });
    service = new MapsService(runtime);
    service.registerAdapter(fixtureAdapter(), true);
    vi.spyOn(runtime, "getService").mockImplementation((serviceType) =>
      serviceType === MAPS_SERVICE_TYPE ? service : null,
    );
  });

  it("returns a schema-valid snapshot with providers and saved places", async () => {
    const result = await serverInteract("get-maps-state", undefined, {
      runtime,
    });
    expect(result.success).toBe(true);
    const snapshot = mapsViewSnapshotSchema.parse(result.data);
    expect(snapshot.providerAvailable).toBe(true);
    expect(snapshot.providers).toEqual([
      {
        id: "fixture-maps",
        attribution: "Map data © Fixture Maps contributors",
        isDefault: true,
      },
    ]);
    expect(snapshot.savedPlaces).toEqual({ status: "ok", places: [] });
  });

  it("reports saved places unavailable without a configured owner", async () => {
    const anonymousRuntime = new AgentRuntime({
      agentId: AGENT_ID,
      character: createCharacter({ name: "No Owner" }),
      adapter: new InMemoryDatabaseAdapter(),
      disableBasicCapabilities: true,
      logLevel: "fatal",
    });
    const snapshot = await buildMapsViewSnapshot(anonymousRuntime, service);
    expect(snapshot.savedPlaces.status).toBe("unavailable");
  });

  it("searches places and pages with the returned cursor", async () => {
    const first = await serverInteract(
      "search-places",
      { query: "pier" },
      { runtime },
    );
    expect(first.success).toBe(true);
    const firstPage = first.data as PlacePage;
    expect(firstPage.places.map((place) => place.name)).toEqual([
      "Santa Monica Pier",
    ]);
    expect(firstPage.nextCursor).toBe("page-2");

    const second = await serverInteract(
      "search-places",
      { query: "pier", cursor: "page-2" },
      { runtime },
    );
    const secondPage = second.data as PlacePage;
    expect(secondPage.places.map((place) => place.name)).toEqual([
      "Harbor Cafe",
    ]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("returns designed-empty search results distinctly from errors", async () => {
    const result = await serverInteract(
      "search-places",
      { query: "empty" },
      { runtime },
    );
    expect(result.success).toBe(true);
    expect((result.data as PlacePage).places).toEqual([]);
    expect(result.text).toBe("No places matched that search.");
  });

  it("rejects invalid input as an explicit failure result", async () => {
    for (const params of [
      {},
      { query: "  " },
      { query: "pier", latitude: 12 },
      { query: "pier", latitude: 400, longitude: 0 },
      { query: "pier", limit: 2.5 },
      { query: "pier", bogus: true },
    ]) {
      const result = await serverInteract("search-places", params, {
        runtime,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("MAPS_INVALID_INPUT");
    }
  });

  it("fails explicitly when no provider adapter is registered", async () => {
    service.unregisterAdapter("fixture-maps");
    const result = await serverInteract(
      "search-places",
      { query: "pier" },
      { runtime },
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("MAPS_PROVIDER_UNAVAILABLE");
  });

  it("translates provider auth expiry and rate limiting into failure results", async () => {
    for (const code of ["MAPS_AUTH_EXPIRED", "MAPS_RATE_LIMITED"] as const) {
      service.unregisterAdapter("fixture-maps");
      service.registerAdapter(
        fixtureAdapter({
          async searchPlaces() {
            throw new MapsError("Provider refused the request.", { code });
          },
        }),
        true,
      );
      const result = await serverInteract(
        "search-places",
        { query: "pier" },
        { runtime },
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(code);
    }
  });

  it("rethrows systemic provider-spoofing failures to the route boundary", async () => {
    service.unregisterAdapter("fixture-maps");
    service.registerAdapter(
      fixtureAdapter({
        async searchPlaces() {
          return {
            places: [{ ...pier, provider: "spoofed-provider" }],
            nextCursor: null,
          };
        },
      }),
      true,
    );
    await expect(
      serverInteract("search-places", { query: "pier" }, { runtime }),
    ).rejects.toMatchObject({ code: "MAPS_MALFORMED_RESPONSE" });
  });

  it("reads one place and reports missing ids as not found", async () => {
    const found = await serverInteract(
      "get-place",
      { placeId: "pier-1" },
      { runtime },
    );
    expect(found.success).toBe(true);
    expect((found.data as { place: PlaceRef }).place.name).toBe(
      "Santa Monica Pier",
    );

    const missing = await serverInteract(
      "get-place",
      { placeId: "nowhere" },
      { runtime },
    );
    expect(missing.success).toBe(false);
    expect(missing.error?.code).toBe("MAPS_NOT_FOUND");
  });

  it("plans route alternatives with explicit per-mode failures", async () => {
    const result = await serverInteract(
      "plan-route-alternatives",
      { originPlaceId: "pier-1", destinationPlaceId: "cafe-1" },
      { runtime },
    );
    expect(result.success).toBe(true);
    const data = result.data as {
      alternatives: Array<{ travelMode: string; status: string }>;
    };
    expect(data.alternatives.map((a) => [a.travelMode, a.status])).toEqual([
      ["drive", "ok"],
      ["walk", "ok"],
      ["bicycle", "ok"],
      ["transit", "error"],
    ]);
  });

  it("fails plan-route-alternatives when every mode fails", async () => {
    service.unregisterAdapter("fixture-maps");
    service.registerAdapter(
      fixtureAdapter({
        async planRoute() {
          throw new MapsError("Routing is down.", {
            code: "MAPS_PROVIDER_FAILURE",
          });
        },
      }),
      true,
    );
    const result = await serverInteract(
      "plan-route-alternatives",
      { originPlaceId: "pier-1", destinationPlaceId: "cafe-1" },
      { runtime },
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("MAPS_PROVIDER_FAILURE");
  });

  it("rejects unknown capabilities and a missing runtime", async () => {
    await expect(
      serverInteract("format-disk", {}, { runtime }),
    ).rejects.toMatchObject({ code: "MAPS_UNKNOWN_CAPABILITY" });
    const result = await serverInteract("get-maps-state");
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("MAPS_PROVIDER_UNAVAILABLE");
  });
});
