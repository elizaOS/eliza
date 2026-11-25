// spec/cloud/services/maps.md, "A dispatched request is charged what the provider billed, or its quote when the reply was lost, and one never dispatched is charged nothing"
import type { FakeAnswer, FakeHandler, FakeRequest } from "./fakes.ts";

export type OsmScript =
  | { readonly kind: "answer" }
  | { readonly kind: "unroutable"; readonly message: string }
  | { readonly kind: "outage" }
  | { readonly kind: "oversized" }
  | { readonly kind: "notJson" };

export const osmPlace = {
  place_id: 1,
  osm_type: "node",
  osm_id: 240109189,
  lat: "52.5170365",
  lon: "13.3888599",
  name: "Brandenburger Tor",
  display_name: "Brandenburger Tor, Pariser Platz, Mitte, Berlin, 10117, Deutschland",
  address: { road: "Pariser Platz", city: "Berlin" },
  extratags: { website: "https://example.org/tor", opening_hours: "24/7", phone: "+49 30 0000" },
} as const;

export const osmAddress = {
  place_id: 2,
  osm_type: "way",
  osm_id: 4031000,
  lat: "52.5163",
  lon: "13.3777",
  display_name: "1, Pariser Platz, Mitte, Berlin, 10117, Deutschland",
  address: { house_number: "1", road: "Pariser Platz" },
} as const;

export const osmPath = {
  distance: 1520.4,
  time: 912_000,
  points: { type: "LineString", coordinates: [[13.3888, 52.5170], [13.3800, 52.5165], [13.3777, 52.5163]] },
  instructions: [
    { text: "Continue onto Pariser Platz", distance: 800.2, interval: [0, 1], sign: 0 },
    { text: "Turn left onto Ebertstraße", distance: 720.2, interval: [1, 2], sign: -2 },
    { text: "Arrive at destination", distance: 0, interval: [2, 2], sign: 4 },
  ],
} as const;

export interface OsmFake {
  readonly handler: FakeHandler;
  readonly calls: ReadonlyArray<FakeRequest>;
  /** @throws {never} */
  script(...next: ReadonlyArray<OsmScript>): void;
}

function answerOf(request: FakeRequest): FakeAnswer | undefined {
  switch (`${request.method} ${request.path}`) {
    case "GET /nominatim/search":
      return { status: 200, body: request.query.get("layer") === "address" ? [osmAddress] : [osmPlace, osmAddress] };
    case "GET /nominatim/reverse":
      return { status: 200, body: osmAddress };
    case "GET /nominatim/lookup":
      return { status: 200, body: request.query.get("osm_ids") === "N240109189" ? [osmPlace] : [] };
    case "POST /graphhopper/route": {
      const body = JSON.parse(request.body) as { readonly profile?: unknown };
      return ["car", "foot", "bike"].includes(String(body.profile))
        ? { status: 200, body: { paths: [osmPath] } }
        : { status: 400, body: { message: `The requested profile '${String(body.profile)}' does not exist` } };
    }
    default:
      return undefined;
  }
}

function scripted(script: OsmScript, request: FakeRequest): FakeAnswer | undefined {
  switch (script.kind) {
    case "answer":
      return answerOf(request);
    case "unroutable":
      return { status: 400, body: { message: script.message } };
    case "outage":
      return { status: 503, body: "upstream unavailable" };
    case "oversized":
      return { status: 200, body: "x".repeat(2 * 1024 * 1024 + 1) };
    case "notJson":
      return { status: 200, body: "<html>gateway</html>", headers: { "content-type": "text/html" } };
  }
}

/** @throws {never} */
export function osmFake(): OsmFake {
  const calls: FakeRequest[] = [];
  const queue: OsmScript[] = [];
  return {
    handler: (request) => {
      if (!request.path.startsWith("/nominatim/") && !request.path.startsWith("/graphhopper/")) return undefined;
      calls.push(request);
      return scripted(queue.shift() ?? { kind: "answer" }, request);
    },
    calls,
    script: (...next) => {
      queue.push(...next);
    },
  };
}
