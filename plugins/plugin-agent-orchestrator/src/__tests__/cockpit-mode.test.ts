import { describe, expect, it } from "vitest";
import {
  type CockpitModeConfig,
  ELIZA_CLOUD_TIER_MODEL,
  cockpitModeRequiresExperimentalGate,
  cockpitModeToProviderPolicy,
  cockpitModeToSpawnOverrides,
  describeCockpitMode,
} from "../services/cockpit-mode.js";

describe("cockpit-mode", () => {
  describe("ELIZA_CLOUD_TIER_MODEL", () => {
    it("pins small=gpt-oss-120b (fast), large=zai-glm-4.7 (smart)", () => {
      expect(ELIZA_CLOUD_TIER_MODEL.small).toBe("gpt-oss-120b");
      expect(ELIZA_CLOUD_TIER_MODEL.large).toBe("zai-glm-4.7");
    });
  });

  describe("cockpitModeToProviderPolicy", () => {
    it("eliza-cloud small → eliza-code on eliza-cloud / gpt-oss-120b", () => {
      expect(
        cockpitModeToProviderPolicy({
          mode: "eliza-cloud",
          agentType: "elizaos",
          tier: "small",
        }),
      ).toEqual({
        preferredFramework: "elizaos",
        providerSource: "eliza-cloud",
        model: "gpt-oss-120b",
      });
    });

    it("eliza-cloud large → zai-glm-4.7", () => {
      expect(
        cockpitModeToProviderPolicy({
          mode: "eliza-cloud",
          agentType: "elizaos",
          tier: "large",
        }).model,
      ).toBe("zai-glm-4.7");
    });

    it("opencode also sources from eliza-cloud (Cerebras), no forced model", () => {
      expect(
        cockpitModeToProviderPolicy({ mode: "opencode", agentType: "opencode" }),
      ).toEqual({ preferredFramework: "opencode", providerSource: "eliza-cloud" });
    });

    it("opencode carries an explicit model only when provided", () => {
      expect(
        cockpitModeToProviderPolicy({
          mode: "opencode",
          agentType: "opencode",
          model: "qwen-3-coder",
        }).model,
      ).toBe("qwen-3-coder");
    });

    it("subscription claude → user-claude, codex → user-openai", () => {
      expect(
        cockpitModeToProviderPolicy({ mode: "subscription", agentType: "claude" })
          .providerSource,
      ).toBe("user-claude");
      expect(
        cockpitModeToProviderPolicy({ mode: "subscription", agentType: "codex" })
          .providerSource,
      ).toBe("user-openai");
    });

    it("experimental lowers to the same policy as its subscription counterpart", () => {
      const sub = cockpitModeToProviderPolicy({
        mode: "subscription",
        agentType: "claude",
      });
      const exp = cockpitModeToProviderPolicy({
        mode: "experimental",
        agentType: "claude",
        proxy: "anthropic-proxy",
      });
      expect(exp).toEqual(sub);
    });
  });

  describe("cockpitModeToSpawnOverrides", () => {
    it("emits agentType for every mode and model only when resolved", () => {
      expect(
        cockpitModeToSpawnOverrides({
          mode: "eliza-cloud",
          agentType: "elizaos",
          tier: "small",
        }),
      ).toEqual({ agentType: "elizaos", model: "gpt-oss-120b" });
      expect(
        cockpitModeToSpawnOverrides({ mode: "opencode", agentType: "opencode" }),
      ).toEqual({ agentType: "opencode" });
      expect(
        cockpitModeToSpawnOverrides({ mode: "subscription", agentType: "codex" }),
      ).toEqual({ agentType: "codex" });
    });
  });

  describe("cockpitModeRequiresExperimentalGate", () => {
    it("is true only for experimental modes", () => {
      const exp: CockpitModeConfig = {
        mode: "experimental",
        agentType: "codex",
        proxy: "codex-cli",
      };
      const sub: CockpitModeConfig = { mode: "subscription", agentType: "codex" };
      expect(cockpitModeRequiresExperimentalGate(exp)).toBe(true);
      expect(cockpitModeRequiresExperimentalGate(sub)).toBe(false);
    });
  });

  describe("describeCockpitMode", () => {
    it("labels each mode for the picker", () => {
      expect(
        describeCockpitMode({
          mode: "eliza-cloud",
          agentType: "elizaos",
          tier: "small",
        }),
      ).toEqual({ title: "Eliza Cloud", subtitle: "Fast · gpt-oss-120b", badge: "cloud" });
      expect(
        describeCockpitMode({ mode: "eliza-cloud", agentType: "elizaos", tier: "large" })
          .subtitle,
      ).toBe("Smart · zai-glm-4.7");
      expect(
        describeCockpitMode({ mode: "opencode", agentType: "opencode" }),
      ).toEqual({ title: "OpenCode", subtitle: "Cerebras", badge: "cloud" });
      expect(
        describeCockpitMode({ mode: "subscription", agentType: "claude" }),
      ).toEqual({ title: "Claude", subtitle: "Your subscription", badge: "sub" });
      expect(
        describeCockpitMode({
          mode: "subscription",
          agentType: "claude",
          auth: "api_keys",
        }).subtitle,
      ).toBe("Your API key");
      expect(
        describeCockpitMode({
          mode: "experimental",
          agentType: "codex",
          proxy: "codex-cli",
        }),
      ).toEqual({
        title: "Codex (experimental)",
        subtitle: "Replay proxy · TOS-unsafe",
        badge: "exp",
      });
    });
  });
});
