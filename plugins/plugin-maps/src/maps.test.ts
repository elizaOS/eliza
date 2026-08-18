/** Tests real maps service/action behavior over the in-memory runtime database adapter. */

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
import { mapsPlugin } from "./plugin.js";
import { MAPS_SERVICE_TYPE, MapsService } from "./service.js";

const AGENT_ID = "11111111-1111-4111-a111-111111111111" as UUID;
const OWNER_ID = "22222222-2222-4222-a222-222222222222" as UUID;
const OTHER_OWNER_ID = "33333333-3333-4333-a333-333333333333" as UUID;
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

const adapter: MapsProviderAdapter = {
  id: "contract-maps",
  connectionId: "conn_1234567890abcdef",
  async searchPlaces(request) {
    return request.query === "empty"
      ? { places: [], nextCursor: null }
      : { places: [home], nextCursor: request.cursor ? null : "next-page" };
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
      warnings: [],
    };
  },
};

function message(entityId = OWNER_ID): Memory {
  return {
    id: "55555555-5555-4555-a555-555555555555" as UUID,
    agentId: AGENT_ID,
    entityId,
    roomId: ROOM_ID,
    content: { text: "maps" },
  };
}

async function invoke(
  runtime: AgentRuntime,
  parameters: ActionParameters,
  entityId = OWNER_ID,
) {
  const actionResult = await mapsAction.handler(
    runtime,
    message(entityId),
    undefined,
    { parameters },
  );
  if (!actionResult) throw new Error("MAPS handler returned no result");
  return actionResult;
}

describe("MapsService and MAPS action", () => {
  let runtime: AgentRuntime;
  let service: MapsService;

  beforeEach(() => {
    runtime = new AgentRuntime({
      agentId: AGENT_ID,
      character: createCharacter({ name: "Maps Test" }),
      adapter: new InMemoryDatabaseAdapter(),
      disableBasicCapabilities: true,
      logLevel: "fatal",
    });
    service = new MapsService(runtime);
    service.registerAdapter(adapter, true);
    vi.spyOn(runtime, "getService").mockImplementation((serviceType) =>
      serviceType === MAPS_SERVICE_TYPE ? service : null,
    );
  });

  it("registers the umbrella and every promoted subaction", () => {
    expect(mapsPlugin.actions?.map((action) => action.name)).toEqual([
      "MAPS",
      "MAPS_PLACE",
      "MAPS_ROUTE",
      "MAPS_SAVE",
      "MAPS_SHARE",
      "MAPS_NAVIGATE",
    ]);
    expect(mapsAction.subActions).toEqual([
      "MAPS_PLACE",
      "MAPS_ROUTE",
      "MAPS_SAVE",
      "MAPS_SHARE",
      "MAPS_NAVIGATE",
    ]);
  });

  it("validates action selection without rejecting unresolved planner calls", async () => {
    await expect(
      mapsAction.validate?.(runtime, message(), undefined, {
        parameters: { action: "route" },
      }),
    ).resolves.toBe(true);
    await expect(
      mapsAction.validate?.(runtime, message(), undefined, {
        parameters: { action: "teleport" },
      }),
    ).resolves.toBe(false);
    await expect(mapsAction.validate?.(runtime, message())).resolves.toBe(true);
  });

  it("returns a typed UI form when place input is missing", async () => {
    const result = await invoke(runtime, { action: "place" });
    expect(result).toMatchObject({
      success: false,
      data: {
        reason: "missing_input",
        awaitingUserInput: true,
        uiRequest: { kind: "form", fields: [{ name: "query", type: "text" }] },
      },
    });
    expect(result.userFacingText).toContain("[FORM]");
  });

  it("keeps designed-empty place search separate from failure and carries cursors", async () => {
    const empty = await invoke(runtime, { action: "place", query: "empty" });
    expect(empty).toMatchObject({ success: true, data: { status: "empty" } });

    const page = await invoke(runtime, { action: "place", query: "home" });
    expect(page).toMatchObject({
      success: true,
      data: { page: { nextCursor: "next-page", places: [{ name: "Home" }] } },
    });
  });

  it("rejects malformed coordinates without invoking a provider", async () => {
    const result = await invoke(runtime, {
      action: "save",
      latitude: 91,
      longitude: 1,
      name: "Impossible",
    });
    expect(result).toMatchObject({
      success: false,
      data: { error: "MAPS_INVALID_INPUT" },
    });
  });

  it("persists saved places with concurrent idempotent replay and owner scoping", async () => {
    const request = {
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
      place: home,
      label: "My place",
      idempotencyKey: "save-home-once",
    };
    const [first, second] = await Promise.all([
      service.savePlace(request),
      service.savePlace(request),
    ]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.savedPlace.id).toBe(second.savedPlace.id);
    expect(await service.listSavedPlaces(OWNER_ID)).toHaveLength(1);
    expect(await service.listSavedPlaces(OTHER_OWNER_ID)).toEqual([]);

    const other = await service.savePlace({
      ...request,
      ownerEntityId: OTHER_OWNER_ID,
    });
    expect(other.savedPlace.id).not.toBe(first.savedPlace.id);
    expect(await service.listSavedPlaces(OTHER_OWNER_ID)).toHaveLength(1);
  });

  it("emits applied then replayed save receipts bound to user-facing text", async () => {
    const options = {
      parameters: {
        action: "save",
        placeId: "home-1",
        label: "Home base",
        idempotencyKey: "action-save-home",
      },
    };
    const first = await invoke(runtime, options.parameters);
    const replay = await invoke(runtime, options.parameters);
    expect(first.effectReceipts?.[0]).toMatchObject({ outcome: "applied" });
    expect(replay.effectReceipts?.[0]).toMatchObject({
      outcome: "noop",
      idempotency: { replayed: true, key: "action-save-home" },
    });
    expect(first.userFacingEffectReceiptIds).toEqual([
      first.effectReceipts?.[0]?.receiptId,
    ]);
  });

  it("rejects reuse of one idempotency key for a different place", async () => {
    await service.savePlace({
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
      place: home,
      idempotencyKey: "same-key",
    });
    await expect(
      service.savePlace({
        ownerEntityId: OWNER_ID,
        roomId: ROOM_ID,
        place: office,
        idempotencyKey: "same-key",
      }),
    ).rejects.toMatchObject({ code: "MAPS_INVALID_INPUT" });
    expect(await service.listSavedPlaces(OWNER_ID)).toHaveLength(1);
  });

  it("plans routes and produces non-effectful geo share/navigation handoffs", async () => {
    const route = await invoke(runtime, {
      action: "route",
      originPlaceId: "home-1",
      destinationPlaceId: "office-1",
      travelMode: "walk",
    });
    expect(route).toMatchObject({
      success: true,
      data: { route: { routeId: "route-1", travelMode: "walk" } },
    });

    const share = await invoke(runtime, { action: "share", placeId: "home-1" });
    const navigate = await invoke(runtime, {
      action: "navigate",
      placeId: "office-1",
    });
    expect(share).toMatchObject({
      success: true,
      data: { handoff: { kind: "share" } },
    });
    expect(navigate).toMatchObject({
      success: true,
      data: { handoff: { kind: "navigate" } },
    });
    const shareHandoff = share.data?.handoff as { uri?: unknown } | undefined;
    expect(shareHandoff?.uri).toMatch(/^geo:/);
    expect(share.effectReceipts).toBeUndefined();
  });
});
