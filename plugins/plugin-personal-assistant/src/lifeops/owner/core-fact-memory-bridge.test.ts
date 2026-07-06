/**
 * Unit coverage for the core fact-memory bridge: synthetic facts-table rows
 * from the core `factMemory` evaluator are projected into the real
 * OwnerFactStore cache and fake graph stores without another LLM call.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bridgeCoreFactMemory,
  registerCoreFactMemoryBridge,
} from "./core-fact-memory-bridge.js";
import {
  createOwnerFactStore,
  type OwnerFactStore,
  type OwnerFactsPatch,
  registerOwnerFactStore,
  resolveOwnerFactStore,
} from "./fact-store.js";

const agentMocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(),
  resolveKnowledgeGraphService: vi.fn(),
}));

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: agentMocks.hasOwnerAccess,
  resolveKnowledgeGraphService: agentMocks.resolveKnowledgeGraphService,
}));

const agentId = "11111111-1111-1111-1111-111111111111" as UUID;
const ownerEntityId = "22222222-2222-2222-2222-222222222222" as UUID;
const roomId = "33333333-3333-3333-3333-333333333333" as UUID;

function makeRuntime(): IAgentRuntime & {
  hooks: Array<{
    id: string;
    handler: (runtime: IAgentRuntime, ctx: unknown) => Promise<void>;
  }>;
  cache: Map<string, unknown>;
} {
  const cache = new Map<string, unknown>();
  const agents = new Map<string, unknown>();
  const tasks: Array<{
    id: UUID;
    name?: string;
    description?: string;
    roomId?: UUID;
    tags?: string[];
    metadata?: Record<string, unknown>;
    dueAt?: number;
  }> = [];
  const hooks: Array<{
    id: string;
    handler: (runtime: IAgentRuntime, ctx: unknown) => Promise<void>;
  }> = [];
  const runtime = {
    agentId,
    character: { name: "Eliza" },
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
    reportError: vi.fn(),
    async getCache<T>(key: string): Promise<T | null> {
      const value = cache.get(key);
      return value === undefined ? null : (value as T);
    },
    async setCache<T>(key: string, value: T): Promise<boolean> {
      cache.set(key, value);
      return true;
    },
    async deleteCache(key: string): Promise<boolean> {
      return cache.delete(key);
    },
    registerPipelineHook: vi.fn(
      (spec: { id: string; handler: (typeof hooks)[number]["handler"] }) => {
        hooks.push(spec);
      },
    ),
    getService: vi.fn(() => null),
    getAgent: vi.fn(async (id: UUID) => agents.get(id) ?? null),
    createAgent: vi.fn(async (agent: { id?: UUID }) => {
      if (agent.id) agents.set(agent.id, agent);
      return true;
    }),
    getTasks: vi.fn(async (query?: { agentIds?: UUID[]; tags?: string[] }) => {
      if (!query?.tags || query.tags.length === 0) return [...tasks];
      return tasks.filter((task) =>
        query.tags?.every((tag) => task.tags?.includes(tag)),
      );
    }),
    createTask: vi.fn(
      async (task: {
        name?: string;
        description?: string;
        roomId?: UUID;
        tags?: string[];
        metadata?: Record<string, unknown>;
        dueAt?: number;
      }) => {
        const id =
          `99999999-9999-4999-8999-${String(tasks.length + 1).padStart(12, "0")}` as UUID;
        tasks.push({ ...task, id });
        return id;
      },
    ),
    updateTask: vi.fn(
      async (
        id: UUID,
        patch: {
          description?: string;
          metadata?: Record<string, unknown>;
        },
      ) => {
        const task = tasks.find((candidate) => candidate.id === id);
        if (task) {
          Object.assign(task, patch);
        }
        return true;
      },
    ),
    hooks,
    cache,
  };
  registerOwnerFactStore(
    runtime as unknown as IAgentRuntime,
    createOwnerFactStore(runtime as unknown as IAgentRuntime),
  );
  return runtime as unknown as ReturnType<typeof makeRuntime>;
}

function factMemory(args: {
  id: UUID;
  text: string;
  category: string;
  structuredFields?: Record<string, unknown>;
  confidence?: number;
}): Memory {
  return {
    id: args.id,
    entityId: ownerEntityId,
    agentId,
    roomId,
    content: { text: args.text },
    metadata: {
      type: "custom",
      source: "fact_extractor",
      kind: "durable",
      category: args.category,
      structuredFields: args.structuredFields ?? {},
      confidence: args.confidence ?? 0.7,
      lastConfirmedAt: "2026-07-06T12:00:00.000Z",
    },
    createdAt: Date.parse("2026-07-06T12:00:00.000Z"),
  };
}

class FakeEntityStore {
  public identities: unknown[] = [];
  public upserts: unknown[] = [];

  async ensureSelf() {
    return {
      entityId: "self",
      type: "person",
      preferredName: "Owner",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    };
  }

  async get() {
    return null;
  }

  async resolve() {
    return [];
  }

  async upsert(entity: { preferredName: string; type: string }) {
    this.upserts.push(entity);
    return {
      entityId: `entity:${entity.preferredName.toLowerCase()}`,
      type: entity.type,
      preferredName: entity.preferredName,
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    };
  }

  async observeIdentity(identity: unknown) {
    this.identities.push(identity);
    const displayName =
      typeof identity === "object" && identity && "displayName" in identity
        ? String((identity as { displayName?: unknown }).displayName)
        : "Unknown";
    return {
      entity: {
        entityId: `entity:${displayName.toLowerCase()}`,
        type: "person",
        preferredName: displayName,
        identities: [],
        tags: [],
        visibility: "owner_agent_admin",
        state: {},
      },
    };
  }
}

class FakeRelationshipStore {
  public observations: unknown[] = [];

  async observe(observation: unknown) {
    this.observations.push(observation);
    return {
      relationshipId: `relationship:${this.observations.length}`,
      fromEntityId: "self",
      toEntityId: "entity:pat",
      type: "managed_by",
      metadata: {},
      confidence: 0.7,
      evidence: [],
      source: "extraction",
      updatedAt: "2026-07-06T12:00:00.000Z",
    };
  }
}

/**
 * Fake OwnerFactStore that records the patches the bridge writes, so the
 * value-extraction leg can be asserted directly without dragging in the
 * cache-backed store's scheduler-profile mirror (owner-profile.ts).
 */
function captureFactStore(): {
  store: OwnerFactStore;
  patches: OwnerFactsPatch[];
} {
  const patches: OwnerFactsPatch[] = [];
  const store = {
    async update(patch: OwnerFactsPatch) {
      patches.push(patch);
    },
  } as unknown as OwnerFactStore;
  return { store, patches };
}

function installFakeGraph(
  entityStore = new FakeEntityStore(),
  relationshipStore = new FakeRelationshipStore(),
) {
  agentMocks.resolveKnowledgeGraphService.mockReturnValue({
    getEntityStore: vi.fn(() => entityStore),
    getRelationshipStore: vi.fn(() => relationshipStore),
  });
  return { entityStore, relationshipStore };
}

beforeEach(() => {
  agentMocks.hasOwnerAccess.mockReset();
  agentMocks.resolveKnowledgeGraphService.mockReset();
  agentMocks.hasOwnerAccess.mockResolvedValue(true);
});

describe("bridgeCoreFactMemory", () => {
  it("projects structured non-English identity facts into the OwnerFactStore with agent provenance", async () => {
    const runtime = makeRuntime();
    const result = await bridgeCoreFactMemory(
      runtime,
      factMemory({
        id: "44444444-4444-4444-4444-444444444444" as UUID,
        text: "Je m'appelle Camille et mon fuseau horaire est Europe/Paris",
        category: "identity",
        structuredFields: {
          preferredName: "Camille",
          timezone: "Europe/Paris",
        },
      }),
    );

    expect(result).toMatchObject({
      skipped: false,
      ownerFactKeys: ["preferredName", "timezone"],
    });
    const facts = await resolveOwnerFactStore(runtime).read();
    expect(facts.preferredName?.value).toBe("Camille");
    expect(facts.timezone?.value).toBe("Europe/Paris");
    expect(facts.timezone?.provenance).toMatchObject({
      source: "agent_inferred",
      note: "core fact-memory bridge from fact:44444444-4444-4444-4444-444444444444",
    });
  });

  it("projects a preferred name from a language-agnostic structured field", async () => {
    const { store, patches } = captureFactStore();
    const result = await bridgeCoreFactMemory(
      makeRuntime(),
      factMemory({
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID,
        text: "je m'appelle Alex",
        category: "identity",
        structuredFields: { name: "Alex" },
      }),
      { factStore: store },
    );

    expect(result.ownerFactKeys).toEqual(["preferredName"]);
    expect(patches).toEqual([{ preferredName: "Alex" }]);
  });

  it("does not recover a preferred name from an English claim without structured fields", async () => {
    const { store, patches } = captureFactStore();
    const result = await bridgeCoreFactMemory(
      makeRuntime(),
      factMemory({
        id: "cccccccc-cccc-cccc-cccc-cccccccccccc" as UUID,
        text: "my name is Robin",
        category: "identity",
      }),
      { factStore: store },
    );

    expect(result.ownerFactKeys).toEqual([]);
    expect(patches).toEqual([]);
  });

  it("projects structured relationship facts and handle claims into the entity graph", async () => {
    const runtime = makeRuntime();
    const { entityStore, relationshipStore } = installFakeGraph();

    const result = await bridgeCoreFactMemory(
      runtime,
      factMemory({
        id: "55555555-5555-5555-5555-555555555555" as UUID,
        text: "mi jefe es Pat y su Telegram es @pat",
        category: "relationship",
        structuredFields: {
          person: "Pat",
          relationshipType: "manager",
          platform: "Telegram",
          handle: "@pat",
        },
      }),
    );

    expect(result).toMatchObject({
      skipped: false,
      identityCount: 1,
      relationshipCount: 1,
    });
    expect(entityStore.identities).toEqual([
      expect.objectContaining({
        platform: "telegram",
        handle: "@pat",
        displayName: "Pat",
        evidence: ["fact:55555555-5555-5555-5555-555555555555"],
      }),
    ]);
    expect(relationshipStore.observations).toEqual([
      expect.objectContaining({
        fromEntityId: "self",
        toEntityId: "entity:pat",
        type: "managed_by",
        evidence: ["fact:55555555-5555-5555-5555-555555555555"],
      }),
    ]);
    const facts = await resolveOwnerFactStore(runtime).read();
    expect(facts.preferredName).toBeUndefined();
  });

  it("does not reparse free-text claims when core omits structured fields", async () => {
    const runtime = makeRuntime();
    const { entityStore, relationshipStore } = installFakeGraph();

    const result = await bridgeCoreFactMemory(
      runtime,
      factMemory({
        id: "77777777-7777-7777-7777-777777777777" as UUID,
        text: "Pat is my manager. Pat's Telegram handle is @pat.",
        category: "relationship",
      }),
    );

    expect(result).toMatchObject({
      skipped: false,
      identityCount: 0,
      relationshipCount: 0,
      ownerFactKeys: [],
    });
    expect(entityStore.identities).toEqual([]);
    expect(relationshipStore.observations).toEqual([]);
  });

  it("does not replay a bridged fact into graph stores", async () => {
    const runtime = makeRuntime();
    const { relationshipStore } = installFakeGraph();
    const memory = factMemory({
      id: "66666666-6666-6666-6666-666666666666" as UUID,
      text: "mi jefe es Pat",
      category: "relationship",
      structuredFields: { person: "Pat", relationshipType: "manager" },
    });

    const first = await bridgeCoreFactMemory(runtime, memory);
    const second = await bridgeCoreFactMemory(runtime, memory);

    expect(first.skipped).toBe(false);
    expect(second).toMatchObject({
      skipped: true,
      reason: "already_bridged",
    });
    expect(relationshipStore.observations).toHaveLength(1);
  });

  it("registers an after-memory hook for facts-table rows", async () => {
    const runtime = makeRuntime();
    registerCoreFactMemoryBridge(runtime);

    expect(runtime.registerPipelineHook).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "lifeops:core-fact-memory-bridge",
        phase: "after_memory_persisted",
        mutatesPrimary: false,
      }),
    );
  });
});
