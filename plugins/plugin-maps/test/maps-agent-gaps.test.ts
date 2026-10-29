/**
 * Agent-facing Maps gaps: a request Cloud cancelled before admission is a
 * typed cancelled result, transit is offered only where a provider reports it,
 * and saved places are listed with the phone's own Maps list reconciled in.
 * Providers, stores and hosts are in-process stubs; no request leaves the test.
 */
import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { mapsAction } from "../src/action.js";
import type { MapsProviderAdapter } from "../src/adapter.js";
import { SavedPlaces } from "../src/client/saved-places.ts";
import { offeredTravelModes } from "../src/coverage.js";
import { MapsError } from "../src/errors.js";
import { serverInteract } from "../src/interact.js";
import {
  type MapsHostSavedPlace,
  parseHostSavedPlaces,
  reconcileSavedPlaces,
} from "../src/saved-places-host.js";
import { MapsService } from "../src/service.js";
import type { SavedPlaceStore } from "../src/store.js";
import type { MapsCoverage, PlaceRef, SavedPlace } from "../src/types.js";

const OWNER = "00000000-0000-4000-8000-000000000002";
const PORT: PlaceRef = {
  provider: "stub",
  providerPlaceId: "N1",
  name: "Port Hercule",
  coordinates: { latitude: 43.7347, longitude: 7.4206 },
  categories: [],
};
const CASINO: PlaceRef = {
  provider: "stub",
  providerPlaceId: "N2",
  name: "Casino",
  coordinates: { latitude: 43.7397, longitude: 7.4276 },
  categories: [],
};
const saved = (place: PlaceRef, label: string, n: number): SavedPlace => ({
  id: `00000000-0000-4000-8000-00000000010${n}`,
  ownerEntityId: OWNER,
  place,
  label,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

function store(rows: SavedPlace[]): SavedPlaceStore {
  return {
    save: async () => {
      throw new Error("no writes in this test");
    },
    list: async (owner) => rows.filter((row) => row.ownerEntityId === owner),
    get: async () => null,
  };
}

function adapter(
  coverage: Partial<MapsCoverage> | null,
  routed: string[] = [],
): MapsProviderAdapter {
  return {
    id: "stub",
    connectionId: "conn_stub_maps_provider_01",
    attribution: "Stub data",
    supportsCrossProviderRoutes: true,
    searchPlaces: async () => ({ places: [], nextCursor: null }),
    getPlace: async () => null,
    planRoute: async (request: {
      origin: PlaceRef;
      destination: PlaceRef;
      travelMode: string;
    }) => {
      routed.push(request.travelMode);
      return {
        provider: "stub",
        routeId: "r1",
        origin: request.origin,
        destination: request.destination,
        travelMode: request.travelMode,
        distanceMeters: 1000,
        durationSeconds: 600,
        warnings: [],
      };
    },
    ...(coverage
      ? {
          coverage: async () => ({
            provider: "stub",
            regions: [],
            travelModes: ["drive", "walk", "bicycle"],
            alternatives: false,
            reverseGeocode: false,
            liveTraffic: false,
            transitSchedules: false,
            offline: false,
            ...coverage,
          }),
        }
      : {}),
  } as unknown as MapsProviderAdapter;
}

const runtimeWith = (service: MapsService) =>
  ({ getService: () => service }) as unknown as IAgentRuntime;
const message = (parameters: Record<string, unknown>) =>
  ({
    id: "00000000-0000-4000-8000-000000000001",
    entityId: OWNER,
    roomId: "00000000-0000-4000-8000-000000000003",
    content: { text: "", ...parameters },
  }) as unknown as Memory;
const run = (service: MapsService, parameters: Record<string, unknown>) =>
  mapsAction.handler?.(runtimeWith(service), message(parameters), undefined, {
    parameters,
  } as HandlerOptions);

describe("cancelled before admission", () => {
  it("is a typed cancelled result that the planner must not retry", async () => {
    const service = new MapsService(undefined, store([]));
    service.registerAdapter({
      ...adapter(null),
      searchPlaces: async () => {
        throw new MapsError(
          "The Maps request was cancelled before Eliza Cloud admitted it.",
          { code: "MAPS_REQUEST_CANCELLED" },
        );
      },
    } as MapsProviderAdapter);
    const result = await run(service, { action: "place", query: "Port" });
    expect(result).toMatchObject({
      success: false,
      data: {
        error: "MAPS_REQUEST_CANCELLED",
        reason: "cancelled",
        cancelled: true,
        retryable: false,
      },
    });
  });
});

describe("transit is offered only where a provider reports it", () => {
  it("derives offered modes from coverage, never assuming transit", () => {
    expect(offeredTravelModes(null)).toEqual(["drive", "walk", "bicycle"]);
    expect(offeredTravelModes({ travelModes: ["walk", "transit"] })).toEqual([
      "walk",
      "transit",
    ]);
    expect(offeredTravelModes({ travelModes: ["drive"] })).toEqual(["drive"]);
  });

  it("asks for a mode with only served options", async () => {
    const service = new MapsService(undefined, store([]));
    service.registerAdapter(adapter({ travelModes: ["drive", "walk"] }));
    const result = await run(service, { action: "route" });
    const form = (
      result?.data as { uiRequest: { fields: unknown[] } } | undefined
    )?.uiRequest;
    expect(form?.fields).toContainEqual(
      expect.objectContaining({
        name: "travelMode",
        options: [
          { value: "drive", label: "Drive" },
          { value: "walk", label: "Walk" },
        ],
      }),
    );
  });

  it("refuses transit before dispatch when coverage does not list it", async () => {
    const routed: string[] = [];
    const service = new MapsService(undefined, store([]));
    service.registerAdapter(adapter({}, routed));
    const coordinates = {
      originName: "A",
      originLatitude: 43.7397,
      originLongitude: 7.4276,
      destinationName: "B",
      destinationLatitude: 43.7347,
      destinationLongitude: 7.4206,
    };
    const refused = await run(service, {
      action: "route",
      travelMode: "transit",
      ...coordinates,
    });
    expect(refused).toMatchObject({
      success: false,
      text: "This Maps provider does not serve transit routes.",
      data: { error: "MAPS_UNSUPPORTED_REGION" },
    });
    expect(routed).toEqual([]);
    // A provider that reports transit is asked for it.
    const transit = new MapsService(undefined, store([]));
    transit.registerAdapter(
      adapter({ travelModes: ["drive", "transit"] }, routed),
    );
    await run(transit, {
      action: "route",
      travelMode: "transit",
      ...coordinates,
    });
    expect(routed).toEqual(["transit"]);
  });

  it("answers the view's coverage read", async () => {
    const service = new MapsService(undefined, store([]));
    service.registerAdapter(adapter({ travelModes: ["walk"] }));
    const result = await serverInteract("maps-coverage", undefined, {
      runtime: runtimeWith(service),
    });
    expect(result).toMatchObject({
      success: true,
      data: { coverage: { travelModes: ["walk"] } },
    });
  });
});

describe("saved places reconciled with the phone's list", () => {
  const device: MapsHostSavedPlace[] = [
    {
      id: "d1",
      label: "Harbour",
      coordinates: PORT.coordinates,
      provider: "stub",
      providerPlaceId: "N1",
      savedAt: 1,
    },
    {
      id: "d2",
      label: "Pin",
      coordinates: { latitude: 43.7, longitude: 7.4 },
      savedAt: 3,
    },
    {
      id: "d3",
      label: "Older pin",
      coordinates: { latitude: 43.71, longitude: 7.41 },
      savedAt: 2,
    },
  ];

  it("keeps the agent's rows first, marks shared ones and appends device-only rows newest first", () => {
    const places = reconcileSavedPlaces(
      [saved(PORT, "Port", 1), saved(CASINO, "Casino", 2)],
      device,
    );
    expect(
      places.map(({ label, source, deviceId }) => ({
        label,
        source,
        deviceId,
      })),
    ).toEqual([
      { label: "Port", source: "both", deviceId: "d1" },
      { label: "Casino", source: "agent", deviceId: undefined },
      { label: "Pin", source: "device", deviceId: "d2" },
      { label: "Older pin", source: "device", deviceId: "d3" },
    ]);
    expect(places[2]?.place).toMatchObject({
      provider: "coordinates",
      providerPlaceId: "coordinates:43.7,7.4",
    });
  });

  it("refuses a malformed device list as a whole", () => {
    expect(() =>
      parseHostSavedPlaces([{ ...device[0], provider: undefined }]),
    ).toThrow(MapsError);
    expect(() => parseHostSavedPlaces([device[1], device[1]])).toThrow(
      MapsError,
    );
    expect(() => parseHostSavedPlaces({})).toThrow(MapsError);
  });

  it("lists through MAPS saved with the host namespace, and still lists when the host fails", async () => {
    const service = new MapsService(undefined, store([saved(PORT, "Port", 1)]));
    expect(() =>
      service.registerSavedPlacesHost({
        namespace: "bad namespace",
        list: async () => [],
      }),
    ).toThrow(MapsError);
    const memory = new Map<string, string>();
    const phone = new SavedPlaces("alpha.maps.saved-places.v1", {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => void memory.set(key, value),
    });
    phone.save({
      label: "Pin",
      coordinate: { latitude: 43.7, longitude: 7.4 },
    });
    phone.save({
      label: "Harbour",
      coordinate: PORT.coordinates,
      providerId: "stub",
      providerPlaceId: "N1",
    });
    service.registerSavedPlacesHost(phone.host());
    const listed = await run(service, { action: "saved" });
    expect(listed).toMatchObject({
      success: true,
      text: "Saved places: Port, Pin.",
      data: {
        action: "saved",
        device: "listed",
        namespace: "alpha.maps.saved-places.v1",
      },
    });
    expect(
      (
        listed?.data as { places: { source: string }[] } | undefined
      )?.places.map((row) => row.source),
    ).toEqual(["both", "device"]);

    memory.set("alpha.maps.saved-places.v1", "{not json");
    const degraded = await run(service, { action: "saved" });
    expect(degraded).toMatchObject({
      success: true,
      text: "Saved places: Port. Places saved only on the phone could not be read right now.",
      data: { device: "unavailable" },
    });
    service.registerSavedPlacesHost(null);
    expect(await run(service, { action: "saved" })).toMatchObject({
      data: { device: "none" },
    });
  });
});
