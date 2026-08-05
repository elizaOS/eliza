import { describe, expect, it } from "vitest";
import { buildMintAgentIntent } from "../src/actions/mint-agent.ts";
import { readSolanaForgeConfig } from "../src/config.ts";

describe("plugin-solana-forging", () => {
  it("defaults to preview mint intent", () => {
    const cfg = readSolanaForgeConfig(() => undefined);
    expect(cfg.liveEnabled).toBe(false);
    const intent = buildMintAgentIntent({ name: "ClawdScout", cfg });
    expect(intent.unsigned).toBe(true);
    expect(intent.mode).toBe("preview");
    expect(intent.rails).toEqual(["solana"]);
  });

  it("adds robinhood rail when omni enabled", () => {
    const cfg = readSolanaForgeConfig((k) =>
      k === "CHESHIRE_OMNI_MINT" ? "true" : undefined,
    );
    const intent = buildMintAgentIntent({ name: "DualRail", cfg });
    expect(intent.rails).toContain("robinhood");
  });
});
