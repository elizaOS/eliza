import { describe, it, expect } from "vitest";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { trustPolicyProvider } from "./trust-policy.js";
import { setScoutConfig } from "../runtime-store.js";
import type { ScoutPluginConfig } from "../config.js";

function makeRuntime(): IAgentRuntime {
  return { agentId: "agent-1" } as unknown as IAgentRuntime;
}

function makeMessage(): Memory {
  return { content: { text: "" }, userId: "u", agentId: "a", roomId: "r" } as Memory;
}

describe("trustPolicyProvider", () => {
  it("returns empty text when config not set", async () => {
    const runtime = makeRuntime();
    const result = await trustPolicyProvider.get(runtime, makeMessage(), {} as State);
    expect(result).toEqual({ text: "" });
  });

  it("returns policy text with min score and flags", async () => {
    const runtime = makeRuntime();
    setScoutConfig(runtime, {
      apiUrl: "https://api.scoutscore.ai",
      minServiceScore: 40,
      autoRejectFlags: ["WALLET_SPAM_FARM", "NO_SCHEMA"],
      watchedDomains: [],
      watchInterval: 60,
    } as ScoutPluginConfig);

    const result = await trustPolicyProvider.get(runtime, makeMessage(), {} as State);

    expect(result.text).toContain("Minimum service trust score 40/100");
    expect(result.text).toContain("WALLET_SPAM_FARM, NO_SCHEMA");
    expect(result.text).toContain("below USABLE are blocked");
    expect(result.values).toEqual({
      scoutMinScore: 40,
      scoutAutoRejectFlags: ["WALLET_SPAM_FARM", "NO_SCHEMA"],
    });
    expect(result.data).toEqual({
      scoutPolicy: {
        minServiceScore: 40,
        autoRejectFlags: ["WALLET_SPAM_FARM", "NO_SCHEMA"],
      },
    });
  });

  it("handles empty auto-reject flags list", async () => {
    const runtime = makeRuntime();
    setScoutConfig(runtime, {
      apiUrl: "https://api.scoutscore.ai",
      minServiceScore: 50,
      autoRejectFlags: [],
      watchedDomains: [],
      watchInterval: 60,
    } as ScoutPluginConfig);

    const result = await trustPolicyProvider.get(runtime, makeMessage(), {} as State);

    expect(result.text).toContain("Auto-reject flags: .");
    expect(result.values.scoutAutoRejectFlags).toEqual([]);
  });
});