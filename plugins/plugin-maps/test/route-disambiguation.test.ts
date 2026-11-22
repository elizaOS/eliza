/**
 * "directions from the Ferry Building to Golden Gate Park" on the phone (v610,
 * Alpha develop 79b6d64a5eb): MAPS_ROUTE asked "Which one did you mean?" for
 * five Ferry Building results, then again for Golden Gate Park, and the second
 * "the first one" got a prose reply with no route. These replays use the real
 * Cloud adapter, MapsService and MAPS action against a stub Cloud that answers
 * with the `/api/v1/maps` wire shapes Cloud's Google provider returns.
 */
import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { mapsAction } from "../src/action.js";
import { ElizaCloudMapsAdapter } from "../src/cloud-adapter.js";
import {
  choiceIndex,
  dominantPlace,
  PLACE_CHOICE_TTL_MS,
  PlaceChoices,
} from "../src/place-choice.js";
import { MapsService } from "../src/service.js";
import type { SavedPlaceStore } from "../src/store.js";
import type { PlaceRef } from "../src/types.js";

const PROVIDER = "eliza-cloud-google";
const ATTRIBUTION = "Google Maps";
const COVERAGE = {
  providerId: PROVIDER,
  attribution: ATTRIBUTION,
  regions: [{ id: "us", name: "United States", bounds: [-125, 24, -66, 50] }],
  capabilities: {
    modes: ["drive", "walk", "bicycle", "transit"],
    reverseGeocode: true,
    distanceRank: true,
  },
};

type Point = { latitude: number; longitude: number };
const place = (id: string, name: string, address: string, at: Point) => ({
  providerId: PROVIDER,
  id,
  name,
  coordinate: at,
  address,
  attribution: ATTRIBUTION,
  fetchedAt: 1_763_400_000_000,
});

const FERRY_BUILDING = { latitude: 37.7955, longitude: -122.3937 };
const GOLDEN_GATE_PARK = { latitude: 37.7694, longitude: -122.4862 };
/**
 * Five results for "Ferry Building" written to look like Google's: the
 * building and parts of it. They are not captured from the phone.
 */
const FERRY_RESULTS = [
  place(
    "ChIJWTGPjmaAhYARxz6l1hOj92w",
    "Ferry Building",
    "1 Ferry Building, San Francisco, CA 94111, USA",
    FERRY_BUILDING,
  ),
  place(
    "ChIJ_ferry_marketplace_0001",
    "Ferry Building Marketplace",
    "1 Ferry Building #50, San Francisco, CA 94111, USA",
    { latitude: 37.7956, longitude: -122.3934 },
  ),
  place(
    "ChIJ_ferry_plaza_market_01",
    "Ferry Plaza Farmers Market",
    "1 Ferry Building, San Francisco, CA 94111, USA",
    { latitude: 37.7951, longitude: -122.3939 },
  ),
  place(
    "ChIJ_ferry_clock_tower_001",
    "Ferry Building Clock Tower",
    "The Embarcadero, San Francisco, CA 94111, USA",
    { latitude: 37.7955, longitude: -122.3935 },
  ),
  place(
    "ChIJ_sf_ferry_terminal_001",
    "San Francisco Ferry Terminal",
    "Pier 1/2, San Francisco, CA 94111, USA",
    { latitude: 37.7942, longitude: -122.3929 },
  ),
];
/** "Golden Gate Park": the park, then places inside it, kilometres apart. */
const PARK_RESULTS = [
  place(
    "ChIJY_dFYHKHhYARMKc772iLvnE",
    "Golden Gate Park",
    "San Francisco, CA, USA",
    GOLDEN_GATE_PARK,
  ),
  place(
    "ChIJ_ggp_japanese_tea_0001",
    "Japanese Tea Garden",
    "75 Hagiwara Tea Garden Dr, San Francisco, CA 94118, USA",
    { latitude: 37.7702, longitude: -122.4703 },
  ),
  place(
    "ChIJ_ggp_golf_course_00001",
    "Golden Gate Park Golf Course",
    "970 47th Ave, San Francisco, CA 94121, USA",
    { latitude: 37.7684, longitude: -122.5065 },
  ),
  place(
    "ChIJ_ggp_conservatory_0001",
    "Conservatory of Flowers",
    "100 John F Kennedy Dr, San Francisco, CA 94118, USA",
    { latitude: 37.7716, longitude: -122.4602 },
  ),
  place(
    "ChIJ_ggp_panhandle_0000001",
    "The Panhandle",
    "Oak St & Fell St, San Francisco, CA 94117, USA",
    { latitude: 37.7724, longitude: -122.443 },
  ),
];
/**
 * "Golden Gate Park, San Francisco" as Cloud Maps answered it on the owner's
 * Pixel (v612, 2026-11-18): the park, then the neighbourhood Google also names
 * "Golden Gate Park", 1.4 km apart. Neither is at a street address.
 */
const PARK_AND_NEIGHBOURHOOD = [
  place(
    "ChIJY_dFYHKHhYARMKc772iLvnE",
    "Golden Gate Park",
    "San Francisco, CA, USA",
    { latitude: 37.7689203, longitude: -122.482977 },
  ),
  place(
    "ChIJ4zIqV3KHhYARwAuc1mF2k4c",
    "Golden Gate Park",
    "Golden Gate Park, San Francisco, CA, USA",
    { latitude: 37.7680222, longitude: -122.46700960000001 },
  ),
];
/** A chain: every result is a Starbucks, blocks apart. */
const STARBUCKS_RESULTS = [
  place(
    "ChIJ_starbucks_market_0001",
    "Starbucks",
    "1 Market St, San Francisco, CA 94105, USA",
    { latitude: 37.7941, longitude: -122.3951 },
  ),
  place(
    "ChIJ_starbucks_union_sq_01",
    "Starbucks",
    "201 Powell St, San Francisco, CA 94102, USA",
    { latitude: 37.7873, longitude: -122.4082 },
  ),
  place(
    "ChIJ_starbucks_mission_001",
    "Starbucks",
    "2675 Mission St, San Francisco, CA 94110, USA",
    { latitude: 37.7542, longitude: -122.4188 },
  ),
];
const PHILZ_RESULTS = [
  place(
    "ChIJ_philz_front_st_000001",
    "Philz Coffee",
    "5 Embarcadero Center, San Francisco, CA 94111, USA",
    { latitude: 37.7951, longitude: -122.3966 },
  ),
  place(
    "ChIJ_philz_24th_st_000001",
    "Philz Coffee",
    "3101 24th St, San Francisco, CA 94110, USA",
    { latitude: 37.7525, longitude: -122.4148 },
  ),
];

const CHICAGO = { latitude: 41.8819, longitude: -87.6278 };
const CHICAGO_UNION_STATION = place(
  "union-station-chicago",
  "Union Station",
  "225 S Canal St, Chicago, IL 60606, USA",
  { latitude: 41.8787, longitude: -87.6403 },
);
const WASHINGTON_UNION_STATION = place(
  "union-station-washington",
  "Union Station",
  "50 Massachusetts Ave NE, Washington, DC 20002, USA",
  { latitude: 38.8971, longitude: -77.0064 },
);

const SEARCHES: Record<string, ReturnType<typeof place>[]> = {
  "the ferry building": FERRY_RESULTS,
  "ferry building": FERRY_RESULTS,
  "golden gate park": PARK_RESULTS,
  "golden gate park, san francisco": PARK_AND_NEIGHBOURHOOD,
  "golden gate park in san francisco": PARK_AND_NEIGHBOURHOOD,
  starbucks: STARBUCKS_RESULTS,
  "philz coffee": PHILZ_RESULTS,
  "union station, washington, dc": [
    WASHINGTON_UNION_STATION,
    CHICAGO_UNION_STATION,
  ],
  "union station in washington, dc": [
    CHICAGO_UNION_STATION,
    WASHINGTON_UNION_STATION,
  ],
  "union station in washington": [CHICAGO_UNION_STATION],
};

type Request = { path: string; body: Record<string, unknown> };

/** A stub Cloud answering search and route requests in the wire shape. */
function cloud() {
  const requests: Request[] = [];
  const adapter = new ElizaCloudMapsAdapter({
    apiKey: "eliza_test_key",
    baseUrl: "https://api.example.test",
    testTransport: {
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/maps/capabilities")
          return Response.json(COVERAGE);
        const body = JSON.parse(String(init?.body ?? "{}"));
        requests.push({ path: url.pathname, body });
        if (url.pathname === "/api/v1/maps/places/search") {
          const places = SEARCHES[String(body.query).toLowerCase()] ?? [];
          return Response.json({
            providerId: PROVIDER,
            attribution: ATTRIBUTION,
            places: places.slice(0, Number(body.limit ?? 10)),
          });
        }
        if (url.pathname === "/api/v1/maps/routes") {
          return Response.json({
            providerId: PROVIDER,
            attribution: ATTRIBUTION,
            routes: [
              {
                providerId: PROVIDER,
                id: "route_1",
                from: body.from,
                to: body.to,
                mode: body.mode,
                geometry: [body.from, body.to],
                distanceMeters: 8_412,
                durationSeconds: 1_260,
                steps: [
                  {
                    instruction: "Head west on Market St",
                    coordinate: body.from,
                    distanceMeters: 8_412,
                  },
                ],
                attribution: ATTRIBUTION,
                fetchedAt: 1_763_400_000_000,
                traffic: "live",
              },
            ],
          });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
    },
  });
  const service = new MapsService(undefined, {} as SavedPlaceStore);
  service.registerAdapter(adapter, true);
  return { service, requests };
}

const OWNER = "00000000-0000-4000-8000-000000000002";
let turn = 0;
/** One owner turn: what was said, and the parameters the planner chose. */
async function say(
  service: MapsService,
  said: string,
  parameters: Record<string, unknown>,
  roomId = "00000000-0000-4000-8000-000000000003",
): Promise<ActionResult> {
  turn += 1;
  const message = {
    id: `00000000-0000-4000-8000-${String(turn).padStart(12, "0")}`,
    entityId: OWNER,
    roomId,
    content: { text: said, source: "client_chat", channelType: "DM" },
  } as unknown as Memory;
  const result = await mapsAction.handler?.(
    { getService: () => service } as unknown as IAgentRuntime,
    message,
    undefined,
    { parameters: { action: "route", ...parameters } } as HandlerOptions,
  );
  if (!result || typeof result !== "object")
    throw new Error("MAPS returned no result");
  return result as ActionResult;
}

const searches = (requests: Request[]) =>
  requests.filter(({ path }) => path === "/api/v1/maps/places/search");
const routes = (requests: Request[]) =>
  requests.filter(({ path }) => path === "/api/v1/maps/routes");

describe("directions between two landmarks", () => {
  it.each(["Union Station, Washington, DC", "Union Station in Washington, DC"])(
    "routes to %s when the other endpoint is near a namesake",
    async (destinationQuery) => {
      const { service, requests } = cloud();
      const result = await say(service, `directions to ${destinationQuery}`, {
        originLatitude: CHICAGO.latitude,
        originLongitude: CHICAGO.longitude,
        originName: "Downtown Chicago",
        destinationQuery,
      });
      expect(result.success).toBe(true);
      expect(routes(requests).map(({ body }) => body.to)).toEqual([
        WASHINGTON_UNION_STATION.coordinate,
      ]);
    },
  );

  it("asks before routing when the only result is in a different city", async () => {
    const { service, requests } = cloud();
    const destinationQuery = "Union Station in Washington";
    const result = await say(service, `directions to ${destinationQuery}`, {
      originLatitude: CHICAGO.latitude,
      originLongitude: CHICAGO.longitude,
      originName: "Downtown Chicago",
      destinationQuery,
    });
    expect(result).toMatchObject({
      success: false,
      data: { choice: { field: "destinationQuery", query: destinationQuery } },
    });
    expect(routes(requests)).toHaveLength(0);
  });

  it("plans the Ferry Building to Golden Gate Park route without asking", async () => {
    const { service, requests } = cloud();
    const result = await say(
      service,
      "directions from the Ferry Building to Golden Gate Park",
      {
        originQuery: "the Ferry Building",
        destinationQuery: "Golden Gate Park",
      },
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        route: {
          origin: { name: "Ferry Building" },
          destination: { name: "Golden Gate Park" },
        },
      },
    });
    expect(result.userFacingText).toContain(
      "Ferry Building to Golden Gate Park: 8.4 km, about 21 min by drive.",
    );
    expect(result.userFacingText).toContain('"kind":"route"');
    // The park is looked for around the settled origin.
    expect(searches(requests).map(({ body }) => body)).toEqual([
      { query: "the Ferry Building", limit: 5 },
      { query: "Golden Gate Park", near: FERRY_BUILDING, limit: 5 },
    ]);
    expect(routes(requests).map(({ body }) => body)).toEqual([
      {
        from: FERRY_BUILDING,
        to: GOLDEN_GATE_PARK,
        mode: "drive",
        alternatives: false,
      },
    ]);
  });

  it.each([
    "Golden Gate Park, San Francisco",
    "Golden Gate Park in San Francisco",
  ])(
    "plans to %s when Cloud also names a neighbourhood after the park",
    async (destinationQuery) => {
      const { service, requests } = cloud();
      const result = await say(
        service,
        `directions from the Ferry Building to ${destinationQuery}`,
        { originQuery: "the Ferry Building", destinationQuery },
      );
      expect(result).toMatchObject({
        success: true,
        data: {
          route: {
            origin: { name: "Ferry Building" },
            destination: {
              name: "Golden Gate Park",
              providerPlaceId: "ChIJY_dFYHKHhYARMKc772iLvnE",
            },
          },
        },
      });
      expect(result.userFacingText).not.toContain("Which one did you mean?");
      expect(routes(requests)).toHaveLength(1);
    },
  );

  it("still asks which Starbucks, and the reply plans the route", async () => {
    const { service, requests } = cloud();
    const ask = await say(
      service,
      "directions from Starbucks to Golden Gate Park",
      {
        originQuery: "Starbucks",
        destinationQuery: "Golden Gate Park",
      },
    );
    expect(ask).toMatchObject({
      success: false,
      data: {
        reason: "missing_input",
        awaitingUserInput: true,
        missingFields: ["originQuery"],
        choice: { field: "originQuery", query: "Starbucks" },
      },
    });
    expect(ask.text).toBe(
      [
        "Which “Starbucks” did you mean as the starting place?",
        "1. Starbucks — 1 Market St, San Francisco, CA 94105, USA",
        "2. Starbucks — 201 Powell St, San Francisco, CA 94102, USA",
        "3. Starbucks — 2675 Mission St, San Francisco, CA 94110, USA",
      ].join("\n"),
    );
    expect(routes(requests)).toHaveLength(0);
    // The planner restates nothing: the reply alone continues the request.
    const route = await say(service, "the second one", {});
    expect(route).toMatchObject({
      success: true,
      data: {
        route: {
          origin: { providerPlaceId: "ChIJ_starbucks_union_sq_01" },
          destination: { name: "Golden Gate Park" },
        },
      },
    });
    expect(routes(requests)).toHaveLength(1);
  });
});

describe("a reply binds to the question just asked", () => {
  it("asks origin then destination, and each 'the first one' settles its own", async () => {
    const { service, requests } = cloud();
    const first = await say(
      service,
      "walking directions from Starbucks to Philz Coffee",
      {
        originQuery: "Starbucks",
        destinationQuery: "Philz Coffee",
        travelMode: "walk",
      },
    );
    expect(first.data).toMatchObject({ missingFields: ["originQuery"] });
    // The planner copies the reply into the origin and restates the rest.
    const second = await say(service, "the second one", {
      originQuery: "the second one",
      destinationQuery: "Philz Coffee",
    });
    expect(second).toMatchObject({
      success: false,
      data: {
        missingFields: ["destinationQuery"],
        choice: { field: "destinationQuery", query: "Philz Coffee" },
      },
    });
    expect(second.text).toBe(
      [
        "Which “Philz Coffee” did you mean as the destination?",
        "Starting from Starbucks.",
        "1. Philz Coffee — 5 Embarcadero Center, San Francisco, CA 94111, USA",
        "2. Philz Coffee — 3101 24th St, San Francisco, CA 94110, USA",
      ].join("\n"),
    );
    // The planner binds "the first one" to the origin, as v610's did; the
    // open question is about the destination, so that is what it settles.
    const third = await say(service, "the first one", {
      originQuery: "the first one",
      destinationQuery: "Philz Coffee",
    });
    expect(third).toMatchObject({
      success: true,
      data: {
        route: {
          origin: { providerPlaceId: "ChIJ_starbucks_union_sq_01" },
          destination: { providerPlaceId: "ChIJ_philz_front_st_000001" },
          travelMode: "walk",
        },
      },
    });
    // Starbucks was searched once; the settled origin was not searched again.
    expect(searches(requests).map(({ body }) => body.query)).toEqual([
      "Starbucks",
      "Philz Coffee",
    ]);
    expect(routes(requests).map(({ body }) => body)).toEqual([
      {
        from: STARBUCKS_RESULTS[1]?.coordinate,
        to: PHILZ_RESULTS[0]?.coordinate,
        mode: "walk",
        alternatives: false,
      },
    ]);
    // The question is closed: another "the first one" starts nothing.
    expect(
      service.placeChoices.get({
        roomId: "00000000-0000-4000-8000-000000000003",
        entityId: OWNER,
      }),
    ).toBeUndefined();
  });

  it("keeps the supplied destination coordinates and routes from the origin the owner chose", async () => {
    const { service, requests } = cloud();
    const ask = await say(
      service,
      "walking directions from Starbucks to my pin",
      {
        originQuery: "Starbucks",
        destinationName: "My pin",
        destinationLatitude: GOLDEN_GATE_PARK.latitude,
        destinationLongitude: GOLDEN_GATE_PARK.longitude,
        travelMode: "walk",
      },
    );
    expect(ask.data).toMatchObject({ missingFields: ["originQuery"] });
    const answer = await say(service, "the second one", {
      originName: "First match",
      originLatitude: FERRY_BUILDING.latitude,
      originLongitude: FERRY_BUILDING.longitude,
      travelMode: "drive",
    });
    expect(answer).toMatchObject({
      success: true,
      data: {
        route: {
          origin: { providerPlaceId: "ChIJ_starbucks_union_sq_01" },
          destination: { name: "My pin", coordinates: GOLDEN_GATE_PARK },
        },
      },
    });
    expect(routes(requests)[0]?.body.mode).toBe("walk");
  });

  it("does not carry a question into another conversation", async () => {
    const { service } = cloud();
    await say(service, "directions from Starbucks to Golden Gate Park", {
      originQuery: "Starbucks",
      destinationQuery: "Golden Gate Park",
    });
    const elsewhere = await say(
      service,
      "the first one",
      {},
      "00000000-0000-4000-8000-000000000009",
    );
    expect(elsewhere).toMatchObject({
      success: false,
      data: { missingFields: ["originQuery", "destinationQuery"] },
    });
  });
});

describe("an unanswered question closes when the owner moves on", () => {
  it("does not bind a later 'the first one' to a question the owner left", async () => {
    const { service, requests } = cloud();
    await say(service, "directions from Starbucks to Golden Gate Park", {
      originQuery: "Starbucks",
      destinationQuery: "Golden Gate Park",
    });
    // The owner's next turn is about something else; the routing rule looks
    // the question up for every owner turn.
    expect(
      service.placeChoices.get({
        id: "00000000-0000-4000-8000-0000000fffff",
        roomId: "00000000-0000-4000-8000-000000000003",
        entityId: OWNER,
      }),
    ).toBeDefined();
    const later = await say(service, "the first one", {});
    expect(later).toMatchObject({
      success: false,
      data: { missingFields: ["originQuery", "destinationQuery"] },
    });
    expect(routes(requests)).toHaveLength(0);
  });

  it("answers the question with the owner's next turn", async () => {
    const { service, requests } = cloud();
    await say(service, "directions from Starbucks to Golden Gate Park", {
      originQuery: "Starbucks",
      destinationQuery: "Golden Gate Park",
    });
    const route = await say(service, "the first one", {});
    expect(route).toMatchObject({
      success: true,
      data: {
        route: { origin: { providerPlaceId: "ChIJ_starbucks_market_0001" } },
      },
    });
    expect(routes(requests)).toHaveLength(1);
  });
});

describe("dominantPlace", () => {
  const ref = (
    name: string,
    latitude: number,
    longitude: number,
  ): PlaceRef => ({
    provider: PROVIDER,
    providerPlaceId: `${name}:${latitude}:${longitude}`,
    name,
    coordinates: { latitude, longitude },
    categories: [],
  });
  it("takes a landmark over far-away namesakes when they are the minority", () => {
    const top = ref("Ferry Building", 37.7955, -122.3937);
    expect(
      dominantPlace("Ferry Building", [
        top,
        ref("Ferry Building Marketplace", 37.7956, -122.3934),
        ref("Ferry Building", -36.8431, 174.7672),
      ]),
    ).toBe(top);
  });
  it("takes a park over the same-named neighbourhood beside it", () => {
    const area = (
      name: string,
      address: string,
      latitude: number,
      longitude: number,
    ) => ({
      ...ref(name, latitude, longitude),
      formattedAddress: address,
    });
    const park = area(
      "Golden Gate Park",
      "San Francisco, CA, USA",
      37.7689203,
      -122.482977,
    );
    const neighbourhood = area(
      "Golden Gate Park",
      "Golden Gate Park, San Francisco, CA, USA",
      37.7680222,
      -122.4670096,
    );
    expect(
      dominantPlace("Golden Gate Park, San Francisco", [park, neighbourhood]),
    ).toBe(park);
    expect(
      dominantPlace("Golden Gate Park", [park, neighbourhood], {
        latitude: 37.7955,
        longitude: -122.3937,
      }),
    ).toBe(park);
    // Branches at street addresses are still a question, however close.
    expect(
      dominantPlace("Starbucks", [
        area(
          "Starbucks",
          "1 Market St, San Francisco, CA 94105, USA",
          37.7941,
          -122.3951,
        ),
        area(
          "Starbucks",
          "201 Powell St, San Francisco, CA 94102, USA",
          37.7873,
          -122.4082,
        ),
      ]),
    ).toBeUndefined();
    // Same-named areas far apart are different places.
    expect(
      dominantPlace("Chinatown", [
        area("Chinatown", "San Francisco, CA, USA", 37.7941, -122.4078),
        area("Chinatown", "Oakland, CA, USA", 37.7997, -122.2706),
      ]),
    ).toBeUndefined();
  });
  it("asks when a top result only contains the words and rivals stand elsewhere", () => {
    expect(
      dominantPlace("coffee", [
        ref("Blue Bottle Coffee", 37.7764, -122.4232),
        ref("Philz Coffee", 37.7525, -122.4148),
      ]),
    ).toBeUndefined();
  });
  it("asks when the top result is not named what was asked", () => {
    expect(
      dominantPlace("somewhere to eat", [
        ref("Tadich Grill", 37.7936, -122.3995),
        ref("Zuni Café", 37.7735, -122.4216),
      ]),
    ).toBeUndefined();
  });
  it("keeps the namesake near the other endpoint", () => {
    const local = ref("Union Square", 37.788, -122.4075);
    expect(
      dominantPlace(
        "Union Square",
        [ref("Union Square", 40.7359, -73.9911), local],
        { latitude: 37.7955, longitude: -122.3937 },
      ),
    ).toBe(local);
    expect(
      dominantPlace(
        "Union Square",
        [
          ref("Union Square", 40.7359, -73.9911),
          ref("Ferry Terminal", 37.792, -122.398),
        ],
        { latitude: 37.7955, longitude: -122.3937 },
      ),
    ).toBeUndefined();
  });
});

describe("choiceIndex", () => {
  it.each([
    ["the first one", 0],
    ["The first one.", 0],
    ["first", 0],
    ["1", 0],
    ["number two", 1],
    ["the 3rd one please", 2],
    ["option 2", 1],
    ["yes, the second", 1],
    ["the last one", 4],
    ["one", 0],
  ])("%s", (reply, index) => {
    expect(choiceIndex(reply, 5)).toBe(index);
  });
  it.each([
    "the one",
    "the first one was wrong, show me directions to Coit Tower",
    "directions to the first street",
    "the sixth one",
    "",
  ])("is not a choice of five: %s", (reply) => {
    expect(choiceIndex(reply, 5)).toBeUndefined();
  });
  it("forgets an unanswered question after its lifetime", () => {
    let now = 0;
    const choices = new PlaceChoices(() => now);
    const scope = { roomId: "r", entityId: "e" };
    choices.set(scope, {
      operation: "route",
      field: "originQuery",
      query: "Starbucks",
      places: [],
      queries: {},
      resolved: {},
    });
    expect(choices.get(scope)).toBeDefined();
    now = PLACE_CHOICE_TTL_MS;
    expect(choices.get(scope)).toBeUndefined();
  });
});
