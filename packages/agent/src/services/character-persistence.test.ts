/**
 * Verifies host character persistence through the assistant port, with real
 * temporary config files and deterministic database/history collaborators.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { getCharacterPersistenceService } from "@elizaos/plugin-assistant/character-persistence";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.js";
import {
  ElizaCharacterPersistenceService,
  syncCharacterIntoConfig,
} from "./character-persistence.js";

describe("character-persistence", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("resolves the host through the assistant port and persists all three sinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "character-persistence-"));
    const configPath = join(directory, "eliza.json");
    vi.stubEnv("ELIZA_STATE_DIR", directory);
    vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
    vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
    const updateAgent = vi.fn().mockResolvedValue(true);
    const createMemory = vi.fn().mockResolvedValue("history-id");
    const runtime = {
      agentId: "00000000-0000-4000-8000-000000000001",
      character: { name: "Before" },
      updateAgent,
      createMemory,
      getService: (name: string) =>
        name === ElizaCharacterPersistenceService.serviceType ? service : null,
    } as unknown as IAgentRuntime;
    const service = await ElizaCharacterPersistenceService.start(runtime);
    try {
      const port = getCharacterPersistenceService(runtime);
      expect(port).not.toBeNull();
      const result = await port?.persistCharacter({
        character: { name: "After", system: "Preserve complete instructions." },
        previousCharacter: runtime.character,
        source: "restore",
      });
      expect(result).toEqual({ success: true });
      const config = JSON.parse(await readFile(configPath, "utf8"));
      expect(config.agents.list[0].name).toBe("After");
      expect(config.ui.assistant.name).toBe("After");
      expect(updateAgent).toHaveBeenCalledWith(runtime.agentId, {
        name: "After",
        metadata: {
          character: {
            name: "After",
            system: "Preserve complete instructions.",
          },
        },
      });
      expect(createMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            action: "character_restored",
            historySource: "restore",
            before: { name: "Before" },
            after: { name: "After", system: "Preserve complete instructions." },
          }),
        }),
        "character_modifications",
      );
    } finally {
      await service.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("syncs character properties into ElizaConfig", () => {
    const config: ElizaConfig = {
      agents: {
        list: [{ id: "main", default: true }],
      },
    };

    const character = {
      name: "Eliza Assistant",
      username: "eliza",
      bio: ["Helpful assistant", "Powered by elizaOS"],
      system: "You are Eliza.",
      adjectives: ["friendly", "smart"],
      topics: ["coding", "crypto"],
      style: {
        all: ["concise"],
        chat: ["direct"],
        post: ["thoughtful"],
      },
      postExamples: ["Hello world"],
      messageExamples: [[{ user: "user", content: { text: "Hi" } }]],
    };

    const updatedAgent = syncCharacterIntoConfig(config, character);

    expect(updatedAgent.name).toBe("Eliza Assistant");
    expect(updatedAgent.username).toBe("eliza");
    expect(updatedAgent.bio).toEqual([
      "Helpful assistant",
      "Powered by elizaOS",
    ]);
    expect(updatedAgent.system).toBe("You are Eliza.");
    expect(updatedAgent.adjectives).toEqual(["friendly", "smart"]);
    expect(updatedAgent.topics).toEqual(["coding", "crypto"]);

    // Verify UI assistant synchronization
    expect(config.ui?.assistant?.name).toBe("Eliza Assistant");
  });

  it("instantiates and starts service correctly", async () => {
    const mockRuntime = {
      agentId: "test-agent" as UUID,
      character: { name: "Test Character" },
      updateAgent: vi.fn().mockResolvedValue(true),
    } as unknown as IAgentRuntime;

    const service = await ElizaCharacterPersistenceService.start(mockRuntime);
    expect(service).toBeDefined();
    expect(service.capabilityDescription).toBeDefined();
    await service.stop();
  });
});
