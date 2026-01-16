import { describe, expect, test } from "vitest";
import type { MemoryService } from "../advanced-memory";
import { AgentRuntime } from "../runtime";
import type { Character, UUID } from "../types";

describe("advanced memory (built-in)", () => {
  test("auto-loads providers + evaluators + memory service when enabled", async () => {
    const character: Character = {
      name: "AdvMemory",
      bio: "Test",
      advancedMemory: true,
      plugins: [],
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
      bio: "Test",
      advancedMemory: false,
      plugins: [],
    };

    const runtime = new AgentRuntime({ character });
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });

    expect(runtime.hasService("memory")).toBe(false);
    expect(runtime.providers.some((p) => p.name === "LONG_TERM_MEMORY")).toBe(
      false,
    );
  });
});
