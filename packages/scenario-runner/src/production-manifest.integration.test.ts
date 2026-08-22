/**
 * Exercises production-manifest apply/readback/reset against the scenario
 * runner's real AgentRuntime and PGlite adapter. Adversarial cases verify
 * compensation, strict serialized receipts, and reset isolation without
 * replacing the stores under test.
 */
import { resolveApprovalService } from "@elizaos/agent";
import {
  ChannelType,
  NotificationService,
  ServiceType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { getScheduledTaskRunner } from "@elizaos/plugin-scheduling";
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
        {
          id: "fact-1",
          roomId: "planning",
          entityId: "teammate",
          text: "Riley owns the production readback review.",
          tableName: "facts",
          metadata: { confidence: 0.95 },
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
      schedules: [
        {
          id: "manual-verification",
          task: {
            kind: "reminder",
            promptInstructions: "Verify the synthetic production snapshot.",
            trigger: { kind: "manual" },
            priority: "high",
            respectsGlobalPause: true,
            source: "plugin",
            createdBy: "scenario-manifest-test",
            ownerVisible: true,
            subject: { kind: "entity", id: "owner" },
            contextRequest: {
              includeEntities: { entityIds: ["owner", "teammate"] },
            },
            metadata: { test: "production-manifest" },
          },
        },
        {
          id: "after-verification",
          task: {
            kind: "reminder",
            promptInstructions: "Review the completed synthetic verification.",
            trigger: {
              kind: "after_task",
              taskId: "manual-verification",
              outcome: "completed",
            },
            priority: "medium",
            respectsGlobalPause: true,
            source: "plugin",
            createdBy: "scenario-manifest-test",
            ownerVisible: true,
            subject: { kind: "relationship", id: "team-link" },
            contextRequest: {
              includeRelationships: {
                relationshipIds: ["team-link"],
                forEntityIds: ["owner", "teammate"],
              },
            },
          },
        },
      ],
      notifications: [
        {
          id: "verification-ready",
          title: "Synthetic world ready",
          body: "Production-backed state is available for verification.",
          category: "system",
          priority: "high",
          source: "scenario-manifest-test",
          groupKey: "verification-ready",
          data: { surface: "manifest" },
          expiresAt: 2_000_000_000_000,
        },
      ],
      approvals: [
        {
          id: "release-workflow",
          subjectEntityId: "owner",
          workflowId: "synthetic-world.release",
          input: { environment: "test", revision: 1, dryRun: true },
          channel: "internal",
          reason: "Approve the synthetic release workflow.",
          expiresAt: 2_000_000_000_000,
        },
      ],
      providerState: [
        {
          id: "github-cursor",
          key: "provider:github:{{namespace}}:cursor",
          value: { cursor: "page-2", etag: "fixture-v1" },
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
    expect(
      artifact.initial.memories.map((entry) => entry.tableName).sort(),
    ).toEqual(["facts", "messages"]);
    expect(artifact.initial.tasks[0]?.name).toBe("SCENARIO_MANIFEST_TEST_TASK");
    expect(artifact.initial.schedules[0]?.logicalId).toBe("after-verification");
    expect(artifact.initial.schedules).toHaveLength(2);
    expect(
      artifact.initial.notifications.map((entry) => entry.logicalId),
    ).toEqual(["approval:release-workflow", "verification-ready"]);
    expect(artifact.initial.approvals[0]?.logicalId).toBe("release-workflow");
    expect(artifact.initial.providerState[0]?.value).toEqual({
      cursor: "page-2",
      etag: "fixture-v1",
    });
    const scheduledRows = (
      await getScheduledTaskRunner(runtime(), {
        agentId: runtime().agentId,
      }).list({})
    ).filter((row) => artifact.reseedReceipt.scheduleIds.includes(row.taskId));
    const manual = scheduledRows.find(
      (row) => row.taskId === artifact.reseedReceipt.scheduleIds[0],
    );
    const after = scheduledRows.find(
      (row) => row.taskId === artifact.reseedReceipt.scheduleIds[1],
    );
    expect(manual?.subject?.id).toBe(artifact.reseedReceipt.entityIds[0]);
    expect(manual?.contextRequest?.includeEntities?.entityIds).toEqual(
      artifact.reseedReceipt.entityIds,
    );
    expect(after?.subject?.id).toBe(artifact.reseedReceipt.relationshipIds[0]);
    expect(
      after?.contextRequest?.includeRelationships?.relationshipIds,
    ).toEqual(artifact.reseedReceipt.relationshipIds);
    expect(after?.contextRequest?.includeRelationships?.forEntityIds).toEqual(
      artifact.reseedReceipt.entityIds,
    );
    expect(
      after?.trigger.kind === "after_task" ? after.trigger.taskId : null,
    ).toBe(manual?.taskId);
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
    let receiptGetterReads = 0;
    const accessorReceipt = { ...restartedProcessReceipt } as Record<
      string,
      unknown
    >;
    Object.defineProperty(accessorReceipt, "namespace", {
      enumerable: true,
      get: () => {
        receiptGetterReads += 1;
        return restartedProcessReceipt.namespace;
      },
    });
    expect(() => parseProductionManifestReceipt(accessorReceipt)).toThrow(
      /namespace.*data property/,
    );
    expect(receiptGetterReads).toBe(0);
    expect(() =>
      parseProductionManifestReceipt(
        Object.assign(
          Object.create({ inherited: true }),
          restartedProcessReceipt,
        ),
      ),
    ).toThrow(/plain JSON objects/);
    let deepReceiptValue: Record<string, unknown> = {};
    for (let depth = 0; depth < 40; depth += 1) {
      deepReceiptValue = { next: deepReceiptValue };
    }
    expect(() =>
      parseProductionManifestReceipt({
        ...restartedProcessReceipt,
        providerStateKeys: [deepReceiptValue],
      }),
    ).toThrow(/maximum JSON depth/);
    expect(() =>
      parseProductionManifestReceipt({
        ...restartedProcessReceipt,
        entityIds: Array.from(
          { length: 20_001 },
          () => restartedProcessReceipt.entityIds[0],
        ),
      }),
    ).toThrow(/array budget|node JSON budget/);
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
    expect(() =>
      parseProductionManifest({
        ...valid,
        schedules: [
          {
            id: "bad-schedule",
            task: {
              ...(valid.schedules?.[0]?.task ?? {}),
              idempotencyKey: "caller-controlled",
            },
          },
        ],
      }),
    ).toThrow(/idempotencyKey.*reserved/);
    expect(() =>
      parseProductionManifest({
        ...valid,
        schedules: [
          {
            id: "lossy-schedule",
            task: {
              ...(valid.schedules?.[0]?.task ?? {}),
              metadata: { createdAtIso: "2026-01-01T00:00:00.000Z" },
            },
          },
        ],
      }),
    ).toThrow(/createdAtIso.*reserved/);
    expect(() =>
      parseProductionManifest({
        ...valid,
        providerState: [
          { id: "bad-provider", key: "provider:global", value: true },
        ],
      }),
    ).toThrow(/literal \{\{namespace\}\} token/);
    expect(() =>
      parseProductionManifest({
        ...valid,
        notifications: [
          { id: "same-group", title: "First", groupKey: "same-group" },
          { id: "same-group-2", title: "Second", groupKey: "same-group" },
        ],
      }),
    ).toThrow(/duplicates effective notification group/);
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
          { ...(valid.memories?.[0] ?? {}), tableName: "provider-state" },
        ],
      }),
    ).toThrow(/tableName.*safe logical memory table/);
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
    let getterReads = 0;
    const getterManifest = { ...valid } as Record<string, unknown>;
    Object.defineProperty(getterManifest, "ownerAgentId", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return valid.ownerAgentId;
      },
    });
    expect(() => parseProductionManifest(getterManifest)).toThrow(
      /ownerAgentId.*data property/,
    );
    expect(getterReads).toBe(0);
    expect(() =>
      parseProductionManifest({ ...valid, [Symbol("hidden")]: true }),
    ).toThrow(/symbol keys/);
    let deep: Record<string, unknown> = {};
    for (let depth = 0; depth < 40; depth += 1) deep = { next: deep };
    expect(() =>
      parseProductionManifest({
        ...valid,
        entities: [{ ...(valid.entities?.[0] ?? {}), metadata: deep }],
      }),
    ).toThrow(/maximum JSON depth/);
    expect(() =>
      parseProductionManifest({
        ...valid,
        entities: Array.from({ length: 1_001 }, (_, index) => ({
          id: `entity-${index}`,
          names: [`Entity ${index}`],
        })),
        relationships: [],
        rooms: [],
        memories: [],
        tasks: [],
        schedules: [],
        approvals: [],
      }),
    ).toThrow(/row budget/);
    expect(() =>
      parseProductionManifest({
        ...valid,
        entities: [
          {
            ...(valid.entities?.[0] ?? {}),
            names: ["x".repeat(65_537)],
          },
        ],
      }),
    ).toThrow(/string budget/);
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

  it("rejects expired time-bound rows at one captured apply-time before writes", async () => {
    const namespace = "expired-preflight";
    const expired = manifest(namespace);
    expired.notifications = [
      {
        id: "expired",
        title: "Already expired",
        expiresAt: Date.now() - 1,
      },
    ];
    expired.approvals = [];

    await expect(
      applyProductionManifest(runtime(), expired),
    ).rejects.toMatchObject({ code: "SCENARIO_MANIFEST_INVALID" });
    expect(
      await runtime().getWorldsByIds([
        stringToUuid(`scenario-manifest:${namespace}:world:${namespace}`),
      ]),
    ).toEqual([]);
  });

  it("compensates a schedule committed before its receipt is returned", async () => {
    const target = runtime();
    const input = manifest("ambiguous-schedule");
    input.schedules = [
      input.schedules?.[0] as NonNullable<typeof input.schedules>[number],
    ];
    input.notifications = [];
    input.approvals = [];
    input.providerState = [];
    const runner = getScheduledTaskRunner(target, { agentId: target.agentId });
    const original = runner.scheduleWithResult.bind(runner);
    let injected = false;
    runner.scheduleWithResult = async (task) => {
      const result = await original(task);
      if (!injected) {
        injected = true;
        throw new Error("injected post-schedule receipt fault");
      }
      return result;
    };
    try {
      await expect(
        applyProductionManifest(target, input),
      ).rejects.toMatchObject({
        code: "SCENARIO_MANIFEST_APPLY_FAILED",
      });
      expect(
        (await runner.list({})).filter((row) =>
          row.idempotencyKey?.includes("ambiguous-schedule"),
        ),
      ).toEqual([]);
    } finally {
      runner.scheduleWithResult = original;
    }
  }, 120_000);

  it("awaits and compensates a rejected approval notification projection", async () => {
    const target = runtime();
    const input = manifest("ambiguous-approval");
    input.schedules = [];
    input.notifications = [];
    input.providerState = [];
    const service = resolveApprovalService(target);
    if (!service) throw new Error("approval service was not registered");
    const queue = service.getQueue(target.agentId);
    const original = target.setCache.bind(target);
    let injected = false;
    target.setCache = async (key, value) => {
      const written = await original(key, value);
      if (!injected && key === `notifications:${target.agentId}`) {
        injected = true;
        await new Promise((resolve) => setTimeout(resolve, 25));
        throw new Error("injected approval notification persistence fault");
      }
      return written;
    };
    try {
      await expect(
        applyProductionManifest(target, input),
      ).rejects.toMatchObject({
        code: "SCENARIO_MANIFEST_APPLY_FAILED",
      });
      expect(
        await queue.byIdempotencyKey(
          "scenario-manifest:ambiguous-approval:approval:release-workflow",
          stringToUuid("scenario-manifest:ambiguous-approval:entity:owner"),
        ),
      ).toBeNull();
    } finally {
      target.setCache = original;
    }
  }, 120_000);

  it("compensates a notification committed before persistence reports failure", async () => {
    const target = runtime();
    const input = manifest("ambiguous-notification");
    input.schedules = [];
    input.approvals = [];
    input.providerState = [];
    input.notifications = [
      {
        ...(input.notifications?.[0] as NonNullable<
          typeof input.notifications
        >[number]),
        expiresAt: Date.now() + 1_000,
      },
    ];
    const original = target.setCache.bind(target);
    let injected = false;
    target.setCache = async (key, value) => {
      const written = await original(key, value);
      if (!injected && key === `notifications:${target.agentId}`) {
        injected = true;
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        throw new Error("injected post-notification persistence fault");
      }
      return written;
    };
    try {
      await expect(
        applyProductionManifest(target, input),
      ).rejects.toMatchObject({
        code: "SCENARIO_MANIFEST_APPLY_FAILED",
      });
      const service = target.getService(ServiceType.NOTIFICATION);
      expect(service).toBeInstanceOf(NotificationService);
      expect(
        (service as NotificationService)
          .list()
          .filter((row) => row.groupKey?.includes("ambiguous-notification")),
      ).toEqual([]);
    } finally {
      target.setCache = original;
    }
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

  it("compensates returned relationship IDs when pair readback is ambiguous", async () => {
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

    expect(failure).toMatchObject({ code: "SCENARIO_MANIFEST_APPLY_FAILED" });
    const input = manifest("ambiguous-relationship");
    const entityIds = (input.entities ?? []).map((entry) =>
      stringToUuid(`scenario-manifest:${input.namespace}:entity:${entry.id}`),
    );
    expect(await target.getEntitiesByIds(entityIds)).toEqual([]);
    expect(
      await originalReadback([
        {
          sourceEntityId: entityIds[0] as UUID,
          targetEntityId: entityIds[1] as UUID,
        },
      ]),
    ).toEqual([null]);
  }, 120_000);

  it.each(["before", "after"] as const)(
    "compensates a relationship write that throws %s commit",
    async (boundary) => {
      const target = runtime();
      const namespace = `relationship-${boundary}-commit`;
      const input = manifest(namespace);
      input.schedules = [];
      input.notifications = [];
      input.approvals = [];
      input.providerState = [];
      const original = target.createRelationships.bind(target);
      target.createRelationships = async (relationships) => {
        if (boundary === "before") {
          throw new Error("injected pre-commit relationship fault");
        }
        await original(relationships);
        throw new Error("injected post-commit relationship fault");
      };
      try {
        await expect(
          applyProductionManifest(target, input),
        ).rejects.toMatchObject({ code: "SCENARIO_MANIFEST_APPLY_FAILED" });
      } finally {
        target.createRelationships = original;
      }
      const entityIds = (input.entities ?? []).map((entry) =>
        stringToUuid(`scenario-manifest:${namespace}:entity:${entry.id}`),
      );
      expect(await target.getEntitiesByIds(entityIds)).toEqual([]);
      expect(
        await target.getRelationshipsByPairs([
          {
            sourceEntityId: entityIds[0] as UUID,
            targetEntityId: entityIds[1] as UUID,
          },
        ]),
      ).toEqual([null]);
    },
    120_000,
  );

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
      memoryTableNames: [],
      relationshipIds: [],
      taskIds: [],
      scheduleIds: [],
      notificationIds: [],
      approvalRecords: [],
      providerStateKeys: [],
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
