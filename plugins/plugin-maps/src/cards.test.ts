/**
 * Tests the MAPS chat-card contract over the real runtime: `[MAPSCARD]`
 * emission for place/route/handoff results, missing-input form fields
 * (travel mode, result limit), the precise-location locate card, and the
 * share-location confirmation gate. Deterministic in-memory adapter; no mock
 * of the system under test.
 */

import {
  type ActionParameters,
  AgentRuntime,
  createCharacter,
  InMemoryDatabaseAdapter,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapsAction } from "./action.js";
import type { MapsProviderAdapter } from "./adapter.js";
import {
  MAPS_CARD_CLOSE,
  MAPS_CARD_MAX_PLACES,
  MAPS_CARD_OPEN,
  type MapsCard,
} from "./card.js";
import { MAPS_SERVICE_TYPE, MapsService } from "./service.js";

const AGENT_ID = "11111111-1111-4111-a111-111111111111" as UUID;
const OWNER_ID = "22222222-2222-4222-a222-222222222222" as UUID;
const ROOM_ID = "44444444-4444-4444-a444-444444444444" as UUID;

const home = {
  provider: "contract-maps",
  providerPlaceId: "home-1",
  name: "Home",
  coordinates: { latitude: 34.05, longitude: -118.24 },
  formattedAddress: "1 Home Way",
  categories: ["home"],
};
const office = {
  ...home,
  providerPlaceId: "office-1",
  name: "Office",
  coordinates: { latitude: 34.06, longitude: -118.25 },
};

const manyPlaces = Array.from({ length: 12 }, (_, index) => ({
  ...home,
  providerPlaceId: `bulk-${index}`,
  name: `Bulk place ${index}`,
}));

const adapter: MapsProviderAdapter = {
  id: "contract-maps",
  connectionId: "conn_1234567890abcdef",
  attribution: "Map data (c) Contract Maps",
  async searchPlaces(request) {
    if (request.query === "empty") return { places: [], nextCursor: null };
    if (request.query === "bulk")
      return { places: manyPlaces, nextCursor: "bulk-next" };
    return { places: [home], nextCursor: "next-page" };
  },
  async getPlace(id) {
    if (id === home.providerPlaceId) return home;
    if (id === office.providerPlaceId) return office;
    return null;
  },
  async planRoute(request) {
    return {
      provider: "contract-maps",
      routeId: "route-1",
      ...request,
      distanceMeters: 1_500,
      durationSeconds: 600,
      encodedPolyline: "abc123",
      warnings: ["Toll road"],
    };
  },
};

function message(): Memory {
  return {
    id: "55555555-5555-4555-a555-555555555555" as UUID,
    agentId: AGENT_ID,
    entityId: OWNER_ID,
    roomId: ROOM_ID,
    content: { text: "maps" },
  };
}

function extractCard(userFacingText: string | undefined): MapsCard {
  expect(userFacingText).toBeDefined();
  const textValue = userFacingText as string;
  const start = textValue.indexOf(MAPS_CARD_OPEN);
  const end = textValue.indexOf(MAPS_CARD_CLOSE);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(
    textValue.slice(start + MAPS_CARD_OPEN.length, end).trim(),
  ) as MapsCard;
}

describe("MAPS chat cards", () => {
  let runtime: AgentRuntime;

  beforeEach(() => {
    runtime = new AgentRuntime({
      agentId: AGENT_ID,
      character: createCharacter({ name: "Maps Card Test" }),
      adapter: new InMemoryDatabaseAdapter(),
      disableBasicCapabilities: true,
      logLevel: "fatal",
    });
    const service = new MapsService(runtime);
    service.registerAdapter(adapter, true);
    vi.spyOn(runtime, "getService").mockImplementation((serviceType) =>
      serviceType === MAPS_SERVICE_TYPE ? service : null,
    );
  });

  async function invoke(parameters: ActionParameters) {
    const actionResult = await mapsAction.handler(
      runtime,
      message(),
      undefined,
      { parameters },
    );
    if (!actionResult) throw new Error("MAPS handler returned no result");
    return actionResult;
  }

  it("emits a place card for a place-detail lookup", async () => {
    const found = await invoke({ action: "place", placeId: "home-1" });
    expect(found.success).toBe(true);
    const card = extractCard(found.userFacingText);
    expect(card).toMatchObject({
      kind: "place",
      place: {
        name: "Home",
        latitude: 34.05,
        longitude: -118.24,
        providerPlaceId: "home-1",
        formattedAddress: "1 Home Way",
      },
      attribution: "Map data (c) Contract Maps",
    });
  });

  it("emits a bounded places card with the pagination cursor and adapter attribution", async () => {
    const page = await invoke({ action: "place", query: "bulk" });
    expect(page.success).toBe(true);
    const card = extractCard(page.userFacingText);
    if (card.kind !== "places") throw new Error("expected a places card");
    expect(card.query).toBe("bulk");
    expect(card.places).toHaveLength(MAPS_CARD_MAX_PLACES);
    expect(card.nextCursor).toBe("bulk-next");
    expect(card.attribution).toBe("Map data (c) Contract Maps");
  });

  it("keeps designed-empty search results card-free", async () => {
    const empty = await invoke({ action: "place", query: "empty" });
    expect(empty.success).toBe(true);
    expect(empty.userFacingText).not.toContain(MAPS_CARD_OPEN);
  });

  it("emits a route card without the encoded polyline", async () => {
    const route = await invoke({
      action: "route",
      originPlaceId: "home-1",
      destinationPlaceId: "office-1",
      travelMode: "transit",
    });
    expect(route.success).toBe(true);
    const card = extractCard(route.userFacingText);
    expect(card).toMatchObject({
      kind: "route",
      travelMode: "transit",
      distanceMeters: 1_500,
      durationSeconds: 600,
      warnings: ["Toll road"],
      origin: { name: "Home" },
      destination: { name: "Office" },
      attribution: "Map data (c) Contract Maps",
    });
    expect(route.userFacingText).not.toContain("abc123");
  });

  it("offers travel mode in the missing-endpoint route form", async () => {
    const missing = await invoke({ action: "route" });
    expect(missing.success).toBe(false);
    expect(missing.data).toMatchObject({ awaitingUserInput: true });
    const form = (
      missing.data as {
        uiRequest: { fields: Array<{ name: string; options?: unknown[] }> };
      }
    ).uiRequest;
    const mode = form.fields.find((field) => field.name === "travelMode");
    expect(mode?.options).toHaveLength(4);
  });

  it("offers a result-limit filter in the missing-query place form", async () => {
    const missing = await invoke({ action: "place" });
    expect(missing.success).toBe(false);
    const form = (
      missing.data as { uiRequest: { fields: Array<{ name: string }> } }
    ).uiRequest;
    expect(form.fields.map((field) => field.name)).toContain("limit");
  });

  it("requests a precise device location for near-me search", async () => {
    const locate = await invoke({
      action: "place",
      query: "coffee",
      useCurrentLocation: true,
    });
    expect(locate.success).toBe(false);
    expect(locate.data).toMatchObject({
      awaitingUserInput: true,
      reason: "missing_location",
    });
    expect(extractCard(locate.userFacingText)).toMatchObject({
      kind: "locate",
      intent: "place-near",
    });
  });

  it("requests a precise device location for a missing route origin", async () => {
    const locate = await invoke({
      action: "route",
      destinationPlaceId: "office-1",
      useCurrentLocation: true,
    });
    expect(locate.success).toBe(false);
    expect(extractCard(locate.userFacingText)).toMatchObject({
      kind: "locate",
      intent: "route-origin",
    });
  });

  it("gates location sharing behind an explicit confirmation choice", async () => {
    const unconfirmed = await invoke({ action: "share", placeId: "home-1" });
    expect(unconfirmed.success).toBe(false);
    expect(unconfirmed.data).toMatchObject({
      awaitingUserInput: true,
      reason: "confirmation_required",
    });
    expect(unconfirmed.userFacingText).toContain("[CHOICE:maps-share");
    expect(unconfirmed.userFacingText).not.toContain("geo:");
    expect(unconfirmed.data).not.toHaveProperty("handoff");
  });

  it("emits a share receipt card with per-platform URIs once confirmed", async () => {
    const share = await invoke({
      action: "share",
      placeId: "home-1",
      confirm: true,
    });
    expect(share.success).toBe(true);
    const card = extractCard(share.userFacingText);
    if (card.kind !== "handoff") throw new Error("expected a handoff card");
    expect(card.handoffKind).toBe("share");
    expect(card.geoUri).toMatch(/^geo:34\.05,-118\.24/);
    expect(card.appleMapsUri).toContain("maps.apple.com/?ll=34.05,-118.24");
    expect(card.webUri).toContain("openstreetmap.org/?mlat=34.05");
    expect(card.sharedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("emits a navigation handoff card with deep links and no share receipt", async () => {
    const navigate = await invoke({ action: "navigate", placeId: "office-1" });
    expect(navigate.success).toBe(true);
    const card = extractCard(navigate.userFacingText);
    if (card.kind !== "handoff") throw new Error("expected a handoff card");
    expect(card.handoffKind).toBe("navigate");
    expect(card.geoUri).toMatch(/^geo:34\.06,-118\.25/);
    expect(card.appleMapsUri).toContain("maps.apple.com/?daddr=34.06,-118.25");
    expect(card.webUri).toContain("openstreetmap.org/directions?to=");
    expect(card.sharedAt).toBeUndefined();
  });
});
