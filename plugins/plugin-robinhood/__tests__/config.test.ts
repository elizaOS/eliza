import { describe, expect, it } from "vitest";
import { buildRegisterAgentIntent } from "../src/actions/register-agent.ts";
import { readRobinhoodConfig, validateForgeReadiness } from "../src/config.ts";

describe("plugin-robinhood config", () => {
  it("defaults to preview (not live)", () => {
    const cfg = readRobinhoodConfig(() => undefined);
    expect(cfg.liveEnabled).toBe(false);
    expect(cfg.chainId).toBe(4663);
  });

  it("reads registry env keys", () => {
    const map: Record<string, string> = {
      CHESHIRE_IDENTITY_REGISTRY: "0xabc",
      ROBINHOOD_LIVE: "true",
    };
    const cfg = readRobinhoodConfig((k) => map[k]);
    expect(cfg.identityRegistry).toBe("0xabc");
    expect(cfg.liveEnabled).toBe(true);
    expect(validateForgeReadiness(cfg)).toEqual([]);
  });

  it("builds unsigned registration intent", () => {
    const cfg = readRobinhoodConfig((k) =>
      k === "CHESHIRE_IDENTITY_REGISTRY" ? "0xreg" : undefined,
    );
    const intent = buildRegisterAgentIntent({ name: "Solizard", cfg });
    expect(intent.unsigned).toBe(true);
    expect(intent.name).toBe("Solizard");
    expect(intent.agentUri).toContain("Solizard");
    expect(intent.mode).toBe("preview");
  });
});
