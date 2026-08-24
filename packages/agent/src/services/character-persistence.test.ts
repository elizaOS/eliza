/**
 * Unit tests for ElizaCharacterPersistenceService and character sync into config.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.js";
import {
  CHARACTER_PERSISTENCE_SERVICE,
  ElizaCharacterPersistenceService,
  syncCharacterIntoConfig,
} from "./character-persistence.js";

describe("character-persistence", () => {
  it("exports valid service constants", () => {
    expect(CHARACTER_PERSISTENCE_SERVICE).toBe("eliza_character_persistence");
    expect(ElizaCharacterPersistenceService.serviceType).toBe(
      "eliza_character_persistence",
    );
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
