/** Tests real maps service/action behavior over the in-memory runtime database adapter. */

import {
  type ActionParameters,
  AgentRuntime,
  type Content,
  createCharacter,
  InMemoryDatabaseAdapter,
  isPromotedSubactionVirtual,
  type Memory,
  normalizeEffectReceipts,
  tagsRequireEffectReceipts,
  type UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapsAction } from "./action.js";
import { JsonMapsHttpAdapter, type MapsProviderAdapter } from "./adapter.js";
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
  const selected =
    parameters.action === "save"
      ? mapsPlugin.actions?.find((action) => action.name === "MAPS_SAVE")
      : mapsAction;
  if (!selected) throw new Error("MAPS action is not registered");
  const actionResult = await selected.handler(
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
    const actions = new Map(
      mapsPlugin.actions?.map((action) => [action.name, action]) ?? [],
    );
    expect(actions.get("MAPS_SAVE")?.tags).toEqual(
      expect.arrayContaining([
        "capability:write",
        "effect:idempotent",
        "effect:receipt-required",
      ]),
    );
    expect(tagsRequireEffectReceipts(actions.get("MAPS_SAVE")?.tags)).toBe(
      true,
    );
    for (const name of [
      "MAPS_PLACE",
      "MAPS_ROUTE",
      "MAPS_SHARE",
      "MAPS_NAVIGATE",
    ]) {
      const action = actions.get(name);
      if (!action) throw new Error(`${name} is not registered`);
      expect(action.tags).toContain("capability:read");
      expect(action.tags).not.toContain("capability:write");
      expect(action.tags).not.toContain("effect:idempotent");
      expect(isPromotedSubactionVirtual(action)).toBe(true);
    }
    const saveAction = actions.get("MAPS_SAVE");
    if (!saveAction) throw new Error("MAPS_SAVE is not registered");
    expect(isPromotedSubactionVirtual(saveAction)).toBe(true);
  });

  it("keeps direct umbrella execution read-only", async () => {
    for (const action of ["save", "SAVE", " save "]) {
      const direct = await mapsAction.handler(runtime, message(), undefined, {
        parameters: { action, placeId: "home-1" },
      });
      expect(direct).toMatchObject({
        success: false,
        error: "MAPS_SAVE_REQUIRED",
      });
    }
    expect(await service.listSavedPlaces(OWNER_ID)).toEqual([]);
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
    const secondService = new MapsService(runtime);
    secondService.registerAdapter(adapter, true);
    const [first, second] = await Promise.all([
      service.savePlace(request),
      secondService.savePlace(request),
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
    const secondReplay = await invoke(runtime, options.parameters);
    expect(first.effectReceipts?.[0]).toMatchObject({ outcome: "applied" });
    expect(replay.effectReceipts?.[0]).toMatchObject({
      outcome: "noop",
      idempotency: { replayed: true, key: "action-save-home" },
    });
    expect(first.userFacingEffectReceiptIds).toEqual([
      first.effectReceipts?.[0]?.receiptId,
    ]);
    expect(replay.effectReceipts?.[0]?.observedAt).not.toBe(
      first.effectReceipts?.[0]?.observedAt,
    );
    expect(replay.data?.committedAt).toBe(first.data?.committedAt);
    expect(replay.data?.commitId).toBe(first.data?.commitId);
    expect(secondReplay.effectReceipts?.[0]).toMatchObject({
      outcome: "noop",
      idempotency: { replayed: true, key: "action-save-home" },
    });
    expect(secondReplay.effectReceipts?.[0]?.receiptId).not.toBe(
      replay.effectReceipts?.[0]?.receiptId,
    );
    expect(() =>
      normalizeEffectReceipts([
        ...(first.effectReceipts ?? []),
        ...(replay.effectReceipts ?? []),
        ...(secondReplay.effectReceipts ?? []),
      ]),
    ).not.toThrow();
  });

  it("settles the promoted MAPS_SAVE action through the runtime receipt boundary", async () => {
    const saveAction = mapsPlugin.actions?.find(
      (action) => action.name === "MAPS_SAVE",
    );
    if (!saveAction) throw new Error("MAPS_SAVE is not registered");
    const priorMode = saveAction.mode;
    saveAction.mode = "ALWAYS_AFTER";
    runtime.actions.length = 0;
    runtime.actions.push(saveAction);
    const callback = vi.fn(async (_content: Content) => []);
    const saveMessage = {
      ...message(),
      content: {
        text: "save home",
        placeId: "home-1",
        label: "Settled home",
        idempotencyKey: "settlement-save-home",
      },
    };
    try {
      await runtime.runActionsByMode("ALWAYS_AFTER", saveMessage, {} as never, {
        callback,
      });
      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0]?.[0]).toMatchObject({
        text: "Saved Settled home.",
        effectReceiptIds: [expect.stringMatching(/^maps:save:/)],
      });

      callback.mockClear();
      await runtime.runActionsByMode("ALWAYS_AFTER", saveMessage, {} as never, {
        callback,
      });
      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0]?.[0]).toMatchObject({
        text: "Settled home was already saved.",
        effectReceiptIds: [expect.stringMatching(/:replay:[0-9a-f-]+$/)],
      });

      callback.mockClear();
      await runtime.runActionsByMode(
        "ALWAYS_AFTER",
        { ...message(), content: { text: "save somewhere" } },
        {} as never,
        { callback },
      );
      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0]?.[0]).toMatchObject({
        text: expect.stringContaining("Which place should I save?"),
      });
      expect(callback.mock.calls[0]?.[0]).not.toHaveProperty(
        "effectReceiptIds",
      );

      callback.mockClear();
      await runtime.runActionsByMode(
        "ALWAYS_AFTER",
        {
          ...message(),
          content: {
            text: "save impossible",
            name: "Impossible",
            latitude: 91,
            longitude: 0,
          },
        },
        {} as never,
        { callback },
      );
      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0]?.[0]).toMatchObject({
        text: expect.stringContaining("Coordinates are outside"),
      });
      expect(callback.mock.calls[0]?.[0]).not.toHaveProperty(
        "effectReceiptIds",
      );
    } finally {
      saveAction.mode = priorMode;
    }
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

  it("preserves key history and unique commit receipts across label updates", async () => {
    const first = await service.savePlace({
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
      place: home,
      label: "Home A",
      idempotencyKey: "key-a",
    });
    const second = await service.savePlace({
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
      place: home,
      label: "Home B",
      idempotencyKey: "key-b",
    });
    const restarted = new MapsService(runtime);
    restarted.registerAdapter(adapter, true);
    const replayA = await restarted.savePlace({
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
      place: home,
      label: "Home A",
      idempotencyKey: "key-a",
    });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
    expect(replayA).toMatchObject({
      replayed: true,
      currentlyApplied: false,
      commitId: first.commitId,
      committedAt: first.committedAt,
      savedPlace: { label: "Home A" },
    });
    expect(second.commitId).not.toBe(first.commitId);
    expect(second.committedAt).not.toBe(first.committedAt);
    expect(await service.listSavedPlaces(OWNER_ID)).toMatchObject([
      { label: "Home B" },
    ]);

    const staleAction = await invoke(runtime, {
      action: "save",
      placeId: "home-1",
      label: "Home A",
      idempotencyKey: "key-a",
    });
    expect(staleAction).toMatchObject({
      success: false,
      error: "MAPS_IDEMPOTENCY_SUPERSEDED",
      data: {
        replayed: true,
        currentlyApplied: false,
        currentSavedPlace: { label: "Home B" },
      },
    });
    expect(staleAction.effectReceipts).toBeUndefined();
    expect(staleAction.userFacingText).toContain(
      "current saved label is Home B",
    );

    const actionA = await invoke(runtime, {
      action: "save",
      placeId: "home-1",
      label: "Action A",
      idempotencyKey: "receipt-a",
    });
    const actionB = await invoke(runtime, {
      action: "save",
      placeId: "home-1",
      label: "Action B",
      idempotencyKey: "receipt-b",
    });
    const normalized = normalizeEffectReceipts([
      ...(actionA.effectReceipts ?? []),
      ...(actionB.effectReceipts ?? []),
    ]);
    expect(normalized).toHaveLength(2);
    expect(new Set(normalized.map((receipt) => receipt.receiptId)).size).toBe(
      2,
    );
    expect(
      new Set(
        normalized.map((receipt) =>
          receipt.outcome === "applied" ? receipt.commit.id : "",
        ),
      ).size,
    ).toBe(2);
  });

  it("requests only unresolved route endpoints and keeps drive optional", async () => {
    const missingDestination = await invoke(runtime, {
      action: "route",
      originPlaceId: "home-1",
    });
    expect(missingDestination.data).toMatchObject({
      missingFields: ["destinationPlaceId"],
      uiRequest: { fields: [{ name: "destinationPlaceId", required: true }] },
    });
    const missingOrigin = await invoke(runtime, {
      action: "route",
      destinationPlaceId: "office-1",
    });
    expect(missingOrigin.data).toMatchObject({
      missingFields: ["originPlaceId"],
      uiRequest: { fields: [{ name: "originPlaceId", required: true }] },
    });
  });

  it("rejects provider spoofing and mixed-provider route endpoints", async () => {
    const spoofingAdapter: MapsProviderAdapter = {
      ...adapter,
      id: "provider-a",
      async searchPlaces() {
        return {
          places: [{ ...home, provider: "provider-b" }],
          nextCursor: null,
        };
      },
    };
    const spoofService = new MapsService(runtime);
    spoofService.registerAdapter(spoofingAdapter, true);
    await expect(
      spoofService.searchPlaces({ query: "park" }),
    ).rejects.toMatchObject({
      code: "MAPS_MALFORMED_RESPONSE",
    });

    await expect(
      service.planRoute({
        origin: home,
        destination: { ...office, provider: "other-provider" },
        travelMode: "drive",
      }),
    ).rejects.toMatchObject({ code: "MAPS_INVALID_INPUT" });
  });

  it("rejects coordinate endpoint substitution in service and HTTP adapter", async () => {
    const coordinateOrigin = {
      ...home,
      provider: "coordinates",
      providerPlaceId: "coordinates:34.05,-118.24",
    };
    const coordinateDestination = {
      ...office,
      provider: "coordinates",
      providerPlaceId: "coordinates:34.06,-118.25",
    };
    const substitutions = [
      {
        origin: {
          ...coordinateOrigin,
          coordinates: { ...coordinateOrigin.coordinates, latitude: 35.05 },
        },
        destination: coordinateDestination,
      },
      {
        origin: coordinateOrigin,
        destination: {
          ...coordinateDestination,
          providerPlaceId: "coordinates:substituted",
        },
      },
    ];

    for (const substituted of substitutions) {
      const substitutingAdapter: MapsProviderAdapter = {
        ...adapter,
        async planRoute(request) {
          return {
            provider: adapter.id,
            routeId: "substituted-route",
            ...request,
            ...substituted,
            distanceMeters: 100,
            durationSeconds: 10,
            warnings: [],
          };
        },
      };
      const substitutingService = new MapsService(runtime);
      substitutingService.registerAdapter(substitutingAdapter, true);
      await expect(
        substitutingService.planRoute({
          origin: coordinateOrigin,
          destination: coordinateDestination,
          travelMode: "drive",
        }),
      ).rejects.toMatchObject({ code: "MAPS_MALFORMED_RESPONSE" });

      const httpAdapter = new JsonMapsHttpAdapter({
        id: "contract-maps",
        connectionId: "conn_coordinate_binding_123",
        baseUrl: "https://coordinate-binding.example.test",
        testTransport: {
          fetchImpl: vi.fn(async () =>
            Response.json({
              provider: "contract-maps",
              routeId: "substituted-route",
              ...substituted,
              travelMode: "drive",
              distanceMeters: 100,
              durationSeconds: 10,
              warnings: [],
            }),
          ),
        },
      });
      await expect(
        httpAdapter.planRoute({
          origin: coordinateOrigin,
          destination: coordinateDestination,
          travelMode: "drive",
        }),
      ).rejects.toMatchObject({ code: "MAPS_MALFORMED_RESPONSE" });
    }
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
    const coordinateRoute = await invoke(runtime, {
      action: "route",
      originName: "Coordinate origin",
      originLatitude: 34.05,
      originLongitude: -118.24,
      destinationName: "Coordinate destination",
      destinationLatitude: 34.06,
      destinationLongitude: -118.25,
    });
    expect(coordinateRoute).toMatchObject({
      success: true,
      data: {
        route: {
          provider: "contract-maps",
          origin: { provider: "coordinates" },
          destination: { provider: "coordinates" },
        },
      },
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
