import { PGlite } from "@electric-sql/pglite";
import {
  AgentRuntime,
  ChannelType,
  type Character,
  type Entity,
  type IAgentRuntime,
  type Plugin,
  type Room,
  Service,
  type UUID,
  type World,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { plugin as sqlPlugin } from "../../index";
import { DatabaseMigrationService } from "../../migration-service";
import { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { PGliteClientManager } from "../../pglite/manager";
import * as schema from "../../schema";
import type { DrizzleDatabase } from "../../types";

type RuntimeMemoryService = {
  storeLongTermMemory: (memory: {
    agentId: UUID;
    entityId: UUID;
    category: "episodic" | "semantic" | "procedural";
    content: string;
    confidence?: number;
    source?: string;
    metadata?: Record<string, unknown>;
    embedding?: number[];
  }) => Promise<{
    id: UUID;
    entityId: UUID;
    content: string;
    confidence?: number;
  }>;
  getLongTermMemories: (
    entityId: UUID,
    category?: "episodic" | "semantic" | "procedural",
    limit?: number
  ) => Promise<Array<{ id: UUID; entityId: UUID; content: string; confidence?: number }>>;
  storeSessionSummary: (summary: {
    agentId: UUID;
    roomId: UUID;
    entityId?: UUID;
    summary: string;
    messageCount: number;
    lastMessageOffset: number;
    startTime: Date;
    endTime: Date;
    topics?: string[];
    metadata?: Record<string, unknown>;
    embedding?: number[];
  }) => Promise<{ id: UUID; summary: string; messageCount: number }>;
  getCurrentSessionSummary: (roomId: UUID) => Promise<{
    id: UUID;
    summary: string;
    messageCount: number;
    topics?: string[];
  } | null>;
};

class StubEntityResolutionService extends Service {
  static serviceType = "entity_resolution" as const;
  static links = new Map<UUID, UUID[]>();
  capabilityDescription = "Stub entity-resolution service for advanced-memory tests";

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new StubEntityResolutionService(runtime);
    await service.initialize(runtime);
    return service;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
  }

  async stop(): Promise<void> {}

  async getConfirmedLinks(
    entityId: UUID
  ): Promise<Array<{ entityA: UUID; entityB: UUID; status: "confirmed" }>> {
    return (StubEntityResolutionService.links.get(entityId) ?? []).map((other) => ({
      entityA: entityId,
      entityB: other,
      status: "confirmed" as const,
    }));
  }
}

async function createMigratedAdapter(agentId: UUID): Promise<PgliteDatabaseAdapter> {
  const client = new PGlite();
  const manager = new PGliteClientManager(client);
  const adapter = new PgliteDatabaseAdapter(agentId, manager);
  await adapter.init();

  const migrationService = new DatabaseMigrationService();
  const db = adapter.getDatabase() as DrizzleDatabase;
  await migrationService.initializeWithDatabase(db);
  migrationService.discoverAndRegisterPluginSchemas([
    { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
  ]);
  await migrationService.runAllPluginMigrations();

  return adapter;
}

async function createConversationRoom(
  runtime: AgentRuntime
): Promise<{ roomId: UUID; worldId: UUID }> {
  const worldId = uuidv4() as UUID;
  const roomId = uuidv4() as UUID;

  const world: World = {
    id: worldId,
    agentId: runtime.agentId,
    name: "Test World",
    metadata: {},
    createdAt: new Date(),
  } as World & { createdAt: Date };
  await runtime.createWorld(world);

  const room: Room = {
    id: roomId,
    agentId: runtime.agentId,
    worldId,
    source: "test",
    type: ChannelType.DM,
    name: "Test Room",
    metadata: {},
    createdAt: new Date(),
  } as Room & { createdAt: Date };
  await runtime.createRooms([room]);

  return { roomId, worldId };
}

async function createEntities(runtime: AgentRuntime, entityIds: UUID[]): Promise<void> {
  const entities: Entity[] = entityIds.map((entityId, index) => ({
    id: entityId,
    agentId: runtime.agentId,
    names: [`Entity ${index + 1}`],
    metadata: {},
  }));
  await runtime.createEntities(entities);
}

function createRuntime(extraServices: NonNullable<Plugin["services"]> = []): AgentRuntime {
  const character: Character = {
    name: "Eliza",
    bio: ["Test"],
    templates: {},
    messageExamples: [],
    postExamples: [],
    topics: [],
    adjectives: [],
    knowledge: [],
    advancedMemory: true,
    secrets: {},
  };

  const integrationPlugin: Plugin = {
    name: "advanced-memory-integration-test",
    description: "Advanced memory integration test plugin",
    services: extraServices,
  };

  return new AgentRuntime({
    character,
    plugins: [sqlPlugin, integrationPlugin],
  });
}

describe("plugin-sql advanced memory storage", () => {
  const runtimes: AgentRuntime[] = [];

  afterEach(async () => {
    StubEntityResolutionService.links.clear();
    await Promise.all(
      runtimes.splice(0).map(async (runtime) => {
        await runtime.stop();
      })
    );
  });

  it("boots the built-in advanced-memory plugin against plugin-sql storage", async () => {
    const runtime = createRuntime();
    runtimes.push(runtime);

    const adapter = await createMigratedAdapter(runtime.agentId);
    runtime.registerDatabaseAdapter(adapter);
    await runtime.initialize({ skipMigrations: true });

    const memoryStorage = await runtime.getServiceLoadPromise("memoryStorage");
    const memory = await runtime.getServiceLoadPromise("memory");

    expect(memoryStorage).toBeTruthy();
    expect(memory).toBeTruthy();
    expect(runtime.providers.some((provider) => provider.name === "LONG_TERM_MEMORY")).toBe(true);
    expect(runtime.providers.some((provider) => provider.name === "SUMMARIZED_CONTEXT")).toBe(true);
    expect(runtime.evaluators.some((evaluator) => evaluator.name === "summary")).toBe(true);
    expect(runtime.evaluators.some((evaluator) => evaluator.name === "longTermMemory")).toBe(true);
  });

  it("stores long-term memories in SQL and retrieves them across confirmed identity links", async () => {
    const runtime = createRuntime([StubEntityResolutionService]);
    runtimes.push(runtime);

    const adapter = await createMigratedAdapter(runtime.agentId);
    runtime.registerDatabaseAdapter(adapter);
    await runtime.initialize({ skipMigrations: true });

    const entityA = uuidv4() as UUID;
    const entityB = uuidv4() as UUID;
    await createEntities(runtime, [entityA, entityB]);

    StubEntityResolutionService.links.set(entityA, [entityB]);
    StubEntityResolutionService.links.set(entityB, [entityA]);

    const memoryService = (await runtime.getServiceLoadPromise(
      "memory"
    )) as unknown as RuntimeMemoryService;

    const stored = await memoryService.storeLongTermMemory({
      agentId: runtime.agentId,
      entityId: entityA,
      category: "semantic",
      content: "Chris prefers short emails and fast follow-ups.",
      confidence: 0.93,
      source: "conversation",
      metadata: { channel: "discord" },
    });

    expect(stored.entityId).toBe(entityA);

    const viaLinkedIdentity = await memoryService.getLongTermMemories(entityB, undefined, 10);

    expect(viaLinkedIdentity).toHaveLength(1);
    expect(viaLinkedIdentity[0]?.content).toContain("short emails");
    expect(viaLinkedIdentity[0]?.entityId).toBe(entityA);
  });

  it("stores session summaries in SQL for real conversation rooms", async () => {
    const runtime = createRuntime();
    runtimes.push(runtime);

    const adapter = await createMigratedAdapter(runtime.agentId);
    runtime.registerDatabaseAdapter(adapter);
    await runtime.initialize({ skipMigrations: true });

    const entityId = uuidv4() as UUID;
    await createEntities(runtime, [entityId]);
    const { roomId } = await createConversationRoom(runtime);

    const memoryService = (await runtime.getServiceLoadPromise(
      "memory"
    )) as unknown as RuntimeMemoryService;

    await memoryService.storeSessionSummary({
      agentId: runtime.agentId,
      roomId,
      entityId,
      summary: "We agreed to ship the billing audit first, then revisit experiments.",
      messageCount: 12,
      lastMessageOffset: 12,
      startTime: new Date("2026-04-08T19:00:00.000Z"),
      endTime: new Date("2026-04-08T19:20:00.000Z"),
      topics: ["billing", "experiments"],
      metadata: { source: "test" },
    });

    const current = await memoryService.getCurrentSessionSummary(roomId);

    expect(current?.summary).toContain("billing audit first");
    expect(current?.messageCount).toBe(12);
    expect(current?.topics).toEqual(["billing", "experiments"]);
  });
});
