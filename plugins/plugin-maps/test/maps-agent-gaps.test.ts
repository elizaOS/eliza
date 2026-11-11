/**
 * Agent-facing Maps gaps: a request Cloud cancelled before admission is a
 * typed cancelled result, transit is offered only where a provider reports it,
 * and saved places are listed with the phone's own Maps list reconciled in.
 * Providers, stores and hosts are in-process stubs; no request leaves the test.
 */
import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

// Owner access is resolved by core from world roles; the stub runtime has none,
// so the test names the owner entity directly.
vi.mock("@elizaos/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/core")>()),
  hasOwnerAccess: async (_runtime: unknown, message: { entityId?: string }) =>
    message?.entityId === OWNER,
}));

import { mapsAction, mapsNavigationAction } from "../src/action.js";
import type { MapsProviderAdapter } from "../src/adapter.js";
import { SavedPlaces } from "../src/client/saved-places.ts";
import { planCoveredRoutes } from "../src/components/plan-covered-routes.js";
import { offeredTravelModes } from "../src/coverage.js";
import { MapsError } from "../src/errors.js";
import { serverInteract } from "../src/interact.js";
import type { MapsDeviceNavigation } from "../src/navigation.js";
import { mapsPlugin } from "../src/plugin.js";
import {
  type MapsHostSavedPlace,
  parseHostSavedPlaces,
  reconcileSavedPlaces,
} from "../src/saved-places-host.js";
import { MapsService } from "../src/service.js";
import type { SavedPlaceStore } from "../src/store.js";
import type {
  MapsCoverage,
  MapsProviderDescription,
  MapsRouteResult,
  PlaceRef,
  SavedPlace,
  TravelMode,
} from "../src/types.js";

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
const message = (parameters: Record<string, unknown>, entityId = OWNER) =>
  ({
    id: "00000000-0000-4000-8000-000000000001",
    entityId,
    roomId: "00000000-0000-4000-8000-000000000003",
    content: { text: "", ...parameters },
  }) as unknown as Memory;
const run = (
  service: MapsService,
  parameters: Record<string, unknown>,
  entityId = OWNER,
) =>
  mapsAction.handler?.(
    runtimeWith(service),
    message(parameters, entityId),
    undefined,
    { parameters } as HandlerOptions,
  );

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

describe("transit is offered only where a reported coverage lists it", () => {
  it("derives offered modes from a reported coverage only", () => {
    // No reported coverage narrows nothing: the provider answers each mode.
    expect(offeredTravelModes(null)).toEqual([
      "drive",
      "walk",
      "bicycle",
      "transit",
    ]);
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
    // A provider that publishes no coverage (Google) still answers transit itself.
    const unreported = new MapsService(undefined, store([]));
    unreported.registerAdapter(adapter(null, routed));
    await run(unreported, {
      action: "route",
      travelMode: "transit",
      ...coordinates,
    });
    expect(routed).toEqual(["transit", "transit"]);
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
    const phone = new SavedPlaces("phone.maps.saved-places.v1", {
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
        namespace: "phone.maps.saved-places.v1",
      },
    });
    expect(
      (
        listed?.data as { places: { source: string }[] } | undefined
      )?.places.map((row) => row.source),
    ).toEqual(["both", "device"]);

    // The phone's list is the owner's: another sender never reads it.
    const stranger = await run(
      service,
      { action: "saved" },
      "00000000-0000-4000-8000-000000000009",
    );
    expect(stranger).toMatchObject({
      success: true,
      text: "No places are saved with your assistant yet. Places saved only on the phone's Maps screen aren't included.",
      data: { device: "none", places: [] },
    });
    expect(JSON.stringify(stranger)).not.toContain("Pin");

    memory.set("phone.maps.saved-places.v1", "{not json");
    const degraded = await run(service, { action: "saved" });
    expect(degraded).toMatchObject({
      success: true,
      text: "Saved places: Port. Places saved only on the phone could not be read right now.",
      data: { device: "unavailable" },
    });
    service.registerSavedPlacesHost(null);
    expect(await run(service, { action: "saved" })).toMatchObject({
      text: "Saved places: Port. Places saved only on the phone's Maps screen aren't included.",
      data: { device: "none" },
    });
  });

  it("says a MAPS_SAVE is the assistant's only while no phone list is registered", async () => {
    let commit = 0;
    const writes: SavedPlace[] = [];
    const service = new MapsService(undefined, {
      ...store([]),
      save: async (request) => {
        commit += 1;
        const row = saved(
          request.place,
          request.label ?? request.place.name,
          commit,
        );
        writes.push(row);
        return {
          savedPlace: row,
          replayed: false,
          commitId: `c${commit}`,
          committedAt: "2026-10-01T00:00:00.000Z",
          idempotencyKey: `k${commit}`,
          currentlyApplied: true,
          currentSavedPlace: row,
        };
      },
    });
    const mapsSave = mapsPlugin.actions?.find(
      (action) => action.name === "MAPS_SAVE",
    );
    const parameters = {
      action: "save",
      latitude: 43.7,
      longitude: 7.4,
      name: "Pin",
      label: "Dentist",
    };
    const save = () =>
      mapsSave?.handler?.(
        runtimeWith(service),
        message(parameters),
        undefined,
        { parameters } as HandlerOptions,
      );
    expect(await save()).toMatchObject({
      success: true,
      text: "Saved Dentist with your assistant. It isn't in the phone's Maps list.",
    });
    service.registerSavedPlacesHost({
      namespace: "phone.maps.saved-places.v1",
      list: async () => [],
    });
    expect(await save()).toMatchObject({
      success: true,
      text: "Saved Dentist.",
    });
    expect(writes).toHaveLength(2);
  });
});

describe("the Maps view plans only the modes a provider serves", () => {
  const provider = {
    id: "stub",
    generation: 1,
  } as unknown as MapsProviderDescription;
  function transport(coverage?: () => Promise<MapsCoverage | null>) {
    const asked: TravelMode[] = [];
    return {
      asked,
      port: {
        planRoute: async (
          _o: PlaceRef,
          _d: PlaceRef,
          mode: TravelMode,
        ): Promise<MapsRouteResult> => {
          asked.push(mode);
          return { route: { routeId: mode } } as unknown as MapsRouteResult;
        },
        ...(coverage ? { coverage } : {}),
      },
    };
  }

  it("requests only reported modes, never transit where coverage omits it", async () => {
    const { asked, port } = transport(
      async () => ({ travelModes: ["walk", "drive"] }) as MapsCoverage,
    );
    const plan = await planCoveredRoutes(
      port,
      PORT,
      CASINO,
      provider,
      new AbortController().signal,
    );
    expect(plan?.modes).toEqual(["drive", "walk"]);
    expect(asked.sort()).toEqual(["drive", "walk"]);
  });

  it("narrows nothing when coverage is unreported, unreadable or absent", async () => {
    for (const coverage of [
      async () => null,
      async () => {
        throw new Error("offline");
      },
      undefined,
    ]) {
      const { asked, port } = transport(coverage);
      const plan = await planCoveredRoutes(
        port,
        PORT,
        CASINO,
        provider,
        new AbortController().signal,
      );
      expect(plan?.modes).toEqual(["drive", "walk", "bicycle", "transit"]);
      expect(asked).toHaveLength(4);
    }
  });

  it("sends no route request once the comparison is cancelled", async () => {
    const controller = new AbortController();
    const { asked, port } = transport(async () => {
      controller.abort();
      return { travelModes: ["drive"] } as MapsCoverage;
    });
    expect(
      await planCoveredRoutes(port, PORT, CASINO, provider, controller.signal),
    ).toBeNull();
    expect(asked).toEqual([]);
  });
});

/** A runtime with the cache core's confirmation helper keeps pending consent in. */
function cachedRuntime(service: MapsService) {
  const cache = new Map<string, unknown>();
  return {
    getService: () => service,
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
  } as unknown as IAgentRuntime;
}

const turn = (
  runtime: IAgentRuntime,
  id: number,
  text: string,
  parameters: Record<string, unknown>,
) =>
  mapsAction.handler?.(
    runtime,
    {
      id: `00000000-0000-4000-8000-0000000002${String(id).padStart(2, "0")}`,
      entityId: OWNER,
      roomId: "00000000-0000-4000-8000-000000000003",
      content: { text },
    } as unknown as Memory,
    undefined,
    { parameters } as HandlerOptions,
  ) as Promise<ActionResult>;

describe("sharing a location waits for the user's own reply", () => {
  const port = {
    action: "share",
    name: "Port Hercule",
    latitude: 43.7347,
    longitude: 7.4206,
  };

  it("ignores a model-supplied confirm and the asking message itself", async () => {
    const runtime = cachedRuntime(new MapsService(undefined, store([])));
    const asked = await turn(runtime, 1, "Share Port Hercule", {
      ...port,
      confirm: true,
    });
    expect(asked).toMatchObject({
      success: false,
      data: { reason: "confirmation_required", awaitingUserInput: true },
    });
    expect(asked.data?.handoff).toBeUndefined();
    // The planner running the action again inside the same turn is no reply.
    const again = await turn(runtime, 1, "Share Port Hercule", {
      ...port,
      confirm: true,
    });
    expect(again).toMatchObject({
      success: false,
      data: { reason: "confirmation_required" },
    });
    const shared = await turn(
      runtime,
      2,
      "Yes, share the location of Port Hercule (confirmed).",
      port,
    );
    expect(shared).toMatchObject({
      success: true,
      data: { action: "share", handoff: { kind: "share" } },
    });
    expect(shared.data?.sharedAt).toEqual(expect.any(String));
  });

  it("binds consent to the place it was asked for", async () => {
    const runtime = cachedRuntime(new MapsService(undefined, store([])));
    await turn(runtime, 1, "Share Port Hercule", port);
    const other = await turn(runtime, 2, "Yes, share it.", {
      action: "share",
      name: "Casino",
      latitude: 43.7397,
      longitude: 7.4276,
    });
    expect(other).toMatchObject({
      success: false,
      data: { reason: "confirmation_required" },
    });
    expect(other.data?.handoff).toBeUndefined();
  });

  it("does not share after a no", async () => {
    const runtime = cachedRuntime(new MapsService(undefined, store([])));
    await turn(runtime, 1, "Share Port Hercule", port);
    expect(
      await turn(runtime, 2, "No, do not share my location.", port),
    ).toMatchObject({
      success: false,
      text: "Not shared.",
      data: { reason: "cancelled" },
    });
  });
});

describe("MAPS_NAVIGATE starts phone navigation when the phone can take it", () => {
  const destination = {
    action: "navigate",
    name: "Port Hercule",
    latitude: 43.7347,
    longitude: 7.4206,
    travelMode: "walk",
  };
  function phone(available?: boolean) {
    const started: unknown[] = [];
    const device: MapsDeviceNavigation = {
      ...(available === undefined ? {} : { available: async () => available }),
      select: async () => ({ state: "selected" }),
      start: async ({ destination, travelMode }) => {
        started.push([destination.name, travelMode]);
        return {
          state: "awaiting-confirmation",
          placeName: destination.name,
          travelMode,
        };
      },
      reroute: async () => ({ state: "navigating" }),
      stop: async () => ({ state: "stopped" }),
    };
    return { device, started };
  }

  it("asks the phone, which still waits for the user's confirmation", async () => {
    const service = new MapsService(undefined, store([]));
    const { device, started } = phone(true);
    service.registerDeviceNavigation(device);
    expect(await run(service, destination)).toMatchObject({
      success: false,
      text: "Confirm on the phone to start navigation to Port Hercule.",
      data: {
        action: "navigate",
        awaitingUserInput: true,
        reason: "device_confirmation",
      },
    });
    expect(started).toEqual([["Port Hercule", "walk"]]);
  });

  it("returns the directions link when the phone is not ready, refuses or does not say", async () => {
    for (const available of [false, undefined]) {
      const service = new MapsService(undefined, store([]));
      const { device, started } = phone(available);
      service.registerDeviceNavigation(device);
      expect(await run(service, destination)).toMatchObject({
        success: true,
        data: { action: "navigate", handoff: { kind: "navigate" } },
      });
      expect(started).toEqual([]);
    }
    const refusing = new MapsService(undefined, store([]));
    const { device, started } = phone(true);
    device.available = async () => {
      throw new MapsError("The phone is not available.", {
        code: "MAPS_DEVICE_UNAVAILABLE",
      });
    };
    refusing.registerDeviceNavigation(device);
    expect(await run(refusing, destination)).toMatchObject({
      success: true,
      data: { handoff: { kind: "navigate" } },
    });
    expect(started).toEqual([]);
    expect(
      await run(new MapsService(undefined, store([])), destination),
    ).toMatchObject({ success: true, data: { handoff: { kind: "navigate" } } });
  });

  it("marks the phone's waiting states as waiting on the user", async () => {
    const service = new MapsService(undefined, store([]));
    const { device } = phone(true);
    device.start = async () => ({ state: "awaiting-location" });
    service.registerDeviceNavigation(device);
    const result = await mapsNavigationAction.handler?.(
      runtimeWith(service),
      message({}),
      undefined,
      {
        parameters: { ...destination, action: "start" },
      } as unknown as HandlerOptions,
    );
    expect(result).toMatchObject({
      success: false,
      data: { awaitingUserInput: true, reason: "device_location" },
    });
  });
});

describe("forms ask for names, not ids", () => {
  const hit = (n: number, name: string): PlaceRef => ({
    provider: "stub",
    providerPlaceId: `H${n}`,
    name,
    coordinates: { latitude: 43.73 + n / 100, longitude: 7.42 },
    formattedAddress: `${n} Quai, Monaco`,
    categories: [],
  });
  function searching(places: PlaceRef[]) {
    const service = new MapsService(undefined, store([]));
    service.registerAdapter({
      ...adapter(null),
      searchPlaces: async () => ({ places, nextCursor: null }),
    } as MapsProviderAdapter);
    return service;
  }

  it("labels route fields by name or address", async () => {
    const result = await run(searching([]), { action: "route" });
    const fields =
      (
        result?.data as
          | { uiRequest?: { fields: { label: string }[] } }
          | undefined
      )?.uiRequest?.fields ?? [];
    expect(fields.map((field) => field.label)).toEqual([
      "Starting place (name or address)",
      "Destination (name or address)",
      "Travel mode",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/\bID\b/);
  });

  it("plans the route from a single match", async () => {
    const result = await run(searching([hit(1, "Casino")]), {
      action: "route",
      originName: "Port",
      originLatitude: 43.7347,
      originLongitude: 7.4206,
      destinationQuery: "Casino",
    });
    expect(result).toMatchObject({
      success: true,
      text: "1.0 km, about 10 min by drive.",
      data: { route: { destination: { name: "Casino" } } },
    });
  });

  it("asks which one when several places match", async () => {
    const result = await run(
      searching([hit(1, "Casino"), hit(2, "Casino Cafe")]),
      { action: "share", placeQuery: "Casino" },
    );
    expect(result).toMatchObject({
      success: false,
      data: {
        reason: "missing_input",
        awaitingUserInput: true,
        missingFields: ["placeQuery"],
      },
    });
    expect(result?.text).toContain("Which one did you mean?");
    expect(result?.userFacingText).toContain("Casino Cafe");
    expect(
      (result?.data as { places?: unknown[] } | undefined)?.places,
    ).toHaveLength(2);
  });
});

describe("error replies are plain", () => {
  it("asks to sign in when no Maps provider is connected", async () => {
    const result = await run(new MapsService(undefined, store([])), {
      action: "place",
      query: "Port",
    });
    expect(result).toMatchObject({
      success: false,
      text: "No maps provider adapter is available.",
      userFacingText: "Sign in to use Maps.",
      data: { error: "MAPS_PROVIDER_UNAVAILABLE" },
    });
  });
});
