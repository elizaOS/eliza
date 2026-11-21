/**
 * Maps review findings (v612, 2026-11-20), each reproduced before its fix:
 *
 * 1. "find coffee near me please" searched a place named "me please".
 * 2. The results card for "pharmacy near the Ferry Building" did not carry the
 *    Ferry Building, so a surface searching again searched somewhere else.
 * 3. "here" and "my current location" were searched as place names when the
 *    planner left useCurrentLocation out, and a lone unrelated result was used.
 * 4. A picked route destination was lost while the origin was still missing.
 * 5. The phone's allowance and balance refusals read as "Maps is busy" and
 *    "Sign in again".
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
  isOwnPositionQuery,
  mapsAction,
  mapsNavigationAction,
  nearbyPlaceKind,
} from "../src/action.js";
import type { MapsProviderAdapter } from "../src/adapter.js";
import { MapsFailure } from "../src/client/contracts.js";
import { deviceNavigationFailure } from "../src/client/device-navigation.js";
import { MapsError, type MapsErrorCode } from "../src/errors.js";
import { dominantPlace } from "../src/place-choice.js";
import { MapsService } from "../src/service.js";
import type { SavedPlaceStore } from "../src/store.js";
import type { PlaceRef } from "../src/types.js";

const OWNER = "00000000-0000-4000-8000-000000000002";

const store: SavedPlaceStore = {
  save: async () => {
    throw new Error("no writes in this test");
  },
  list: async () => [],
  get: async () => null,
};

type Search = { query: string; near?: unknown; rank?: string; limit?: number };
type Started = { destination: PlaceRef };

const P = (
  id: string,
  name: string,
  latitude: number,
  longitude: number,
  formattedAddress?: string,
): PlaceRef => ({
  provider: "stub",
  providerPlaceId: id,
  name,
  coordinates: { latitude, longitude },
  ...(formattedAddress ? { formattedAddress } : {}),
  categories: [],
});

const FERRY = P(
  "ferry",
  "Ferry Building",
  37.7955,
  -122.3937,
  "1 Ferry Building, San Francisco, CA",
);
const COIT = P(
  "coit",
  "Coit Tower",
  37.8024,
  -122.4058,
  "1 Telegraph Hill Blvd, San Francisco, CA",
);
const HERE_COFFEE = P(
  "here",
  "Here Coffee Roasters",
  47.6,
  -122.33,
  "100 Pine St, Seattle, WA",
);

function provider(
  answer: (query: string) => PlaceRef[],
  searched: Search[] = [],
  started: Started[] = [],
  routes: unknown[] = [],
): MapsService {
  const service = new MapsService(undefined, store);
  service.registerAdapter({
    id: "stub",
    connectionId: "conn_stub_maps_provider_01",
    attribution: "Stub data",
    supportsCrossProviderRoutes: true,
    searchPlaces: async (request: Search) => {
      searched.push(request);
      return { places: answer(request.query), nextCursor: null };
    },
    getPlace: async () => null,
    planRoute: async (request: {
      origin: PlaceRef;
      destination: PlaceRef;
      travelMode: string;
    }) => {
      routes.push(request);
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
  } as unknown as MapsProviderAdapter);
  service.registerDeviceNavigation({
    available: async () => true,
    select: async () => ({ state: "selected" }),
    start: async (request: Started) => {
      started.push(request);
      return {
        state: "awaiting-confirmation",
        placeName: request.destination.name,
      };
    },
    reroute: async () => ({ state: "navigating" }),
    stop: async () => ({ state: "stopped" }),
  } as never);
  return service;
}

const runtimeWith = (service: MapsService) =>
  ({ getService: () => service }) as unknown as IAgentRuntime;
let turn = 0;
const ownerMessage = (text: string) =>
  ({
    id: `00000000-0000-4000-8000-0000000005${String(turn++).padStart(2, "0")}`,
    entityId: OWNER,
    roomId: "00000000-0000-4000-8000-000000000003",
    content: { text },
  }) as unknown as Memory;

function maps(
  service: MapsService,
  text: string,
  parameters: Record<string, unknown>,
) {
  return mapsAction.handler?.(
    runtimeWith(service),
    ownerMessage(text),
    undefined,
    { parameters } as HandlerOptions,
  ) as Promise<ActionResult>;
}
function navigation(
  service: MapsService,
  text: string,
  parameters: Record<string, unknown>,
) {
  return mapsNavigationAction.handler?.(
    runtimeWith(service),
    ownerMessage(text),
    undefined,
    { parameters: { action: "start", ...parameters } } as HandlerOptions,
  ) as Promise<ActionResult>;
}

const card = (result: ActionResult | undefined) =>
  JSON.parse(
    /\[MAPSCARD\]\n(.*)\n\[\/MAPSCARD\]/.exec(
      result?.userFacingText ?? "",
    )?.[1] ?? "null",
  );
const prose = (result: ActionResult | undefined) =>
  (result?.userFacingText ?? "")
    .replace(/\n?\[(?:MAPSCARD|FORM)\][\s\S]*$/, "")
    .trim();

describe("1. near me with trailing words", () => {
  it.each([
    "find coffee near me please",
    "coffee shops near me, thanks",
    "is there a pharmacy near me that's open now?",
    "pharmacy near me open now",
    "find a gas station near me right now",
    "restaurants near me for dinner",
    "coffee near here please",
    "is there a pharmacy near me please?",
  ])("%s names no place to search around", (text) => {
    expect(anchoredPlaceQuery(text)).toBeUndefined();
    expect(nearbyPlaceKind(text)).toBeDefined();
  });

  it.each([
    ["find a pharmacy near the Ferry Building please", "the Ferry Building"],
    ["pharmacy near the Ferry Building, thanks", "the Ferry Building"],
    ["coffee near Union Square right now", "Union Square"],
    // A named place that starts with an own-position word is still a place.
    ["coffee near Here Coffee Roasters", "Here Coffee Roasters"],
  ])("%s keeps the named place %s without courtesy words", (text, anchor) => {
    expect(anchoredPlaceQuery(text)?.anchor).toBe(anchor);
  });

  it.each([
    [
      "find coffee near me please",
      { query: "coffee", useCurrentLocation: true },
    ],
    [
      "find coffee near me please",
      { query: "coffee near me please", useCurrentLocation: true },
    ],
    [
      "coffee shops near me, thanks",
      { query: "coffee shops", useCurrentLocation: true },
    ],
    [
      "find a gas station near me right now",
      { query: "gas station", useCurrentLocation: true },
    ],
    [
      "is there a pharmacy near me that's open now?",
      { query: "pharmacy", useCurrentLocation: true },
    ],
  ])("%s with %j asks the phone for its position", async (text, params) => {
    const searched: Search[] = [];
    const result = await maps(
      provider(() => [], searched),
      text,
      {
        action: "place",
        ...params,
      },
    );
    expect(searched).toEqual([]);
    expect(result.data).toMatchObject({ reason: "missing_location" });
    expect(card(result)).toMatchObject({
      kind: "locate",
      intent: "place-near",
      query: params.query.replace(/ near me please$/, ""),
    });
  });
});

describe("2. the results card names the place it searched around", () => {
  it("carries the anchor so a surface can search around it again", async () => {
    const result = await maps(
      provider((query) =>
        query === "the Ferry Building"
          ? [FERRY]
          : query === "pharmacy"
            ? [P("rx1", "Pharmacy 1", 37.8, -122.3937, "1 Market St")]
            : [],
      ),
      "pharmacy near the Ferry Building",
      { action: "place", query: "pharmacy near the Ferry Building" },
    );
    expect(card(result)).toMatchObject({
      kind: "places",
      query: "pharmacy",
      near: {
        name: "Ferry Building",
        latitude: FERRY.coordinates.latitude,
        longitude: FERRY.coordinates.longitude,
      },
    });
  });

  it("adds no search point to a plain search", async () => {
    const result = await maps(
      provider(() => [COIT, { ...COIT, providerPlaceId: "coit2" }]),
      "coit tower",
      { action: "place", query: "Coit Tower" },
    );
    expect(card(result).near).toBeUndefined();
  });
});

describe("3. own-position words when the planner leaves the flag out", () => {
  it.each([
    "here",
    "my current location",
    "my location",
    "where I am",
    "current location",
    "right here",
  ])("%s is the owner's position", (words) => {
    expect(isOwnPositionQuery(words)).toBe(true);
  });

  it.each(["Here Coffee Roasters", "home", "my office", "Chicago"])(
    "%s is a place",
    (words) => {
      expect(isOwnPositionQuery(words)).toBe(false);
    },
  );

  it.each(["here", "my current location"])(
    "a route from %s starts at the phone, not at a business named Here",
    async (originQuery) => {
      const searched: Search[] = [];
      const routes: unknown[] = [];
      const result = await maps(
        provider(
          (query) => (query === "Coit Tower" ? [COIT] : [HERE_COFFEE]),
          searched,
          [],
          routes,
        ),
        "how far is Coit Tower from here",
        { action: "route", originQuery, destinationQuery: "Coit Tower" },
      );
      expect(searched.map((search) => search.query)).toEqual(["Coit Tower"]);
      expect(routes).toEqual([]);
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ reason: "missing_location" });
      expect(card(result)).toMatchObject({
        kind: "locate",
        intent: "route-origin",
        destination: { name: "Coit Tower" },
      });
    },
  );

  it("a nearest destination from here goes to the phone unsearched", async () => {
    const searched: Search[] = [];
    const result = await maps(
      provider(() => [P("rx", "Nearest Pharmacy Ltd", 51.5, -0.12)], searched),
      "directions from here to the nearest pharmacy",
      {
        action: "route",
        originQuery: "here",
        destinationQuery: "the nearest pharmacy",
      },
    );
    expect(searched).toEqual([]);
    expect(card(result)).toMatchObject({
      kind: "locate",
      intent: "route-origin",
      query: "the nearest pharmacy",
    });
  });

  it.each([
    ["the nearest pharmacy to the Ferry Building"],
    ["closest gas station to SFO"],
    ["nearest coffee in the Mission"],
  ])("%s names its own search point", (query) => {
    expect(nearbyPlaceKind(query)).toBeUndefined();
  });

  it.each([
    ["the nearest pharmacy to me", "pharmacy"],
    ["closest coffee to here please", "coffee"],
    ["the nearest pharmacy near me", "pharmacy"],
  ])("%s is about the owner's position", (query, kind) => {
    expect(nearbyPlaceKind(query)).toBe(kind);
  });

  it("navigation to the nearest place to a named landmark is not held for the phone's position", async () => {
    const started: Started[] = [];
    const rx = P("rx", "Ferry Pharmacy", 37.795, -122.394, "2 Ferry Plaza");
    const result = await navigation(
      provider(() => [rx], [], started),
      "take me to the nearest pharmacy to the Ferry Building",
      { placeQuery: "the nearest pharmacy to the Ferry Building" },
    );
    expect(card(result)?.kind).not.toBe("locate");
  });

  it.each([
    ["coffee near me", "coffee"],
    ["nearest pharmacy", "pharmacy"],
    ["sushi nearby", "sushi"],
  ])("a place search for %s asks for the position", async (query, kind) => {
    const searched: Search[] = [];
    const result = await maps(
      provider(() => [HERE_COFFEE], searched),
      query,
      {
        action: "place",
        query,
      },
    );
    expect(searched).toEqual([]);
    expect(result.data).toMatchObject({ reason: "missing_location" });
    expect(card(result)).toMatchObject({ kind: "locate", query: kind });
  });

  it("navigation to the nearest pharmacy waits for the phone's position", async () => {
    const searched: Search[] = [];
    const started: Started[] = [];
    const result = await navigation(
      provider(
        () => [P("rx", "Nearest Pharmacy Ltd", 51.5, -0.12)],
        searched,
        started,
      ),
      "take me to the nearest pharmacy",
      { placeQuery: "the nearest pharmacy" },
    );
    expect(searched).toEqual([]);
    expect(started).toEqual([]);
    expect(card(result)).toMatchObject({
      kind: "locate",
      intent: "route-origin",
      query: "the nearest pharmacy",
    });
  });

  it("a lone result is used even under the provider's own name", () => {
    // A provider answers "SFO" or a typo with the place's full name.
    const sfo = P(
      "sfo",
      "San Francisco International Airport",
      37.6213,
      -122.379,
      "San Francisco, CA 94128, USA",
    );
    expect(dominantPlace("SFO", [sfo])).toBe(sfo);
    expect(dominantPlace("San Fransisco airport", [sfo])).toBe(sfo);
    expect(dominantPlace("Coit Tower", [COIT])).toBe(COIT);
  });

  it.each([
    ["SFO", "SFO"],
    ["my current location", undefined],
  ])("a route to a lone result for %s", async (destinationQuery, routed) => {
    const sfo = P(
      "sfo",
      "San Francisco International Airport",
      37.6213,
      -122.379,
      "San Francisco, CA 94128, USA",
    );
    const routes: { destination: PlaceRef }[] = [];
    const result = await maps(
      provider(
        (query) =>
          query === "Coit Tower"
            ? [COIT]
            : query === "SFO"
              ? [sfo]
              : [HERE_COFFEE],
        [],
        [],
        routes,
      ),
      `directions from Coit Tower to ${destinationQuery}`,
      { action: "route", originQuery: "Coit Tower", destinationQuery },
    );
    if (routed) {
      expect(routes.map((route) => route.destination.name)).toEqual([sfo.name]);
    } else {
      // "my current location" is never a business named "Here".
      expect(routes).toEqual([]);
      expect(result.data).toMatchObject({ reason: "missing_input" });
    }
  });

  it("a route to the nearest pharmacy with no origin starts from the phone", async () => {
    const searched: Search[] = [];
    const routes: unknown[] = [];
    const result = await maps(
      provider(
        () => [P("rx", "Nearest Pharmacy Ltd", 51.5, -0.12)],
        searched,
        [],
        routes,
      ),
      "how far is the nearest pharmacy",
      { action: "route", destinationQuery: "the nearest pharmacy" },
    );
    expect(searched).toEqual([]);
    expect(routes).toEqual([]);
    expect(card(result)).toMatchObject({ kind: "locate" });
  });
});

describe("4. a picked destination survives the missing origin", () => {
  const spr = (n: number, latitude: number, longitude: number, at: string) =>
    P(`s${n}`, "Springfield", latitude, longitude, at);
  const answers: Record<string, PlaceRef[]> = {
    Springfield: [
      spr(1, 39.78, -89.65, "Springfield, IL, USA"),
      spr(2, 37.2, -93.29, "Springfield, MO, USA"),
      spr(3, 42.1, -72.59, "Springfield, MA, USA"),
    ],
    Chicago: [P("chi", "Chicago", 41.88, -87.63, "Chicago, IL, USA")],
  };

  it.each([
    ["only the origin", { originQuery: "Chicago" }],
    [
      "the origin and the same destination again",
      { originQuery: "Chicago", destinationQuery: "Springfield" },
    ],
  ])("plans the route when the next turn names %s", async (_name, next) => {
    const routes: Array<{ origin: PlaceRef; destination: PlaceRef }> = [];
    const service = provider((query) => answers[query] ?? [], [], [], routes);
    const run = (text: string, parameters: Record<string, unknown>) =>
      maps(service, text, { action: "route", ...parameters });
    const asked = await run("how far is it to Springfield", {
      destinationQuery: "Springfield",
    });
    expect(prose(asked)).toContain("Which “Springfield”");
    const picked = await run("the second one", {});
    expect(prose(picked)).toBe(
      "Going to Springfield, MO, USA. I still need a starting place.",
    );
    const planned = await run("from Chicago", next);
    expect(planned.success).toBe(true);
    expect(routes.map((route) => route.destination.formattedAddress)).toEqual([
      "Springfield, MO, USA",
    ]);
    expect(routes[0]?.origin.name).toBe("Chicago");
  });

  it("a new destination replaces the kept one", async () => {
    const routes: Array<{ origin: PlaceRef; destination: PlaceRef }> = [];
    const service = provider(
      (query) => (query === "Coit Tower" ? [COIT] : (answers[query] ?? [])),
      [],
      [],
      routes,
    );
    const run = (text: string, parameters: Record<string, unknown>) =>
      maps(service, text, { action: "route", ...parameters });
    await run("how far is it to Springfield", {
      destinationQuery: "Springfield",
    });
    await run("the first one", {});
    await run("from Chicago to Coit Tower", {
      originQuery: "Chicago",
      destinationQuery: "Coit Tower",
    });
    expect(routes.map((route) => route.destination.name)).toEqual([
      "Coit Tower",
    ]);
  });

  it("a route from the owner's position does not reuse a kept origin", async () => {
    const routes: Array<{ origin: PlaceRef; destination: PlaceRef }> = [];
    const service = provider(
      (query) => (query === "Coit Tower" ? [COIT] : (answers[query] ?? [])),
      [],
      [],
      routes,
    );
    const run = (text: string, parameters: Record<string, unknown>) =>
      maps(service, text, { action: "route", ...parameters });
    const asked = await run("directions from Chicago", {
      originQuery: "Chicago",
    });
    expect(prose(asked)).toBe("I still need a destination.");
    const fromHere = await run("directions to Coit Tower from where I am", {
      destinationQuery: "Coit Tower",
      useCurrentLocation: true,
    });
    expect(routes).toEqual([]);
    expect(fromHere.data).toMatchObject({ reason: "missing_location" });
    expect(card(fromHere)).toMatchObject({
      kind: "locate",
      intent: "route-origin",
      destination: { name: "Coit Tower" },
    });
  });

  it("a later unrelated turn does not reuse the kept endpoint", async () => {
    const routes: Array<{ origin: PlaceRef; destination: PlaceRef }> = [];
    const service = provider((query) => answers[query] ?? [], [], [], routes);
    const run = (text: string, parameters: Record<string, unknown>) =>
      maps(service, text, { action: "route", ...parameters });
    await run("how far is it to Springfield", {
      destinationQuery: "Springfield",
    });
    await run("the second one", {});
    // The owner moved on; a turn later the kept endpoint is gone.
    service.placeChoices.get(ownerMessage("call mom"));
    const later = await run("from Chicago", { originQuery: "Chicago" });
    expect(later.success).toBe(false);
    expect(routes).toEqual([]);
  });
});

describe("5. phone refusals keep their meaning in chat", () => {
  const COIT_ONLY = () => [COIT];
  it.each([
    [
      "rate-limited",
      "You have used your Maps allowance for this period. It resets in 12 days.",
      "MAPS_BUDGET_EXHAUSTED",
      "You've used your Maps requests for now.",
      false,
    ],
    [
      "rate-limited",
      "Maps request limit reached. Try again in 40 seconds.",
      "MAPS_RATE_LIMITED",
      "Maps is busy. Try again in a moment.",
      true,
    ],
    [
      "unauthorized",
      "Add balance or choose a plan to use Maps.",
      "MAPS_NOT_ENTITLED",
      "Add balance or choose a plan to use Maps.",
      false,
    ],
    [
      "unauthorized",
      "Cloud refused this Maps request.",
      "MAPS_PROVIDER_REJECTED",
      "Cloud refused this Maps request.",
      false,
    ],
    [
      "unauthorized",
      "Maps needs an active Cloud subscription.",
      "MAPS_NOT_ENTITLED",
      "Maps needs an active subscription.",
      false,
    ],
    [
      "unauthorized",
      "Sign in to Cloud to use Maps.",
      "MAPS_AUTH_EXPIRED",
      "Sign in again to use Maps.",
      false,
    ],
  ] as const)(
    "%s %s",
    async (failure, message, code, userFacingText, retryable) => {
      const phone = deviceNavigationFailure(new MapsFailure(failure, message));
      expect(phone.code).toBe(code);
      const service = provider(COIT_ONLY);
      // The agent host's relay rebuilds the phone's refusal as a MapsError.
      service.registerDeviceNavigation({
        available: async () => true,
        select: async () => ({ state: "selected" }),
        start: async () => {
          throw new MapsError(phone.message, {
            code: phone.code as MapsErrorCode,
          });
        },
        reroute: async () => ({ state: "navigating" }),
        stop: async () => ({ state: "stopped" }),
      } as never);
      const result = await navigation(service, "directions to Coit Tower", {
        placeQuery: "Coit Tower",
      });
      expect(result.success).toBe(false);
      expect(result.userFacingText).toBe(userFacingText);
      expect(result.data).toMatchObject({ retryable });
    },
  );
});
