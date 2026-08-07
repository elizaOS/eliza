import { describe, expect, it } from "vitest";
import { generateAgentBody } from "../src/body-generator/index.ts";
import { solizardCheshireCharacter } from "../src/characters/solizard-cheshire.ts";
import {
  CLAWD_CODE_GITHUB,
  CLAWD_INTEGRATION_EDGES,
  CLAWD_MONOREPO_PATHS,
  CLAWD_PACKAGE_NAMES,
  clawdStackSummary,
} from "../src/clawd-bridge.ts";
import {
  CHESHIRE_CLAWD_CLI_COMPANIONS,
  CHESHIRE_ELIZA_PLUGINS,
} from "../src/index.ts";

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
    expect(body.character.bio.join(" ")).toMatch(/Solizardking\/clawd-code/);
    expect(body.character.system).toMatch(/plugins\/clawd-code/);
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
    expect(solizardCheshireCharacter.system).toMatch(
      /github\.com\/Solizardking\/clawd-code/,
    );
    expect(solizardCheshireCharacter.topics).toContain("Clawd Code CLI");
  });

  it("exports clawd monorepo bridge constants aligned with plugins", () => {
    expect(CLAWD_CODE_GITHUB).toBe("https://github.com/Solizardking/clawd-code");
    expect(CLAWD_MONOREPO_PATHS.clawdCode).toBe("plugins/clawd-code");
    expect(CLAWD_MONOREPO_PATHS.clawdPlugin).toBe("plugins/clawd-plugin");
    expect(CLAWD_PACKAGE_NAMES.memory).toBe("@elizaos/plugin-cheshire-memory");
    expect(CLAWD_PACKAGE_NAMES.clawdBrowser).toBe(
      "@elizaos/plugin-clawdbrowser",
    );
    expect(CHESHIRE_ELIZA_PLUGINS).toContain("@elizaos/plugin-cheshire-memory");
    expect(CHESHIRE_ELIZA_PLUGINS).toContain("@elizaos/plugin-clawdbrowser");
    expect(CHESHIRE_CLAWD_CLI_COMPANIONS).toContain("@solana-clawd/clawd-code");
    expect(CHESHIRE_CLAWD_CLI_COMPANIONS).toContain(
      "@solana-clawd/clawd-plugin",
    );
    expect(CLAWD_INTEGRATION_EDGES.length).toBeGreaterThanOrEqual(4);
    expect(clawdStackSummary()).toMatch(/plugins\/clawd-code/);
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
