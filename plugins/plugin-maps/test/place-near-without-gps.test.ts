/**
 * "find the nearest pharmacy" on a phone with no location fix (v612,
 * 2026-11-18). The agent never receives the phone's position, so a nearby
 * search hands the query to the phone in a locate card. The reply now also
 * says what to do when the phone cannot get a fix: name a place or area to
 * search near. "pharmacy near the Ferry Building" is that search: it needs no
 * position, so it is searched around the named place instead of waiting for
 * the phone, even when a planner passes only "pharmacy" with
 * useCurrentLocation.
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

import {
  anchoredPlaceQuery,
  mapsAction,
  mapsNavigationAction,
} from "../src/action.js";
import type { MapsProviderAdapter } from "../src/adapter.js";
import {
  isMapsNearbyPlaceRequest,
  isMapsPlaceNearNamedRequest,
} from "../src/plugin.js";
import { MapsService } from "../src/service.js";
import type { SavedPlaceStore } from "../src/store.js";
import type { PlaceRef } from "../src/types.js";

const OWNER = "00000000-0000-4000-8000-000000000002";

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
    latitude: FERRY_BUILDING.coordinates.latitude + latitudeOffset,
    longitude: FERRY_BUILDING.coordinates.longitude,
  },
  formattedAddress: `${n} Market St, San Francisco, CA`,
  categories: ["pharmacy"],
});

const store: SavedPlaceStore = {
  save: async () => {
    throw new Error("no writes in this test");
  },
  list: async () => [],
  get: async () => null,
};

type Search = { query: string; near?: unknown; rank?: string; limit?: number };

/** A provider that answers by query; every request is recorded. */
function provider(
  answers: Record<string, PlaceRef[]>,
  searched: Search[] = [],
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

const runtimeWith = (service: MapsService) =>
  ({ getService: () => service }) as unknown as IAgentRuntime;
const ownerMessage = (text: string) =>
  ({
    id: "00000000-0000-4000-8000-000000000001",
    entityId: OWNER,
    roomId: "00000000-0000-4000-8000-000000000003",
    content: { text },
  }) as unknown as Memory;

function place(
  service: MapsService,
  text: string,
  parameters: Record<string, unknown>,
) {
  return mapsAction.handler?.(
    runtimeWith(service),
    ownerMessage(text),
    undefined,
    { parameters: { action: "place", ...parameters } } as HandlerOptions,
  ) as Promise<ActionResult>;
}

const card = (result: ActionResult | undefined) =>
  JSON.parse(
    /\[MAPSCARD\]\n(.*)\n\[\/MAPSCARD\]/.exec(
      result?.userFacingText ?? "",
    )?.[1] ?? "null",
  );
const prose = (result: ActionResult | undefined) =>
  (result?.userFacingText ?? "").replace(/\n?\[MAPSCARD\][\s\S]*$/, "").trim();

describe("the nearest kind of place when the phone may have no fix", () => {
  it("hands the search to the phone and says what to name instead", async () => {
    const searched: Search[] = [];
    const result = await place(
      provider({}, searched),
      "find the nearest pharmacy",
      { query: "pharmacy", useCurrentLocation: true },
    );
    expect(searched).toEqual([]);
    expect(result).toMatchObject({
      success: false,
      data: { reason: "missing_location", awaitingUserInput: true },
    });
    expect(prose(result)).toBe(
      "I need your precise location to search near you for “pharmacy”. If the phone can't get a location fix, name a place or area to search near instead, such as “pharmacy near the Ferry Building”.",
    );
    expect(result.text).toBe(prose(result));
    // The phone's card keeps its own prompt, which older phones parse.
    expect(card(result)).toEqual({
      kind: "locate",
      intent: "place-near",
      prompt: "I need your precise location to search near you for “pharmacy”.",
      query: "pharmacy",
    });
    expect(prose(result)).not.toMatch(/went wrong/i);
  });

  it("offers a starting place or an area for directions to the nearest one", async () => {
    const result = (await mapsNavigationAction.handler?.(
      runtimeWith(
        (() => {
          const service = provider({});
          service.registerDeviceNavigation({
            available: async () => true,
            select: async () => ({ state: "selected" }),
            start: async () => ({ state: "navigating" }),
            reroute: async () => ({ state: "navigating" }),
            stop: async () => ({ state: "stopped" }),
          });
          return service;
        })(),
      ),
      ownerMessage("directions to the nearest pharmacy"),
      undefined,
      {
        parameters: {
          action: "start",
          placeQuery: "nearest pharmacy",
          useCurrentLocation: true,
        },
      } as HandlerOptions,
    )) as ActionResult;
    expect(prose(result)).toBe(
      "I need your precise location to start the route to nearest pharmacy. If the phone can't get a location fix, tell me where you're starting from, or name a place to search near, such as “pharmacy near the Ferry Building”.",
    );
    expect(card(result)).toMatchObject({
      intent: "route-origin",
      prompt:
        "I need your precise location to start the route to nearest pharmacy.",
    });
  });
});

describe("a kind of place near a named place", () => {
  const answers = {
    "the Ferry Building": [FERRY_BUILDING],
    pharmacy: [pharmacy(2, 0.02), pharmacy(1, 0.005)],
  };

  it.each([
    [
      "the whole phrase as the query",
      { query: "pharmacy near the Ferry Building" },
    ],
    [
      "the whole phrase with useCurrentLocation",
      { query: "pharmacy near the Ferry Building", useCurrentLocation: true },
    ],
    [
      "only the kind, with useCurrentLocation",
      { query: "pharmacy", useCurrentLocation: true },
    ],
  ])(
    "searches around the named place from %s, with no position",
    async (_name, parameters) => {
      const searched: Search[] = [];
      const result = await place(
        provider(answers, searched),
        "find a pharmacy near the Ferry Building",
        parameters,
      );
      expect(searched).toEqual([
        { query: "the Ferry Building", limit: 5 },
        {
          query: "pharmacy",
          near: FERRY_BUILDING.coordinates,
          rank: "distance",
        },
      ]);
      expect(result).toMatchObject({
        success: true,
        data: { status: "found" },
      });
      expect(result.text).toBe(
        [
          "Found 2 places near Ferry Building, nearest first:",
          "Pharmacy 1, 1 Market St, San Francisco, CA (560 m away)",
          "Pharmacy 2, 2 Market St, San Francisco, CA (2.2 km away)",
        ].join("\n"),
      );
      expect(prose(result)).toBe(
        [
          "Near Ferry Building:",
          "Pharmacy 1, 560 m away",
          "Pharmacy 2, 2.2 km away",
        ].join("\n"),
      );
      expect(card(result)).toMatchObject({ kind: "places", query: "pharmacy" });
      expect(card(result)).not.toMatchObject({ kind: "locate" });
    },
  );

  it("says so when the named place is not found", async () => {
    const searched: Search[] = [];
    const result = await place(
      provider({}, searched),
      "pharmacy near Nowhere Plaza",
      {
        query: "pharmacy near Nowhere Plaza",
      },
    );
    expect(searched).toEqual([{ query: "Nowhere Plaza", limit: 5 }]);
    expect(result).toMatchObject({
      success: false,
      userFacingText:
        "I couldn't find “Nowhere Plaza” to search near. Name another place or area to search near.",
      data: { reason: "anchor_not_found", awaitingUserInput: true },
    });
  });

  it("asks which named place when several match, and searches none of them", async () => {
    const other = {
      ...FERRY_BUILDING,
      providerPlaceId: "ferry-oak",
      name: "Ferry Terminal",
      coordinates: { latitude: 37.79, longitude: -122.28 },
      formattedAddress: "Oakland, CA",
    };
    const searched: Search[] = [];
    const result = await place(
      provider({ "the ferry": [FERRY_BUILDING, other] }, searched),
      "pharmacy near the ferry",
      { query: "pharmacy near the ferry" },
    );
    expect(searched).toHaveLength(1);
    expect(result.success).toBe(false);
    expect(result.userFacingText).toContain(
      "Which “the ferry” should I search near?",
    );
    expect(result.userFacingText).toContain("1. Ferry Building");
    expect(result.userFacingText).toContain("2. Ferry Terminal");
  });

  it("is still the phone's search for near me", async () => {
    expect(anchoredPlaceQuery("pharmacy near me")).toBeUndefined();
    expect(anchoredPlaceQuery("pharmacy near here")).toBeUndefined();
    expect(anchoredPlaceQuery("pharmacy nearby")).toBeUndefined();
    expect(anchoredPlaceQuery("nearest pharmacy")).toBeUndefined();
    expect(anchoredPlaceQuery("pharmacy near my location")).toBeUndefined();
    expect(
      anchoredPlaceQuery("find the nearest pharmacy near the Ferry Building"),
    ).toEqual({
      kind: "pharmacy",
      anchor: "the Ferry Building",
    });
    expect(anchoredPlaceQuery("coffee shops close to Union Square?")).toEqual({
      kind: "coffee shops",
      anchor: "Union Square",
    });
    expect(anchoredPlaceQuery("I need a pharmacy near Union Square")).toEqual({
      kind: "pharmacy",
      anchor: "Union Square",
    });
  });

  it.each([
    // A business whose name says "by" is searched by its name.
    "Café by the Sea",
    "Hotel by the Bay",
    "Stand By Me Cafe",
    // A travel mode or a time is not a place to search around.
    "find the nearest pharmacy by car",
    "find a pharmacy open around 9pm",
    "find a pharmacy open around midnight near me",
    "pharmacy close to where I am right now",
    // The owner's own places are not a provider search for the word.
    "find a pharmacy near home",
    "coffee next to my office",
    // Things on the phone, not kinds of places.
    "photos near the Ferry Building",
  ])("names no place to search around in %s", (query) => {
    expect(anchoredPlaceQuery(query)).toBeUndefined();
  });
});

describe("phone chat routes a search near a named place to Maps", () => {
  it.each([
    "pharmacy near the Ferry Building",
    "Pharmacy near the Ferry Building",
    "find a pharmacy near the Ferry Building",
    "find a pharmacy near the ferry building",
    "is there a pharmacy near Union Square?",
    "where is the closest pharmacy near the Ferry Building",
    "show me coffee shops close to Dolores Park",
    "Parking near the Ferry Building",
    "Hotels near SFO",
  ])("%s", (text) => {
    expect(isMapsPlaceNearNamedRequest(text)).toBe(true);
  });

  it.each([
    "find a pharmacy near me",
    "pharmacy near here",
    "find a pharmacy nearby",
    "stay near the door",
    "remind me to call mom near 5pm",
    "find my keys near the couch",
    "find the bug near that line",
    "put the lamp near the window",
    // Photos, Messages, Notes and Calendar searches.
    "show photos near the Eiffel Tower",
    "show me photos near Golden Gate Park",
    "find emails near Christmas",
    "search for messages around Thanksgiving",
    "Show notes near the end",
    "find files near the top",
    "show the bug near line 40",
    // A time, not a place.
    "find a pharmacy open around midnight",
    "get coffee around noon",
    // Weather, traffic and news around a place, and a price.
    "what's the weather near Austin",
    "weather near Austin",
    "traffic near the Bay Bridge",
    "news around Austin",
    "find a TV around 500 dollars",
    "find a hotel around 150 a night",
    "find a hotel around 100 euros a night",
    // A verb or a question, not a kind of place.
    "Meet John near the Ferry Building",
    "Text Sarah around Union Square",
    "what is near the Ferry Building",
  ])("leaves %s to other routes", (text) => {
    expect(isMapsPlaceNearNamedRequest(text)).toBe(false);
  });

  it("keeps the nearest search around the phone on its own route", () => {
    expect(isMapsNearbyPlaceRequest("find the nearest pharmacy")).toBe(true);
    expect(isMapsPlaceNearNamedRequest("find the nearest pharmacy")).toBe(
      false,
    );
  });
});
