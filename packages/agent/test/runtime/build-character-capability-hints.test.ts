import { describe, expect, it } from "vitest";
import type { ElizaConfig } from "../../src/config/config.js";
import { buildCharacterFromConfig } from "../../src/runtime/build-character-config.js";

describe("buildCharacterFromConfig capability hints (regression for #7362 Bug A)", () => {
  it("appends a task-manager capability hint to the system prompt so the agent does not deny CREATE_TASK / persistence", () => {
    const config: ElizaConfig = {
      ui: { presetId: "chen" },
    };

    const character = buildCharacterFromConfig(config);

    expect(character.system).toBeDefined();
    expect(character.system).toMatch(/persistent task manager/i);
    expect(character.system).toMatch(/do not claim you lack tasks/i);
  });

  it("preserves the user's preset / character system prompt before appending hints", () => {
    const userSystem = "You are Chen, a helpful assistant.";
    const config: ElizaConfig = {
      agents: {
        list: [
          {
            name: "Chen",
            bio: ["bio"],
            system: userSystem,
          },
        ],
      },
    };

    const character = buildCharacterFromConfig(config);

    expect(character.system?.startsWith(userSystem)).toBe(true);
    expect(character.system).toMatch(/persistent task manager/i);
  });
});
