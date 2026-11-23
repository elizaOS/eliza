/**
 * "where am I" on a phone whose only position is a rough network or
 * address-based estimate (accuracy in kilometers): the reverse lookup of that
 * point's center names one building that is not where the owner is, so the
 * answer names only the area. A precise fix still names the place.
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

import { addressArea, mapsAction } from "../src/action.js";
import type { MapsProviderAdapter } from "../src/adapter.js";
import { MapsService } from "../src/service.js";
import type { SavedPlaceStore } from "../src/store.js";
import type { PlaceRef } from "../src/types.js";

const OWNER = "00000000-0000-4000-8000-000000000002";
const CENTER = { latitude: 40.7128, longitude: -74.006 };
const BUILDING: PlaceRef = {
  provider: "stub",
  providerPlaceId: "sun",
  name: "The Sun Building",
  coordinates: CENTER,
  formattedAddress: "278 W Broadway, New York, NY 10006, USA",
  categories: [],
};
const store: SavedPlaceStore = {
  save: async () => {
    throw new Error("no writes in this test");
  },
  list: async () => [],
  get: async () => null,
};

function service(answer: PlaceRef | null): MapsService {
  const maps = new MapsService(undefined, store);
  maps.registerAdapter({
    id: "stub",
    connectionId: "conn_stub_maps_provider_01",
    attribution: "Stub data",
    supportsCrossProviderRoutes: true,
    searchPlaces: async () => ({ places: [], nextCursor: null }),
    getPlace: async () => null,
    reverseGeocode: async () => answer,
  } as unknown as MapsProviderAdapter);
  return maps;
}

function whereAmI(
  maps: MapsService,
  accuracyMeters: number,
  point: { latitude: number; longitude: number } = CENTER,
) {
  const message = {
    id: "00000000-0000-4000-8000-000000000001",
    entityId: OWNER,
    roomId: "00000000-0000-4000-8000-000000000003",
    content: {
      text: "where am I right now?",
      metadata: {
        clientDevice: {
          context: {
            view: "home",
            revision: 1,
            sensitive: false,
            location: {
              ...CENTER,
              accuracyMeters,
              capturedAt: Date.now() - 60_000,
            },
          },
        },
      },
    },
  } as unknown as Memory;
  return mapsAction.handler?.(
    { getService: () => maps } as unknown as IAgentRuntime,
    message,
    undefined,
    { parameters: { action: "place", ...point } } as HandlerOptions,
  ) as Promise<ActionResult>;
}

describe("where am I from a rough phone position", () => {
  it("names only the area, without a building or a place card", async () => {
    const result = await whereAmI(service(BUILDING), 25_000);
    expect(result.userFacingText).toBe(
      "Your phone's position is approximate (within about 25 km): somewhere around New York, NY, USA.",
    );
    expect(result.text).not.toContain("Sun Building");
    expect(result.text).not.toContain("Broadway");
    expect(result.data).toMatchObject({
      status: "approximate",
      accuracyMeters: 25_000,
      area: "New York, NY, USA",
      place: null,
    });
  });

  it("says so when no area is known at a rough position", async () => {
    const result = await whereAmI(service(null), 1_500);
    expect(result.userFacingText).toBe(
      "Your phone's position is approximate (within about 1.5 km), and no area is known there.",
    );
    expect(result.data).toMatchObject({ status: "empty", place: null });
  });

  it("still names the place for a precise fix", async () => {
    const result = await whereAmI(service(BUILDING), 12);
    expect(result.userFacingText).toContain(
      "The Sun Building — 278 W Broadway",
    );
    expect(result.data).toMatchObject({ status: "found" });
  });

  it("names the place at other coordinates the owner asked about", async () => {
    const elsewhere = { latitude: 40.7484, longitude: -73.9857 };
    const result = await whereAmI(service(BUILDING), 25_000, elsewhere);
    expect(result.data).toMatchObject({ status: "found" });
  });

  it("keeps the area segments of an address", () => {
    expect(addressArea("278 W Broadway, New York, NY 10006, USA")).toBe(
      "New York, NY, USA",
    );
    expect(addressArea("Unter den Linden 77, 10117 Berlin, Germany")).toBe(
      "Berlin, Germany",
    );
    expect(addressArea("Paris, France")).toBe("Paris, France");
    expect(addressArea("Times Square, Manhattan, New York, NY, USA")).toBe(
      "New York, NY, USA",
    );
    expect(
      addressArea(
        "The Sun Building, 280, Broadway, Civic Center, Manhattan, New York County, City of New York, New York, 10007, United States",
      ),
    ).toBe("City of New York, New York, United States");
    expect(
      addressArea("12, Main Street, Smallville, Kansas, United States"),
    ).toBe("Smallville, Kansas, United States");
    expect(addressArea("Iceland")).toBe("Iceland");
    expect(addressArea(undefined)).toBeUndefined();
  });
});
