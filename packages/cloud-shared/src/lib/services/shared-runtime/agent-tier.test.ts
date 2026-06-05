import { describe, expect, it } from "bun:test";
import {
  type AgentTier,
  getAgentTier,
  isSharedEligible,
  tierProvisionsEagerly,
  tierRequiresContainer,
} from "./agent-tier";
import { runSharedAgentTurn } from "./run-shared-agent-turn";

describe("getAgentTier", () => {
  it("defaults a plain agent to shared (no container)", () => {
    expect(getAgentTier({})).toBe("shared");
    expect(getAgentTier({ plugins: ["@elizaos/plugin-bootstrap", "@elizaos/plugin-sql"] })).toBe(
      "shared",
    );
  });

  it("escalates a custom docker image to 'custom'", () => {
    expect(getAgentTier({ dockerImage: "ghcr.io/dexploarer/x:latest" })).toBe("custom");
    expect(getAgentTier({ dockerImage: "   " })).toBe("shared"); // blank image is not custom
  });

  it("escalates the always-on toggle / too-large model / stateful runtime to dedicated-always", () => {
    expect(getAgentTier({ alwaysOn: true })).toBe("dedicated-always");
    expect(getAgentTier({ modelTooLargeForShared: true })).toBe("dedicated-always");
    expect(getAgentTier({ statefulRuntime: true })).toBe("dedicated-always");
  });

  it("escalates persistent-connection plugins to dedicated-always", () => {
    expect(getAgentTier({ plugins: ["@elizaos/plugin-discord"] })).toBe("dedicated-always");
    expect(getAgentTier({ plugins: ["@elizaos/plugin-telegram"] })).toBe("dedicated-always");
    expect(getAgentTier({ plugins: ["some-twitter-gateway"] })).toBe("dedicated-always");
  });

  it("custom image wins over always-on", () => {
    expect(getAgentTier({ dockerImage: "x:1", alwaysOn: true })).toBe("custom");
  });
});

describe("tier helpers", () => {
  it("isSharedEligible is true only for the shared tier", () => {
    expect(isSharedEligible({})).toBe(true);
    expect(isSharedEligible({ alwaysOn: true })).toBe(false);
    expect(isSharedEligible({ dockerImage: "x:1" })).toBe(false);
  });

  it("tierRequiresContainer is false only for shared", () => {
    const cases: Array<[AgentTier, boolean]> = [
      ["shared", false],
      ["dedicated-lazy", true],
      ["dedicated-always", true],
      ["custom", true],
    ];
    for (const [tier, expected] of cases) expect(tierRequiresContainer(tier)).toBe(expected);
  });

  it("tierProvisionsEagerly only for always-on + custom", () => {
    expect(tierProvisionsEagerly("shared")).toBe(false);
    expect(tierProvisionsEagerly("dedicated-lazy")).toBe(false);
    expect(tierProvisionsEagerly("dedicated-always")).toBe(true);
    expect(tierProvisionsEagerly("custom")).toBe(true);
  });
});

describe("runSharedAgentTurn (degraded path — no model configured)", () => {
  it("never throws and appends user+assistant to history when no shared model is set", async () => {
    // In test there is no CEREBRAS_API_KEY/OPENAI_API_KEY -> resolveSharedModel() is null,
    // so this exercises the degraded path with NO network call.
    const result = await runSharedAgentTurn({
      character: { name: "Nova", system: "You are Nova, a concise helper." },
      history: [],
      message: "  hello there  ",
    });
    expect(result.degraded).toBe(true);
    expect(result.reply).toContain("Nova");
    expect(result.history).toHaveLength(2);
    expect(result.history[0]).toEqual({ role: "user", content: "hello there" });
    expect(result.history[1]?.role).toBe("assistant");
  });
});
