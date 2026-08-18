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
const CAS_OWNER_ID = "33333333-3333-4333-a333-333333333333";
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
    const originalGetDocument = harness.runtime.adapter.getDocument.bind(
      harness.runtime.adapter,
    );
    let initialReads = 0;
    let releaseInitialReads: (() => void) | undefined;
    const bothInitialReads = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    harness.runtime.adapter.getDocument = async (params) => {
      const document = await originalGetDocument(params);
      if (document === null && initialReads < 2) {
        initialReads += 1;
        if (initialReads === 2) releaseInitialReads?.();
        await bothInitialReads;
      }
      return document;
    };
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
    ]).finally(() => {
      harness.runtime.adapter.getDocument = originalGetDocument;
    });
    expect(initialReads).toBe(2);
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

  it("retries a conflicting update and retains both immutable mutations", async () => {
    const seedService = new MapsService(harness.runtime);
    await seedService.savePlace({
      ownerEntityId: CAS_OWNER_ID,
      roomId: ROOM_ID,
      place,
      label: "Seed park",
      idempotencyKey: "pglite-cas-seed",
    });

    const originalGetDocument = harness.runtime.adapter.getDocument.bind(
      harness.runtime.adapter,
    );
    const originalCompareAndSwap =
      harness.runtime.adapter.compareAndSwapDocument.bind(
        harness.runtime.adapter,
      );
    let competingReads = 0;
    let releaseReads: (() => void) | undefined;
    const bothReadSeedRevision = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const casStatuses: string[] = [];
    harness.runtime.adapter.getDocument = async (params) => {
      const document = await originalGetDocument(params);
      const state = (document?.metadata as Record<string, unknown> | undefined)
        ?.mapsSavedPlaceState as
        | { ownerEntityId?: unknown; revision?: unknown }
        | undefined;
      if (
        state?.ownerEntityId === CAS_OWNER_ID &&
        state.revision === 0 &&
        competingReads < 2
      ) {
        competingReads += 1;
        if (competingReads === 2) releaseReads?.();
        await bothReadSeedRevision;
      }
      return document;
    };
    harness.runtime.adapter.compareAndSwapDocument = async (params) => {
      const result = await originalCompareAndSwap(params);
      casStatuses.push(result.status);
      return result;
    };

    const firstService = new MapsService(harness.runtime);
    const secondService = new MapsService(harness.runtime);
    const secondPlace = {
      ...place,
      providerPlaceId: "pglite-place-2",
      name: "PGlite Library",
    };
    try {
      const results = await Promise.all([
        firstService.savePlace({
          ownerEntityId: CAS_OWNER_ID,
          roomId: ROOM_ID,
          place,
          label: "Updated park",
          idempotencyKey: "pglite-cas-update-a",
        }),
        secondService.savePlace({
          ownerEntityId: CAS_OWNER_ID,
          roomId: ROOM_ID,
          place: secondPlace,
          label: "Durable library",
          idempotencyKey: "pglite-cas-update-b",
        }),
      ]);
      expect(results.every((result) => !result.replayed)).toBe(true);
    } finally {
      harness.runtime.adapter.getDocument = originalGetDocument;
      harness.runtime.adapter.compareAndSwapDocument = originalCompareAndSwap;
    }

    expect(competingReads).toBe(2);
    expect(casStatuses).toContain("conflict");
    expect(casStatuses.filter((status) => status === "updated")).toHaveLength(
      2,
    );
    expect(await firstService.listSavedPlaces(CAS_OWNER_ID)).toMatchObject([
      { label: "Updated park" },
      { label: "Durable library" },
    ]);

    const documents = await harness.runtime.getMemories({
      tableName: "documents",
      agentId: harness.runtime.agentId,
      metadata: { source: "plugin-maps.saved-place-state.v1" },
      limit: 10,
    });
    const state = documents
      .map(
        (document) =>
          (document.metadata as Record<string, unknown> | undefined)
            ?.mapsSavedPlaceState,
      )
      .find(
        (candidate) =>
          (candidate as { ownerEntityId?: unknown } | undefined)
            ?.ownerEntityId === CAS_OWNER_ID,
      ) as
      | {
          revision: number;
          operations: Array<{ idempotencyKey: string }>;
        }
      | undefined;
    expect(state?.revision).toBe(2);
    expect(
      state?.operations.map((operation) => operation.idempotencyKey),
    ).toEqual(
      expect.arrayContaining([
        "pglite-cas-seed",
        "pglite-cas-update-a",
        "pglite-cas-update-b",
      ]),
    );
    expect(state?.operations).toHaveLength(3);
  });
});
