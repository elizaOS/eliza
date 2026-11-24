// spec/cloud/services/maps.md, "A request reaches the provider only under the standing that admitted it, for at most 10 seconds and 2 MiB"; spec/cloud/services/maps.md, "A dispatched request is charged what the provider billed, or its quote when the reply was lost, and one never dispatched is charged nothing"; spec/cloud/services/maps.md, "A place lookup asks for nearby places first only when preferred, and for the address only when there are none"; spec/cloud/services/maps.md, "A route whose endpoints coincide is a zero-length route, never a malformed answer"; spec/cloud/services/maps.md, "A search ranked by distance reads the provider's largest page and answers its nearest places first"
import { Effect } from "effect";
import type { FakeAnswer, FakeHandler, FakeRequest } from "./fakes.ts";

export type GoogleOperation = "searchText" | "searchNearby" | "details" | "geocode" | "computeRoutes" | "createSession" | "tile" | "viewport";

export type GoogleScript =
  | { readonly kind: "answer" }
  | { readonly kind: "places"; readonly places: ReadonlyArray<unknown> }
  | { readonly kind: "hold"; readonly wait: () => Promise<void> }
  | { readonly kind: "empty" }
  | { readonly kind: "notJson" }
  | { readonly kind: "outage" }
  | { readonly kind: "oversized" }
  | { readonly kind: "geocodeReply"; readonly status: number; readonly geocode: string }
  | { readonly kind: "reply"; readonly status: number; readonly body: unknown }
  | { readonly kind: "zeroLengthRoute"; readonly points: 0 | 1 };

export interface GoogleMapsFake {
  readonly handler: FakeHandler;
  readonly calls: ReadonlyArray<{ readonly operation: GoogleOperation; readonly request: FakeRequest }>;
  readonly sessionRequested: Promise<void>;
  /** @throws {never} */
  count(operation: GoogleOperation): number;
  /** @throws {never} */
  script(...next: ReadonlyArray<GoogleScript>): void;
  /** @throws {never} */
  delaySessions(delayMs: number): void;
}

export const googleKey = "maps-key";
export const googlePlace = {
  id: "ChIJgUbEo8cfqokR5lP9_Wh_DaM",
  displayName: { text: "Brandenburger Tor" },
  formattedAddress: "Pariser Platz, 10117 Berlin, Germany",
  location: { latitude: 52.5162746, longitude: 13.3777041 },
  websiteUri: "https://example.org/tor",
  internationalPhoneNumber: "+49 30 0000",
  regularOpeningHours: { weekdayDescriptions: ["Monday: Open 24 hours"] },
} as const;
export const googleAddress = {
  place_id: "ChIJ3S-JXmauEmsRUcIaWtf4MzE",
  formatted_address: "Pariser Platz 1, 10117 Berlin, Germany",
  geometry: { location: { lat: 52.5163, lng: 13.3777 } },
} as const;
export const routePoints: ReadonlyArray<readonly [number, number]> = [[52.517, 13.3888], [52.5165, 13.38], [52.5163, 13.3777]];
export const tilePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function encodePolyline(points: ReadonlyArray<readonly [number, number]>): string {
  let text = "";
  let previous = [0, 0];
  for (const point of points) {
    const scaled = [Math.round(point[0] * 1e5), Math.round(point[1] * 1e5)];
    for (const delta of [scaled[0] - previous[0], scaled[1] - previous[1]]) {
      let value = delta < 0 ? ~(delta << 1) : delta << 1;
      while (value >= 0x20) {
        text += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
        value >>= 5;
      }
      text += String.fromCharCode(value + 63);
    }
    previous = scaled;
  }
  return text;
}

function operationOf(request: FakeRequest): GoogleOperation | undefined {
  const route = `${request.method} ${request.path}`;
  if (route === "POST /places.googleapis.com/v1/places:searchText") return "searchText";
  if (route === "POST /places.googleapis.com/v1/places:searchNearby") return "searchNearby";
  if (request.method === "GET" && request.path.startsWith("/places.googleapis.com/v1/places/")) return "details";
  if (route === "GET /maps.googleapis.com/maps/api/geocode/json") return "geocode";
  if (route === "POST /routes.googleapis.com/directions/v2:computeRoutes") return "computeRoutes";
  if (route === "POST /tile.googleapis.com/v1/createSession") return "createSession";
  if (request.method === "GET" && /^\/tile\.googleapis\.com\/v1\/2dtiles\/\d+\/\d+\/\d+$/.test(request.path)) return "tile";
  if (route === "GET /tile.googleapis.com/tile/v1/viewport") return "viewport";
  return undefined;
}

function keyOf(request: FakeRequest): string | undefined {
  const header = request.headers["x-goog-api-key"];
  return typeof header === "string" ? header : request.query.get("key") ?? undefined;
}

function routeOf(request: FakeRequest): FakeAnswer {
  const fields = String(request.headers["x-goog-fieldmask"] ?? "");
  const body = JSON.parse(request.body) as { readonly travelMode?: string };
  const transit = body.travelMode === "TRANSIT";
  const step = (index: number, maneuver: string, instructions: string) => ({
    distanceMeters: index === 0 ? 800 : 720,
    startLocation: { latLng: { latitude: routePoints[index][0], longitude: routePoints[index][1] } },
    navigationInstruction: { maneuver, instructions },
    ...(transit && fields.includes("transitDetails") ? { transitDetails: { headsign: "Hauptbahnhof", stopCount: 2, stopDetails: { departureStop: { name: "Unter den Linden" }, arrivalStop: { name: "Brandenburger Tor" } }, transitLine: { nameShort: "U5", color: "#7E5330", vehicle: { type: "SUBWAY" } } } } : {}),
  });
  const route = {
    distanceMeters: 1520,
    duration: "912s",
    ...(fields.includes("routes.staticDuration") ? { staticDuration: "840s" } : {}),
    polyline: { encodedPolyline: encodePolyline(routePoints) },
    legs: [{ steps: [step(0, "DEPART", "Head west on Unter den Linden"), step(1, "TURN_LEFT", "Turn left onto Ebertstraße")] }],
  };
  return { status: 200, body: { routes: [route] } };
}

function answerOf(operation: GoogleOperation, request: FakeRequest): FakeAnswer {
  switch (operation) {
    case "searchText":
    case "searchNearby":
      return { status: 200, body: { places: [googlePlace] } };
    case "details":
      return request.path === `/places.googleapis.com/v1/places/${googlePlace.id}` ? { status: 200, body: googlePlace } : { status: 404, body: { error: { code: 404, status: "NOT_FOUND" } } };
    case "geocode":
      return { status: 200, body: { status: "OK", results: [googleAddress] } };
    case "computeRoutes":
      return routeOf(request);
    case "createSession":
      return { status: 200, body: { session: "fake-tile-session", expiry: String(Math.floor(Date.now() / 1000) + 86_400), imageFormat: "png" } };
    case "tile":
      return request.query.get("session") === "fake-tile-session"
        ? { status: 200, chunks: [tilePng], headers: { "content-type": "image/png" } }
        : { status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED" } } };
    case "viewport":
      return { status: 200, body: { copyright: "Map data ©2026 Google", maxZoomRects: [{ maxZoom: 21 }] } };
  }
}

function emptyOf(operation: GoogleOperation, request: FakeRequest): FakeAnswer {
  switch (operation) {
    case "geocode":
      return { status: 200, body: { status: "ZERO_RESULTS", results: [] } };
    case "computeRoutes":
      return { status: 200, body: {} };
    case "details":
      return { status: 404, body: { error: { code: 404, status: "NOT_FOUND" } } };
    case "searchText":
    case "searchNearby":
      return { status: 200, body: {} };
    case "createSession":
    case "tile":
    case "viewport":
      return answerOf(operation, request);
  }
}

async function scripted(script: GoogleScript, operation: GoogleOperation, request: FakeRequest): Promise<FakeAnswer> {
  switch (script.kind) {
    case "answer":
      return answerOf(operation, request);
    case "places": {
      const { pageSize } = JSON.parse(request.body) as { readonly pageSize?: number };
      return { status: 200, body: { places: script.places.slice(0, pageSize ?? 20) } };
    }
    case "hold":
      await script.wait();
      return answerOf(operation, request);
    case "empty":
      return emptyOf(operation, request);
    case "notJson":
      return { status: 200, body: "{\"places\": [", headers: { "content-type": "application/json" } };
    case "outage":
      return { status: 503, body: { error: { code: 503, status: "UNAVAILABLE" } } };
    case "oversized":
      return { status: 200, body: "x".repeat(2 * 1024 * 1024 + 1) };
    case "geocodeReply":
      return operation === "geocode" ? { status: script.status, body: { status: script.geocode, results: [] } } : answerOf(operation, request);
    case "reply":
      return { status: script.status, body: script.body };
    case "zeroLengthRoute":
      return { status: 200, body: { routes: [{ duration: "0s", polyline: { encodedPolyline: encodePolyline(routePoints.slice(0, script.points)) }, legs: [{}] }] } };
  }
}

/** @throws {never} */
export function googleMapsFake(): GoogleMapsFake {
  const calls: Array<{ operation: GoogleOperation; request: FakeRequest }> = [];
  const queue: GoogleScript[] = [];
  let sessionDelayMs = 0;
  let sessionAsked: () => void = () => undefined;
  const sessionRequested = new Promise<void>((resolve) => {
    sessionAsked = resolve;
  });
  return {
    handler: async (request) => {
      const operation = operationOf(request);
      if (operation === undefined) return undefined;
      calls.push({ operation, request });
      if (operation === "createSession") sessionAsked();
      if (keyOf(request) !== googleKey) return { status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED" } } };
      const session: GoogleScript = sessionDelayMs > 0 ? { kind: "hold", wait: () => Effect.runPromise(Effect.sleep(sessionDelayMs)) } : { kind: "answer" };
      return scripted(operation === "createSession" ? session : queue.shift() ?? { kind: "answer" }, operation, request);
    },
    calls,
    sessionRequested,
    count: (operation) => calls.filter((call) => call.operation === operation).length,
    script: (...next) => {
      queue.push(...next);
    },
    delaySessions: (delayMs) => {
      sessionDelayMs = delayMs;
    },
  };
}
