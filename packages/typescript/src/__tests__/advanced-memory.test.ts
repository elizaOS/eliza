import { describe, expect, test } from "vitest";
import { MemoryService } from "../advanced-memory";
import { LongTermMemoryCategory } from "../advanced-memory/types";
import { AgentRuntime } from "../runtime";
import type { Character, UUID } from "../types";

describe("advanced memory (built-in)", () => {
  test("auto-loads providers + evaluators + memory service when enabled", async () => {
    const character: Character = {
      name: "AdvMemory",
      bio: ["Test"],
      templates: {},
      messageExamples: [],
      postExamples: [],
      topics: [],
      adjectives: [],
      knowledge: [],
      advancedMemory: true,
      plugins: [],
      secrets: {},
    };

    const runtime = new AgentRuntime({ character });
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

    // Service registration is async and waits for runtime init to complete.
    await runtime.getServiceLoadPromise("memory");
    expect(runtime.hasService("memory")).toBe(true);
    expect(runtime.providers.some((p) => p.name === "LONG_TERM_MEMORY")).toBe(
      true,
    );
    expect(runtime.providers.some((p) => p.name === "SUMMARIZED_CONTEXT")).toBe(
      true,
    );
    expect(
      runtime.evaluators.some((e) => e.name === "MEMORY_SUMMARIZATION"),
    ).toBe(true);
    expect(
      runtime.evaluators.some((e) => e.name === "LONG_TERM_MEMORY_EXTRACTION"),
    ).toBe(true);

    const svc = (await runtime.getServiceLoadPromise(
      "memory",
    )) as MemoryService;
    const config = svc.getConfig();
    expect(config.shortTermSummarizationThreshold).toBeGreaterThan(0);
    expect(config.longTermExtractionThreshold).toBeGreaterThan(0);

    const entityId = "12345678-1234-1234-1234-123456789123" as UUID;
    const roomId = "12345678-1234-1234-1234-123456789124" as UUID;

    // Before threshold, should not run
    expect(await svc.shouldRunExtraction(entityId, roomId, 1)).toBe(false);

    // After threshold, but checkpoint prevents rerun
    await svc.setLastExtractionCheckpoint(entityId, roomId, 30);
    expect(await svc.shouldRunExtraction(entityId, roomId, 30)).toBe(false);

    // Next interval should run
    expect(await svc.shouldRunExtraction(entityId, roomId, 40)).toBe(true);
  });

  test("does not load when disabled", async () => {
    const character: Character = {
      name: "AdvMemoryOff",
      bio: ["Test"],
      templates: {},
      messageExamples: [],
      postExamples: [],
      topics: [],
      adjectives: [],
      knowledge: [],
      advancedMemory: false,
      plugins: [],
      secrets: {},
    };

    const runtime = new AgentRuntime({ character });
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

    expect(runtime.hasService("memory")).toBe(false);
    expect(runtime.providers.some((p) => p.name === "LONG_TERM_MEMORY")).toBe(
      false,
    );
  });

  test("searchLongTermMemories returns top matches and respects limit", async () => {
    const svc = new MemoryService({} as AgentRuntime);
    svc.updateConfig({ longTermVectorSearchEnabled: true });

    const now = new Date();
    const entityId = "12345678-1234-1234-1234-123456789223" as UUID;
    const agentId = "12345678-1234-1234-1234-123456789224" as UUID;

    const memories = [
      {
        id: "12345678-1234-1234-1234-123456789225" as UUID,
        agentId,
        entityId,
        category: LongTermMemoryCategory.SEMANTIC,
        content: "high",
        embedding: [1, 0],
        confidence: 1,
        source: "",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "12345678-1234-1234-1234-123456789226" as UUID,
        agentId,
        entityId,
        category: LongTermMemoryCategory.SEMANTIC,
        content: "mid",
        embedding: [0.9, 0],
        confidence: 1,
        source: "",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "12345678-1234-1234-1234-123456789227" as UUID,
        agentId,
        entityId,
        category: LongTermMemoryCategory.SEMANTIC,
        content: "low",
        embedding: [0.2, 0],
        confidence: 1,
        source: "",
        createdAt: now,
        updatedAt: now,
      },
    ];

    // Override db access for test
    svc.getLongTermMemories = async () => memories;

    const results = await svc.searchLongTermMemories(entityId, [1, 0], 2, 0);
    expect(results.map((m) => m.content)).toEqual(["high", "mid"]);
  });

  test("getLongTermMemories returns empty when limit <= 0", async () => {
    const svc = new MemoryService({} as AgentRuntime);
    // Ensure db isn't touched when limit is 0
    (svc as unknown as { getDb: () => never }).getDb = () => {
      throw new Error("db access not expected");
    };

    const entityId = "12345678-1234-1234-1234-123456789228" as UUID;
    const results = await svc.getLongTermMemories(entityId, undefined, 0);
    expect(results).toEqual([]);
  });

  // ======================================================================
  // Config management tests
  // ======================================================================

  test("getConfig returns sensible defaults", () => {
    const svc = new MemoryService({} as AgentRuntime);
    const config = svc.getConfig();
    expect(config.shortTermSummarizationThreshold).toBeGreaterThan(0);
    expect(config.longTermExtractionThreshold).toBeGreaterThan(0);
    expect(config.longTermExtractionInterval).toBeGreaterThan(0);
    expect(config.longTermConfidenceThreshold).toBeGreaterThan(0);
  });

  test("updateConfig merges partial updates", () => {
    const svc = new MemoryService({} as AgentRuntime);
    const original = svc.getConfig();
    svc.updateConfig({ shortTermSummarizationThreshold: 999 });
    const updated = svc.getConfig();
    expect(updated.shortTermSummarizationThreshold).toBe(999);
    // Other fields preserved
    expect(updated.longTermExtractionThreshold).toBe(
      original.longTermExtractionThreshold,
    );
    expect(updated.longTermExtractionInterval).toBe(
      original.longTermExtractionInterval,
    );
  });

  test("getConfig returns a copy, not a reference", () => {
    const svc = new MemoryService({} as AgentRuntime);
    const config1 = svc.getConfig();
    config1.shortTermSummarizationThreshold = 12345;
    const config2 = svc.getConfig();
    expect(config2.shortTermSummarizationThreshold).not.toBe(12345);
  });

  // ======================================================================
  // Extraction checkpointing edge cases
  // ======================================================================

  test("independent entity/room pairs have separate checkpoints", async () => {
    const character: Character = {
      name: "CheckpointTest",
      bio: ["Test"],
      templates: {},
      messageExamples: [],
      postExamples: [],
      topics: [],
      adjectives: [],
      knowledge: [],
      advancedMemory: true,
      plugins: [],
      secrets: {},
    };
    const runtime = new AgentRuntime({ character });
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
    const svc = (await runtime.getServiceLoadPromise(
      "memory",
    )) as MemoryService;

    const entityA = "11111111-1111-1111-1111-111111111111" as UUID;
    const entityB = "22222222-2222-2222-2222-222222222222" as UUID;
    const room = "33333333-3333-3333-3333-333333333333" as UUID;

    await svc.setLastExtractionCheckpoint(entityA, room, 30);
    // entityB should still be able to run (no checkpoint)
    expect(await svc.shouldRunExtraction(entityB, room, 30)).toBe(true);
    // entityA should not (checkpoint just set at 30)
    expect(await svc.shouldRunExtraction(entityA, room, 30)).toBe(false);
  });

  test("extraction checkpoint respects interval boundaries", async () => {
    const character: Character = {
      name: "IntervalTest",
      bio: ["Test"],
      templates: {},
      messageExamples: [],
      postExamples: [],
      topics: [],
      adjectives: [],
      knowledge: [],
      advancedMemory: true,
      plugins: [],
      secrets: {},
    };
    const runtime = new AgentRuntime({ character });
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
    const svc = (await runtime.getServiceLoadPromise(
      "memory",
    )) as MemoryService;

    const config = svc.getConfig();
    const threshold = config.longTermExtractionThreshold;
    const interval = config.longTermExtractionInterval;

    const entity = "44444444-4444-4444-4444-444444444444" as UUID;
    const room = "55555555-5555-5555-5555-555555555555" as UUID;

    // Exactly at threshold, no checkpoint → should run
    expect(await svc.shouldRunExtraction(entity, room, threshold)).toBe(true);

    // Set checkpoint, then one message past → should not run (same interval)
    await svc.setLastExtractionCheckpoint(entity, room, threshold);
    expect(await svc.shouldRunExtraction(entity, room, threshold + 1)).toBe(
      false,
    );

    // Jump to next interval → should run
    expect(
      await svc.shouldRunExtraction(entity, room, threshold + interval),
    ).toBe(true);
  });

  // ======================================================================
  // Message counting
  // ======================================================================

  test("incrementMessageCount tracks per-room counts", () => {
    const svc = new MemoryService({} as AgentRuntime);
    const roomA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID;
    const roomB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as UUID;

    expect(svc.incrementMessageCount(roomA)).toBe(1);
    expect(svc.incrementMessageCount(roomA)).toBe(2);
    expect(svc.incrementMessageCount(roomB)).toBe(1);
    expect(svc.incrementMessageCount(roomA)).toBe(3);
  });

  // ======================================================================
  // Formatted long-term memory output
  // ======================================================================

  test("getFormattedLongTermMemories groups by category", async () => {
    const svc = new MemoryService({} as AgentRuntime);
    const now = new Date();
    const entityId = "12345678-1234-1234-1234-123456789300" as UUID;
    const agentId = "12345678-1234-1234-1234-123456789301" as UUID;

    const memories = [
      {
        id: "12345678-1234-1234-1234-123456789302" as UUID,
        agentId,
        entityId,
        category: LongTermMemoryCategory.SEMANTIC,
        content: "Likes coffee",
        confidence: 0.9,
        source: "",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "12345678-1234-1234-1234-123456789303" as UUID,
        agentId,
        entityId,
        category: LongTermMemoryCategory.EPISODIC,
        content: "Had a meeting yesterday",
        confidence: 0.85,
        source: "",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "12345678-1234-1234-1234-123456789304" as UUID,
        agentId,
        entityId,
        category: LongTermMemoryCategory.SEMANTIC,
        content: "Prefers dark mode",
        confidence: 0.88,
        source: "",
        createdAt: now,
        updatedAt: now,
      },
    ];

    svc.getLongTermMemories = async () => memories;
    const result = await svc.getFormattedLongTermMemories(entityId);

    expect(result).toContain("**Semantic**:");
    expect(result).toContain("**Episodic**:");
    expect(result).toContain("- Likes coffee");
    expect(result).toContain("- Prefers dark mode");
    expect(result).toContain("- Had a meeting yesterday");
  });

  test("getFormattedLongTermMemories returns empty string when no memories", async () => {
    const svc = new MemoryService({} as AgentRuntime);
    svc.getLongTermMemories = async () => [];

    const entityId = "12345678-1234-1234-1234-123456789305" as UUID;
    const result = await svc.getFormattedLongTermMemories(entityId);
    expect(result).toBe("");
  });

  test("getFormattedLongTermMemories with single category", async () => {
    const svc = new MemoryService({} as AgentRuntime);
    const now = new Date();
    const entityId = "12345678-1234-1234-1234-123456789306" as UUID;
    const agentId = "12345678-1234-1234-1234-123456789307" as UUID;

    svc.getLongTermMemories = async () => [
      {
        id: "12345678-1234-1234-1234-123456789308" as UUID,
        agentId,
        entityId,
        category: LongTermMemoryCategory.PROCEDURAL,
        content: "Knows how to ride a bike",
        confidence: 0.95,
        source: "",
        createdAt: now,
        updatedAt: now,
      },
    ];

    const result = await svc.getFormattedLongTermMemories(entityId);
    expect(result).toContain("**Procedural**:");
    expect(result).toContain("- Knows how to ride a bike");
    // Should NOT contain other category headers
    expect(result).not.toContain("**Semantic**:");
    expect(result).not.toContain("**Episodic**:");
  });
});
