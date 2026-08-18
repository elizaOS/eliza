/**
 * Proves saved-place CAS idempotency through a real AgentRuntime and PGlite.
 * Two independent service instances race the canonical document store, and
 * the persisted resource plus immutable operation ledger are inspected.
 */

import {
  createTestRuntime,
  type TestRuntimeResult,
} from "@elizaos/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MapsService } from "../src/service.js";

const OWNER_ID = "22222222-2222-4222-a222-222222222222";
const ROOM_ID = "44444444-4444-4444-a444-444444444444";
const place = {
  provider: "contract-maps",
  providerPlaceId: "pglite-place-1",
  name: "PGlite Park",
  coordinates: { latitude: 37.77, longitude: -122.42 },
  categories: ["park"],
};

describe("saved-place durable CAS on PGlite", () => {
  let harness: TestRuntimeResult;

  beforeAll(async () => {
    harness = await createTestRuntime({ characterName: "Maps CAS Test" });
  }, 180_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  it("commits one mutation and replays the competing service instance", async () => {
    const firstService = new MapsService(harness.runtime);
    const secondService = new MapsService(harness.runtime);
    const request = {
      ownerEntityId: OWNER_ID,
      roomId: ROOM_ID,
      place,
      label: "Durable park",
      idempotencyKey: "pglite-race-one",
    };
    const results = await Promise.all([
      firstService.savePlace(request),
      secondService.savePlace(request),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(new Set(results.map((result) => result.commitId)).size).toBe(1);
    expect(new Set(results.map((result) => result.committedAt)).size).toBe(1);
    expect(await firstService.listSavedPlaces(OWNER_ID)).toHaveLength(1);

    const documents = await harness.runtime.getMemories({
      tableName: "documents",
      agentId: harness.runtime.agentId,
      metadata: { source: "plugin-maps.saved-place-state.v1" },
      limit: 10,
    });
    expect(documents).toHaveLength(1);
    expect(documents[0]?.metadata).toMatchObject({
      mapsSavedPlaceState: {
        revision: 0,
        savedPlaces: [{ label: "Durable park" }],
        operations: [
          {
            idempotencyKey: "pglite-race-one",
            mutationId: results[0]?.commitId,
          },
        ],
      },
    });
  });
});
