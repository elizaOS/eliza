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
    expect(body.character.plugins).toContain("@elizaos/plugin-dflow-trade");
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
    expect(solizardCheshireCharacter.plugins).toContain(
      "@elizaos/plugin-dflow-trade",
    );
  });

  it("matches elizaOS plugin order: sql → bootstrap → model → domain", () => {
    const p = solizardCheshireCharacter.plugins;
    const sql = p.indexOf("@elizaos/plugin-sql");
    const boot = p.indexOf("@elizaos/plugin-bootstrap");
    const openai = p.indexOf("@elizaos/plugin-openai");
    const dflow = p.indexOf("@elizaos/plugin-dflow-trade");
    expect(sql).toBeGreaterThanOrEqual(0);
    expect(boot).toBeGreaterThan(sql);
    expect(openai).toBeGreaterThan(boot);
    expect(dflow).toBeGreaterThan(openai);
  });

  it("includes multi-action messageExamples for ActionPlan", () => {
    const multi = solizardCheshireCharacter.messageExamples.some((ex) =>
      ex.some(
        (m) =>
          Array.isArray(m.content.actions) && m.content.actions.length >= 2,
      ),
    );
    expect(multi).toBe(true);
    expect(solizardCheshireCharacter.system).toMatch(/ActionPlan|multi-step/i);
  });
});
