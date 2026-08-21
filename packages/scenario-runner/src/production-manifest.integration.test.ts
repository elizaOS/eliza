/**
 * Exercises production-manifest apply/readback/reset against the scenario
 * runner's real AgentRuntime and PGlite adapter. Adversarial cases verify
 * compensation, strict serialized receipts, and reset isolation without
 * replacing the stores under test.
 */
import { ChannelType, stringToUuid, type UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyProductionManifest,
  type ProductionManifestApplyError,
  type ProductionManifestReceipt,
  type ProductionManifestV1,
  parseProductionManifest,
  parseProductionManifestReceipt,
  proveProductionManifestReset,
  readProductionManifestSnapshot,
  resetProductionManifest,
  serializeProductionManifestArtifact,
} from "./production-manifest.ts";
import {
  createScenarioRuntime,
  type RuntimeFactoryResult,
} from "./runtime-factory.ts";

describe("production manifest persistence", () => {
  let runtimeResult: RuntimeFactoryResult | undefined;

  beforeAll(async () => {
    runtimeResult = await createScenarioRuntime({
      useDeterministicModel: true,
    });
  }, 120_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  }, 120_000);

  function runtime() {
    if (!runtimeResult) throw new Error("scenario runtime was not created");
    return runtimeResult.runtime;
  }

  function manifest(namespace: string): ProductionManifestV1 {
    return {
      version: 1,
      namespace,
      ownerAgentId: runtime().agentId,
      entities: [
        { id: "owner", names: ["Casey"], metadata: { role: "owner" } },
        { id: "teammate", names: ["Riley"] },
      ],
      rooms: [
        {
          id: "planning",
          name: "Planning",
          source: "scenario",
          type: ChannelType.GROUP,
          participantEntityIds: ["owner", "teammate"],
        },
      ],
      memories: [
        {
          id: "message-1",
          roomId: "planning",
          entityId: "owner",
          text: "Ship the deterministic environment.",
          metadata: { source: "seed" },
        },
      ],
      relationships: [
        {
          id: "team-link",
          sourceEntityId: "owner",
          targetEntityId: "teammate",
          tags: ["teammate"],
        },
      ],
      tasks: [
        {
          id: "verification-task",
          name: "SCENARIO_MANIFEST_TEST_TASK",
          description: "Verify production readback",
          roomId: "planning",
          entityId: "owner",
          tags: ["scenario", "verification"],
          dueAt: 1_800_000_000_000,
          metadata: { priority: "high" },
        },
      ],
    };
  }

  it("applies, reads, resets, and reseeds with byte-equivalent canonical state", async () => {
    const artifact = await proveProductionManifestReset(
      runtime(),
      manifest("production-cycle"),
    );

    expect(artifact.byteEquivalent).toBe(true);
    expect(serializeProductionManifestArtifact(artifact.initial)).toBe(
      serializeProductionManifestArtifact(artifact.final),
    );
    expect(artifact.initial.rooms[0]?.participantEntityIds).toHaveLength(2);
    expect(artifact.initial.memories[0]?.text).toBe(
      "Ship the deterministic environment.",
    );
    expect(artifact.initial.tasks[0]?.name).toBe("SCENARIO_MANIFEST_TEST_TASK");
    expect(artifact.reset.absentAfterReset).toMatchObject({ world: true });

    await resetProductionManifest(runtime(), artifact.reseedReceipt);
  }, 120_000);

  it("accepts a JSON-round-tripped receipt as the complete reset authority", async () => {
    const receipt = await applyProductionManifest(
      runtime(),
      manifest("serialized-receipt"),
    );
    const restartedProcessReceipt = JSON.parse(
      JSON.stringify(receipt),
    ) as ProductionManifestReceipt;

    const before = await readProductionManifestSnapshot(
      runtime(),
      restartedProcessReceipt,
    );
    expect(before.namespace).toBe("serialized-receipt");
    await expect(
      resetProductionManifest(runtime(), {
        ...restartedProcessReceipt,
        namespace: "forged-namespace",
      }),
    ).rejects.toMatchObject({
      code: "SCENARIO_MANIFEST_RECEIPT_UNTRUSTED",
    });
    await expect(
      resetProductionManifest(runtime(), {
        ...restartedProcessReceipt,
        version: 2 as 1,
      }),
    ).rejects.toMatchObject({ code: "SCENARIO_MANIFEST_INVALID" });
    expect(() =>
      parseProductionManifestReceipt({
        ...restartedProcessReceipt,
        unexpected: true,
      }),
    ).toThrow(/unexpected.*not supported/);
    expect(() =>
      parseProductionManifestReceipt({
        ...restartedProcessReceipt,
        manifestSha256: "not-a-hash",
      }),
    ).toThrow(/64-character hexadecimal hash/);
    expect(() =>
      parseProductionManifestReceipt({
        ...restartedProcessReceipt,
        worldId: "not-a-uuid",
      }),
    ).toThrow(/worldId.*must be a UUID/);
    expect(() =>
      parseProductionManifestReceipt({
        ...restartedProcessReceipt,
        entityIds: [
          restartedProcessReceipt.entityIds[0],
          restartedProcessReceipt.entityIds[0],
        ],
      }),
    ).toThrow(/duplicates UUID/);
    expect(() =>
      parseProductionManifestReceipt({
        ...restartedProcessReceipt,
        entityIds: "not-an-array",
      }),
    ).toThrow(/entityIds.*must be an array/);
    const decoratedEntityIds = [
      ...restartedProcessReceipt.entityIds,
    ] as UUID[] & {
      ignored?: string;
    };
    decoratedEntityIds.ignored = "lossy";
    expect(() =>
      parseProductionManifestReceipt({
        ...restartedProcessReceipt,
        entityIds: decoratedEntityIds,
      }),
    ).toThrow(/non-index array properties/);
    expect(() =>
      parseProductionManifestReceipt({
        ...restartedProcessReceipt,
        entityIds: new Array(1),
      }),
    ).toThrow(/sparse array slot/);
    const { taskIds: _taskIds, ...missingTaskIds } = restartedProcessReceipt;
    expect(() => parseProductionManifestReceipt(missingTaskIds)).toThrow(
      /taskIds.*required/,
    );
    expect(() =>
      parseProductionManifestReceipt({
        ...restartedProcessReceipt,
        participantPairs: [
          {
            ...restartedProcessReceipt.participantPairs[0],
            unexpected: true,
          },
        ],
      }),
    ).toThrow(/unexpected.*not supported/);
    const reset = await resetProductionManifest(
      runtime(),
      restartedProcessReceipt,
    );
    expect(reset.absentAfterReset.memories).toEqual(receipt.memoryIds);
  }, 120_000);

  it("fails closed before writes for unsupported versions, duplicates, bad references, and wrong owners", async () => {
    const valid = manifest("invalid-inputs");
    expect(() => parseProductionManifest({ ...valid, version: 2 })).toThrow(
      /version.*must equal 1/,
    );
    for (const unsupported of [
      "schedules",
      "notifications",
      "approvals",
      "providerState",
    ]) {
      expect(() =>
        parseProductionManifest({ ...valid, [unsupported]: [] }),
      ).toThrow(new RegExp(`${unsupported}.*not supported`));
    }
    expect(() =>
      parseProductionManifest({
        ...valid,
        rooms: [...(valid.rooms ?? []), { ...(valid.rooms?.[0] ?? {}) }],
      }),
    ).toThrow(/duplicates/);
    expect(() =>
      parseProductionManifest({
        ...valid,
        rooms: [
          {
            ...(valid.rooms?.[0] ?? {}),
            participantEntityIds: ["owner", "owner"],
          },
        ],
      }),
    ).toThrow(/duplicates participant entity/);
    expect(() =>
      parseProductionManifest({
        ...valid,
        memories: [
          { ...(valid.memories?.[0] ?? {}), roomId: "wrong-owner-room" },
        ],
      }),
    ).toThrow(/references unknown room/);
    expect(() =>
      parseProductionManifest({
        ...valid,
        memories: [
          { ...(valid.memories?.[0] ?? {}), tableName: "provider_state" },
        ],
      }),
    ).toThrow(/tableName.*must equal messages/);
    for (const metadata of [
      { lossy: undefined },
      { lossy: () => "ignored" },
      { lossy: Number.NaN },
      { lossy: Number.POSITIVE_INFINITY },
    ]) {
      expect(() =>
        parseProductionManifest({
          ...valid,
          entities: [{ ...(valid.entities?.[0] ?? {}), metadata }],
          relationships: [],
          memories: [],
          tasks: [],
          rooms: [],
        }),
      ).toThrow(/metadata.*(non-JSON|finite)/);
    }
    const cyclicMetadata: Record<string, unknown> = {};
    cyclicMetadata.self = cyclicMetadata;
    expect(() =>
      parseProductionManifest({
        ...valid,
        entities: [
          { ...(valid.entities?.[0] ?? {}), metadata: cyclicMetadata },
        ],
        relationships: [],
        memories: [],
        tasks: [],
        rooms: [],
      }),
    ).toThrow(/metadata.*cycle/);
    const decoratedMetadataArray = ["kept"] as string[] & { ignored?: string };
    decoratedMetadataArray.ignored = "lossy";
    expect(() =>
      parseProductionManifest({
        ...valid,
        entities: [
          {
            ...(valid.entities?.[0] ?? {}),
            metadata: { decoratedMetadataArray },
          },
        ],
        relationships: [],
        memories: [],
        tasks: [],
        rooms: [],
      }),
    ).toThrow(/metadata.*non-index array properties/);
    await expect(
      applyProductionManifest(runtime(), {
        ...valid,
        ownerAgentId: "00000000-0000-0000-0000-000000000001" as UUID,
      }),
    ).rejects.toMatchObject({ code: "SCENARIO_MANIFEST_WRONG_OWNER" });

    const duplicateReceipt = await applyThenRejectDuplicate(runtime(), valid);
    const expectedWorldId = duplicateReceipt.worldId;
    await resetProductionManifest(runtime(), duplicateReceipt);
    expect(await runtime().getWorldsByIds([expectedWorldId])).toEqual([]);
  }, 120_000);

  it("compensates an apply failure and exposes no authoritative residue", async () => {
    const target = runtime();
    const originalCreateMemories = target.createMemories.bind(target);
    target.createMemories = async () => {
      throw new Error("injected persistence fault");
    };
    let failure: ProductionManifestApplyError | undefined;
    try {
      await applyProductionManifest(target, manifest("compensated-failure"));
    } catch (error) {
      failure = error as ProductionManifestApplyError;
    } finally {
      target.createMemories = originalCreateMemories;
    }
    expect(failure).toMatchObject({ code: "SCENARIO_MANIFEST_APPLY_FAILED" });

    const receipt = await applyProductionManifest(
      target,
      manifest("compensated-failure"),
    );
    await resetProductionManifest(target, receipt);
  }, 120_000);

  it("returns an explicit dirty receipt when a relationship write cannot be read back", async () => {
    const target = runtime();
    const originalReadback = target.getRelationshipsByPairs.bind(target);
    target.getRelationshipsByPairs = async (pairs) => pairs.map(() => null);
    let failure: ProductionManifestApplyError | undefined;
    try {
      await applyProductionManifest(target, manifest("ambiguous-relationship"));
    } catch (error) {
      failure = error as ProductionManifestApplyError;
    } finally {
      target.getRelationshipsByPairs = originalReadback;
    }

    expect(failure).toMatchObject({ code: "SCENARIO_MANIFEST_DIRTY" });
    expect(failure?.dirtyReceipt?.namespace).toBe("ambiguous-relationship");
    if (!failure?.dirtyReceipt)
      throw new Error("dirty receipt was not returned");
    await expect(
      resetProductionManifest(target, failure.dirtyReceipt),
    ).rejects.toMatchObject({ code: "SCENARIO_MANIFEST_RECEIPT_UNTRUSTED" });
  }, 120_000);

  it("resets a finalized receipt once and rejects replay without provenance", async () => {
    const receipt = await applyProductionManifest(
      runtime(),
      manifest("once-only-reset"),
    );
    const reset = await resetProductionManifest(runtime(), receipt);

    expect(reset.absentAfterReset.world).toBe(true);
    await expect(
      resetProductionManifest(runtime(), receipt),
    ).rejects.toMatchObject({
      code: "SCENARIO_MANIFEST_RECEIPT_UNTRUSTED",
    });
    expect(await runtime().getWorldsByIds([receipt.worldId])).toEqual([]);
    expect(await runtime().getEntitiesByIds(receipt.entityIds)).toEqual([]);
    expect(await runtime().getRoomsByIds(receipt.roomIds)).toEqual([]);
    expect(await runtime().getMemoriesByIds(receipt.memoryIds)).toEqual([]);
    expect(
      await runtime().getRelationshipsByIds(receipt.relationshipIds),
    ).toEqual([]);
    expect(await runtime().getTasksByIds(receipt.taskIds)).toEqual([]);
  }, 120_000);

  it("rejects a well-formed never-issued receipt without mutation", async () => {
    const target = runtime();
    const controlWorldId = stringToUuid("manifest-test:forgery-control");
    const forgedWorldId = stringToUuid("manifest-test:never-issued");
    await target.createWorld({
      id: controlWorldId,
      name: "Forgery control",
      agentId: target.agentId,
    });
    const forgedReceipt: ProductionManifestReceipt = {
      version: 1,
      namespace: "never-issued",
      ownerAgentId: target.agentId,
      manifestSha256: "a".repeat(64),
      worldId: forgedWorldId,
      entityIds: [],
      roomIds: [],
      participantPairs: [],
      memoryIds: [],
      relationshipIds: [],
      taskIds: [],
    };

    try {
      await expect(
        resetProductionManifest(target, forgedReceipt),
      ).rejects.toMatchObject({
        code: "SCENARIO_MANIFEST_RECEIPT_UNTRUSTED",
      });
      expect(await target.getWorldsByIds([forgedWorldId])).toEqual([]);
      expect(await target.getWorldsByIds([controlWorldId])).toHaveLength(1);
    } finally {
      await target.deleteWorlds([controlWorldId]);
    }
  }, 120_000);

  it("fails readback when a required persisted memory text is absent", async () => {
    const target = runtime();
    const receipt = await applyProductionManifest(
      target,
      manifest("missing-memory-text"),
    );
    const originalRead = target.getMemoriesByIds.bind(target);
    target.getMemoriesByIds = async (ids) =>
      (await originalRead(ids)).map((entry) => ({
        ...entry,
        content: { ...entry.content, text: undefined },
      }));
    try {
      await expect(
        readProductionManifestSnapshot(target, receipt),
      ).rejects.toMatchObject({
        code: "SCENARIO_MANIFEST_READBACK_INCOMPLETE",
      });
    } finally {
      target.getMemoriesByIds = originalRead;
      await resetProductionManifest(target, receipt);
    }
  }, 120_000);

  it("reports residue evidence when reset fails after partial mutation", async () => {
    const target = runtime();
    const receipt = await applyProductionManifest(
      target,
      manifest("partial-reset-failure"),
    );
    const originalDeleteTasks = target.deleteTasks.bind(target);
    target.deleteTasks = async () => {
      throw new Error("injected reset fault");
    };
    try {
      await expect(
        resetProductionManifest(target, receipt),
      ).rejects.toMatchObject({
        code: "SCENARIO_MANIFEST_DIRTY",
        residue: {
          worlds: [receipt.worldId],
          relationships: [],
          tasks: receipt.taskIds,
        },
      });
    } finally {
      target.deleteTasks = originalDeleteTasks;
      await resetProductionManifest(target, receipt);
    }
  }, 120_000);

  it("rejects a forged participant pair before mutating unrelated production state", async () => {
    const target = runtime();
    const unrelatedWorldId = stringToUuid("manifest-test:unrelated-world");
    const unrelatedEntityId = stringToUuid("manifest-test:unrelated-entity");
    const unrelatedRoomId = stringToUuid("manifest-test:unrelated-room");
    let receipt: ProductionManifestReceipt | undefined;
    await target.createWorld({
      id: unrelatedWorldId,
      name: "Unrelated world",
      agentId: target.agentId,
    });
    await target.createEntities([
      {
        id: unrelatedEntityId,
        names: ["Unrelated person"],
        agentId: target.agentId,
      },
    ]);
    await target.createRooms([
      {
        id: unrelatedRoomId,
        name: "Unrelated room",
        source: "scenario-test",
        type: ChannelType.DM,
        worldId: unrelatedWorldId,
        agentId: target.agentId,
      },
    ]);
    await target.addParticipant(unrelatedEntityId, unrelatedRoomId);

    try {
      receipt = await applyProductionManifest(
        target,
        manifest("forged-participant"),
      );
      await expect(
        resetProductionManifest(target, {
          ...receipt,
          participantPairs: [
            ...receipt.participantPairs,
            { entityId: unrelatedEntityId, roomId: unrelatedRoomId },
          ],
        }),
      ).rejects.toMatchObject({ code: "SCENARIO_MANIFEST_INVALID" });

      expect(await target.getParticipantsForRoom(unrelatedRoomId)).toContain(
        unrelatedEntityId,
      );
      await expect(
        readProductionManifestSnapshot(target, receipt),
      ).resolves.toMatchObject({ namespace: "forged-participant" });
    } finally {
      if (receipt) await resetProductionManifest(target, receipt);
      await target.removeParticipant(unrelatedEntityId, unrelatedRoomId);
      await target.deleteRooms([unrelatedRoomId]);
      await target.deleteEntities([unrelatedEntityId]);
      await target.deleteWorlds([unrelatedWorldId]);
    }
  }, 120_000);

  it("rejects a forged receipt for a participant added after seed", async () => {
    const target = runtime();
    const input = manifest("post-seed-participant");
    if (!input.rooms?.[0]) throw new Error("test manifest room is required");
    input.rooms[0].participantEntityIds = ["owner"];
    const receipt = await applyProductionManifest(target, input);
    const teammateId = receipt.entityIds[1];
    const roomId = receipt.roomIds[0];
    if (!teammateId || !roomId)
      throw new Error("seed identifiers are required");
    await target.addParticipant(teammateId, roomId);

    try {
      await expect(
        resetProductionManifest(target, {
          ...receipt,
          participantPairs: [
            ...receipt.participantPairs,
            { entityId: teammateId, roomId },
          ],
        }),
      ).rejects.toMatchObject({
        code: "SCENARIO_MANIFEST_RECEIPT_UNTRUSTED",
      });
      expect(await target.getParticipantsForRoom(roomId)).toContain(teammateId);
    } finally {
      await target.removeParticipant(teammateId, roomId);
      await resetProductionManifest(target, receipt);
    }
  }, 120_000);
});

async function applyThenRejectDuplicate(
  runtime: RuntimeFactoryResult["runtime"],
  manifest: ProductionManifestV1,
): Promise<ProductionManifestReceipt> {
  const receipt = await applyProductionManifest(runtime, manifest);
  await expect(
    applyProductionManifest(runtime, manifest),
  ).rejects.toMatchObject({
    code: "SCENARIO_MANIFEST_NAMESPACE_NOT_EMPTY",
  });
  return receipt;
}
