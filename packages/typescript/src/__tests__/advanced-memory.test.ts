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
});
