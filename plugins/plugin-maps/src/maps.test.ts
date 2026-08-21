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
  stringToUuid,
  tagsRequireEffectReceipts,
  type UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapsAction } from "./action.js";
import { JsonMapsHttpAdapter, type MapsProviderAdapter } from "./adapter.js";
import { MapsError } from "./errors.js";
import { mapsPlugin } from "./plugin.js";
import { MAPS_SERVICE_TYPE, MapsService } from "./service.js";
import {
  MAX_SAVED_PLACE_OPERATIONS_PER_OWNER,
  MAX_SAVED_PLACE_STATE_BYTES,
  MAX_SAVED_PLACES_PER_OWNER,
} from "./store.js";
import { MAX_MAPS_PROVIDER_ID_LENGTH, MAX_MAPS_PROVIDERS } from "./types.js";

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
      data: { error: "MAPS_INVALID_INPUT", retryable: false },
    });
  });

  it("marks transient provider failures retryable for the planner", async () => {
    const limitedService = new MapsService(runtime);
    limitedService.registerAdapter(
      {
        ...adapter,
        async searchPlaces() {
          throw new MapsError("The maps provider is rate limited.", {
            code: "MAPS_RATE_LIMITED",
            retryAfterMs: 2_000,
          });
        },
      },
      true,
    );
    vi.spyOn(runtime, "getService").mockImplementation((serviceType) =>
      serviceType === MAPS_SERVICE_TYPE ? limitedService : null,
    );

    await expect(
      invoke(runtime, { action: "place", query: "home" }),
    ).resolves.toMatchObject({
      success: false,
      data: {
        error: "MAPS_RATE_LIMITED",
        retryable: true,
        retry: { retryable: true, retryAfterMs: 2_000 },
      },
    });
  });

  it("rejects partial coordinates and cannot relabel direct coordinates", async () => {
    await expect(
      invoke(runtime, { action: "save", latitude: 34, name: "Partial" }),
    ).resolves.toMatchObject({
      success: false,
      data: { error: "MAPS_INVALID_INPUT" },
    });
    const result = await invoke(runtime, {
      action: "save",
      latitude: 34,
      longitude: -118,
      name: "Pinned coordinate",
      provider: "contract-maps",
    });
    expect(result.data?.savedPlace).toMatchObject({
      place: {
        provider: "coordinates",
        providerPlaceId: "coordinates:34,-118",
      },
    });
  });

  it("preserves opaque place ids and cursors and rejects invalid adapters", async () => {
    const getPlace = vi.fn(async () => home);
    const searchPlaces = vi.fn(async () => ({
      places: [home],
      nextCursor: null,
    }));
    const opaqueService = new MapsService(runtime);
    opaqueService.registerAdapter({ ...adapter, getPlace, searchPlaces }, true);
    await opaqueService.getPlace("  opaque id  ");
    await opaqueService.searchPlaces({ query: "home", cursor: "  cursor  " });
    expect(getPlace).toHaveBeenCalledWith("  opaque id  ");
    expect(searchPlaces).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "  cursor  " }),
    );
    expect(() =>
      opaqueService.registerAdapter({ ...adapter, id: " invalid " }),
    ).toThrow(expect.objectContaining({ code: "MAPS_INVALID_INPUT" }));
    expect(() =>
      opaqueService.registerAdapter({ ...adapter, attribution: " " }),
    ).toThrow(expect.objectContaining({ code: "MAPS_INVALID_INPUT" }));
    expect(opaqueService.describeProviders()).toEqual([
      {
        id: adapter.id,
        attribution: null,
      },
    ]);
  });

  it("snapshots normalized legal attribution at adapter registration", () => {
    const mutableAdapter = {
      ...adapter,
      attribution: "  Map data © Contract Maps  ",
    };
    const attributionService = new MapsService(runtime);
    attributionService.registerAdapter(mutableAdapter, true);

    mutableAdapter.attribution = "x".repeat(501);
    const description = attributionService.describeProviders();
    expect(description).toEqual([
      {
        id: adapter.id,
        attribution: "Map data © Contract Maps",
      },
    ]);

    (description[0] as { attribution: string | null }).attribution =
      "caller mutation";
    expect(attributionService.describeProviders()[0]?.attribution).toBe(
      "Map data © Contract Maps",
    );

    attributionService.registerAdapter({
      ...adapter,
      attribution: "Updated legal notice",
    });
    expect(attributionService.describeProviders()[0]?.attribution).toBe(
      "Updated legal notice",
    );
  });

  it("keeps registration unlimited but bounds the describeProviders DTO", () => {
    const boundedService = new MapsService(runtime);
    expect(() =>
      boundedService.registerAdapter({
        ...adapter,
        id: "x".repeat(MAX_MAPS_PROVIDER_ID_LENGTH + 1),
      }),
    ).toThrow(expect.objectContaining({ code: "MAPS_INVALID_INPUT" }));

    for (let index = 0; index < MAX_MAPS_PROVIDERS; index += 1) {
      boundedService.registerAdapter({
        ...adapter,
        id: `provider_${index}`,
        connectionId: `conn_${String(index).padStart(16, "0")}`,
      });
    }
    expect(boundedService.describeProviders()).toHaveLength(MAX_MAPS_PROVIDERS);

    // Registration itself has no cap: the 33rd adapter registers successfully
    // and remains reachable for search/route/save; only the browser-facing
    // describeProviders() DTO is bounded, at the describe boundary.
    expect(() =>
      boundedService.registerAdapter({
        ...adapter,
        id: "one_provider_too_many",
        connectionId: "conn_overflow00000000",
      }),
    ).not.toThrow();
    expect(boundedService.listAdapters()).toHaveLength(MAX_MAPS_PROVIDERS + 1);
    expect(boundedService.describeProviders()).toHaveLength(MAX_MAPS_PROVIDERS);
    expect(
      boundedService
        .describeProviders()
        .some((provider) => provider.id === "one_provider_too_many"),
    ).toBe(false);

    boundedService.registerAdapter({
      ...adapter,
      id: "provider_0",
      connectionId: "conn_replacement000000",
      attribution: "Replacement attribution",
    });
    expect(boundedService.describeProviders()[0]).toEqual({
      id: "provider_0",
      attribution: "Replacement attribution",
    });
  });

  it("validates public store UUIDs before creating persistence namespaces", async () => {
    const ensureWorld = vi.spyOn(runtime, "ensureWorldExists");
    await expect(service.listSavedPlaces("not-a-uuid")).rejects.toMatchObject({
      code: "MAPS_INVALID_INPUT",
    });
    await expect(
      service.savePlace({
        ownerEntityId: OWNER_ID,
        roomId: "not-a-uuid",
        place: home,
      }),
    ).rejects.toMatchObject({ code: "MAPS_INVALID_INPUT" });
    expect(ensureWorld).not.toHaveBeenCalled();
  });

  it("accepts deterministic elizaOS IDs for scenario-owned saved places", async () => {
    const ownerEntityId = stringToUuid("scenario-account:maps-owner");
    const saved = await service.savePlace({
      ownerEntityId,
      roomId: ROOM_ID,
      place: home,
      idempotencyKey: "scenario-owner-save",
    });

    expect(saved.savedPlace.ownerEntityId).toBe(ownerEntityId);
    expect(await service.listSavedPlaces(ownerEntityId)).toEqual([
      saved.savedPlace,
    ]);
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

  it("enforces operation quotas while preserving replay at capacity", async () => {
    const request = {
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
      place: home,
      label: "Quota seed 0",
      idempotencyKey: "quota-op-0",
    };
    const first = await service.savePlace(request);
    for (
      let index = 1;
      index < MAX_SAVED_PLACE_OPERATIONS_PER_OWNER;
      index += 1
    ) {
      await service.savePlace({
        ...request,
        label: `Quota seed ${index}`,
        idempotencyKey: `quota-op-${index}`,
      });
    }
    await expect(service.savePlace(request)).resolves.toMatchObject({
      replayed: true,
      commitId: first.commitId,
    });
    await expect(
      service.savePlace({
        ...request,
        label: "Beyond operation quota",
        idempotencyKey: "quota-op-overflow",
      }),
    ).rejects.toMatchObject({ code: "MAPS_STORAGE_LIMIT" });
  });

  it("admits one final place under contention and rejects boundary plus one", async () => {
    const ownerEntityId = "66666666-6666-4666-a666-666666666666";
    for (let index = 0; index < MAX_SAVED_PLACES_PER_OWNER - 1; index += 1) {
      await service.savePlace({
        ownerEntityId,
        roomId: ROOM_ID,
        place: { ...home, providerPlaceId: `quota-place-${index}` },
        idempotencyKey: `quota-place-key-${index}`,
      });
    }
    const attempts = Array.from({ length: 8 }, (_, index) =>
      new MapsService(runtime).savePlace({
        ownerEntityId,
        roomId: ROOM_ID,
        place: { ...home, providerPlaceId: `contended-place-${index}` },
        idempotencyKey: `contended-place-key-${index}`,
      }),
    );
    const settled = await Promise.allSettled(attempts);
    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      settled
        .filter((result) => result.status === "rejected")
        .every((result) => result.reason?.code === "MAPS_STORAGE_LIMIT"),
    ).toBe(true);
    expect(await service.listSavedPlaces(ownerEntityId)).toHaveLength(
      MAX_SAVED_PLACES_PER_OWNER,
    );
  });

  it("rejects a large valid mutation before the serialized byte ceiling", async () => {
    const ownerEntityId = "77777777-7777-4777-a777-777777777777";
    const largePlace = {
      ...home,
      name: "N".repeat(300),
      formattedAddress: "A".repeat(1_000),
      categories: Array.from({ length: 32 }, (_, index) =>
        `${index}`.padEnd(80, "c"),
      ),
    };
    let accepted = 0;
    for (
      let index = 0;
      index < MAX_SAVED_PLACE_OPERATIONS_PER_OWNER;
      index += 1
    ) {
      try {
        await service.savePlace({
          ownerEntityId,
          roomId: ROOM_ID,
          place: largePlace,
          label: `Large ${index}`,
          idempotencyKey: `large-key-${index}`,
        });
        accepted += 1;
      } catch (error) {
        expect(error).toMatchObject({ code: "MAPS_STORAGE_LIMIT" });
        break;
      }
    }
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(MAX_SAVED_PLACE_OPERATIONS_PER_OWNER);
    const matching = (
      await runtime.getMemories({
        tableName: "documents",
        agentId: runtime.agentId,
        metadata: { source: "plugin-maps.saved-place-state.v1" },
        limit: 20,
      })
    ).find((entry) => JSON.stringify(entry.metadata).includes(ownerEntityId));
    expect(matching).toBeDefined();
    const state = (matching?.metadata as Record<string, unknown> | undefined)
      ?.mapsSavedPlaceState;
    expect(
      new TextEncoder().encode(JSON.stringify(state)).byteLength,
    ).toBeLessThanOrEqual(MAX_SAVED_PLACE_STATE_BYTES);
    await expect(
      service.savePlace({
        ownerEntityId,
        roomId: ROOM_ID,
        place: largePlace,
        label: "Large 0",
        idempotencyKey: "large-key-0",
      }),
    ).resolves.toMatchObject({ replayed: true });
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
        origin: {
          ...coordinateOrigin,
          provider: adapter.id,
          providerPlaceId: "different-place",
          coordinateBinding: {
            provider: "coordinates" as const,
            providerPlaceId: coordinateOrigin.providerPlaceId,
            coordinates: coordinateOrigin.coordinates,
          },
          coordinates: { ...coordinateOrigin.coordinates, longitude: -73 },
        },
        destination: coordinateDestination,
      },
      {
        origin: {
          ...coordinateOrigin,
          provider: adapter.id,
          providerPlaceId: "different-place",
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

    const canonicalOrigin = {
      ...coordinateOrigin,
      provider: adapter.id,
      providerPlaceId: "canonical-origin",
      coordinateBinding: {
        provider: "coordinates" as const,
        providerPlaceId: coordinateOrigin.providerPlaceId,
        coordinates: coordinateOrigin.coordinates,
      },
    };
    const canonicalDestination = {
      ...coordinateDestination,
      provider: adapter.id,
      providerPlaceId: "canonical-destination",
      coordinateBinding: {
        provider: "coordinates" as const,
        providerPlaceId: coordinateDestination.providerPlaceId,
        coordinates: coordinateDestination.coordinates,
      },
    };
    const canonicalizingService = new MapsService(runtime);
    canonicalizingService.registerAdapter(
      {
        ...adapter,
        async planRoute(request) {
          return {
            provider: adapter.id,
            routeId: "canonical-route",
            ...request,
            origin: canonicalOrigin,
            destination: canonicalDestination,
            distanceMeters: 100,
            durationSeconds: 10,
            warnings: [],
          };
        },
      },
      true,
    );
    await expect(
      canonicalizingService.planRoute({
        origin: coordinateOrigin,
        destination: coordinateDestination,
        travelMode: "drive",
      }),
    ).resolves.toMatchObject({
      origin: { providerPlaceId: "canonical-origin" },
      destination: { providerPlaceId: "canonical-destination" },
    });
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
