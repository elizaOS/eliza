/**
 * "find the nearest pharmacy" on a phone that holds the location permission:
 * the phone reports its last known position with the message
 * (clientDevice.context.location), so the agent searches around it directly.
 * A stale or absent position still hands the search to the phone, and a named
 * search point still wins over the phone's position.
 */
import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/core")>()),
  hasOwnerAccess: async (_runtime: unknown, message: { entityId?: string }) =>
    message?.entityId === OWNER,
}));

import { mapsAction } from "../src/action.js";
import type { MapsProviderAdapter } from "../src/adapter.js";
import { MapsService } from "../src/service.js";
import type { SavedPlaceStore } from "../src/store.js";
import type { PlaceRef } from "../src/types.js";

const OWNER = "00000000-0000-4000-8000-000000000002";
const HERE = { latitude: 37.7749, longitude: -122.4194 };
const FERRY_BUILDING: PlaceRef = {
  provider: "stub",
  providerPlaceId: "ferry",
  name: "Ferry Building",
  coordinates: { latitude: 37.7955, longitude: -122.3937 },
  formattedAddress: "1 Ferry Building, San Francisco, CA",
  categories: [],
};
const pharmacy = (n: number, latitudeOffset: number): PlaceRef => ({
  provider: "stub",
  providerPlaceId: `rx${n}`,
  name: `Pharmacy ${n}`,
  coordinates: {
    latitude: HERE.latitude + latitudeOffset,
    longitude: HERE.longitude,
  },
  formattedAddress: `${n} Mission St, San Francisco, CA`,
  categories: ["pharmacy"],
});

const store: SavedPlaceStore = {
  save: async () => {
    throw new Error("no writes in this test");
  },
  list: async () => [],
  get: async () => null,
};

type Search = { query: string; near?: unknown; rank?: string };

function provider(
  answers: Record<string, PlaceRef[]>,
  searched: Search[],
): MapsService {
  const service = new MapsService(undefined, store);
  service.registerAdapter({
    id: "stub",
    connectionId: "conn_stub_maps_provider_01",
    attribution: "Stub data",
    supportsCrossProviderRoutes: true,
    searchPlaces: async (request: Search) => {
      searched.push(request);
      return { places: answers[request.query] ?? [], nextCursor: null };
    },
    getPlace: async () => null,
  } as unknown as MapsProviderAdapter);
  return service;
}

const message = (text: string, capturedAt: number | undefined) =>
  ({
    id: "00000000-0000-4000-8000-000000000001",
    entityId: OWNER,
    roomId: "00000000-0000-4000-8000-000000000003",
    content: {
      text,
      ...(capturedAt === undefined
        ? {}
        : {
            metadata: {
              clientDevice: {
                context: {
                  view: "home",
                  revision: 1,
                  sensitive: false,
                  location: { ...HERE, accuracyMeters: 9, capturedAt },
                },
              },
            },
          }),
    },
  }) as unknown as Memory;

function place(
  service: MapsService,
  text: string,
  parameters: Record<string, unknown>,
  capturedAt: number | undefined,
) {
  return mapsAction.handler?.(
    { getService: () => service } as unknown as IAgentRuntime,
    message(text, capturedAt),
    undefined,
    { parameters: { action: "place", ...parameters } } as HandlerOptions,
  ) as Promise<ActionResult>;
}

describe("a nearby search with the phone's reported position", () => {
  it("searches around the phone, nearest first, without a locate card", async () => {
    const searched: Search[] = [];
    const result = await place(
      provider({ pharmacy: [pharmacy(2, 0.01), pharmacy(1, 0.001)] }, searched),
      "find the nearest pharmacy",
      { query: "pharmacy", useCurrentLocation: true },
      Date.now() - 60_000,
    );
    expect(searched).toEqual([
      expect.objectContaining({
        query: "pharmacy",
        near: HERE,
        rank: "distance",
      }),
    ]);
    expect(result.data).not.toMatchObject({ reason: "missing_location" });
    expect(result.userFacingText ?? "").not.toContain('"kind":"locate"');
    expect(result.text).toContain("Pharmacy 1");
  });

  it("hands a stale or absent position back to the phone", async () => {
    for (const capturedAt of [Date.now() - 2 * 60 * 60_000, undefined]) {
      const searched: Search[] = [];
      const result = await place(
        provider({}, searched),
        "find the nearest pharmacy",
        { query: "pharmacy", useCurrentLocation: true },
        capturedAt,
      );
      expect(searched).toEqual([]);
      expect(result.data).toMatchObject({ reason: "missing_location" });
    }
  });

  it("keeps a named search point over the phone's position", async () => {
    const searched: Search[] = [];
    await place(
      provider(
        {
          "the Ferry Building": [FERRY_BUILDING],
          pharmacy: [pharmacy(1, 0.02)],
        },
        searched,
      ),
      "pharmacy near the Ferry Building",
      { query: "pharmacy near the Ferry Building", useCurrentLocation: true },
      Date.now(),
    );
    expect(searched.at(-1)).toMatchObject({
      query: "pharmacy",
      near: FERRY_BUILDING.coordinates,
    });
  });
});
