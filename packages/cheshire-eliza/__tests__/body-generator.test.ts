import { describe, expect, it } from "vitest";
import { generateAgentBody } from "../src/body-generator/index.ts";
import { solizardCheshireCharacter } from "../src/characters/solizard-cheshire.ts";

describe("cheshire-eliza body generator", () => {
  it("generates character with forge + e2b + memory plugins", () => {
    const body = generateAgentBody({
      name: "ClawdScout",
      archetype: "trader",
      rails: ["solana", "robinhood"],
    });
    expect(body.character.name).toBe("ClawdScout");
    expect(body.character.plugins).toContain("@elizaos/plugin-robinhood");
    expect(body.character.plugins).toContain("@elizaos/plugin-solana-forging");
    expect(body.character.plugins).toContain("@elizaos/plugin-e2b-computer");
    expect(body.character.plugins).toContain("@elizaos/plugin-cheshire-memory");
    expect(body.character.plugins).toContain("@elizaos/plugin-clawdbrowser");
    expect(body.visualPrompt.toLowerCase()).toContain("clawdscout");
    expect(body.bodyMeta.rails).toEqual(["solana", "robinhood"]);
  });

  it("ships Solizard character with Cheshire plugin bundle", () => {
    expect(solizardCheshireCharacter.name).toBe("Solizard");
    expect(solizardCheshireCharacter.plugins).toContain(
      "@elizaos/plugin-cheshire-memory",
    );
    expect(solizardCheshireCharacter.plugins).toContain(
      "@elizaos/plugin-clawdbrowser",
    );
  });
});
