import { describe, expect, test } from "vitest";
import { character } from "../character";

// Helper to get bio as string
function getBioString(): string {
  if (typeof character.bio === "string") return character.bio;
  if (Array.isArray(character.bio)) return character.bio.join(" ");
  return "";
}

// =============================================================================
// Tests: Character Definition Validity
// =============================================================================

describe("Character Definition", () => {
  test("has required name", () => {
    expect(character.name).toBe("LPManager");
    expect(character.name).toBeTruthy();
  });

  test("has bio description", () => {
    expect(character.bio).toBeTruthy();
    const bio = getBioString();
    expect(bio.length).toBeGreaterThan(50);
  });

  test("bio mentions key capabilities", () => {
    const bio = getBioString().toLowerCase();
    expect(bio).toContain("liquidity");
    expect(bio).toContain("solana");
    expect(bio).toContain("evm");
  });

  test("has system prompt", () => {
    expect(character.system).toBeTruthy();
    expect(typeof character.system).toBe("string");
    expect(character.system?.length).toBeGreaterThan(100);
  });

  test("system prompt covers core objectives", () => {
    const system = (character.system ?? "").toLowerCase();
    expect(system).toContain("monitor");
    expect(system).toContain("analyze");
    expect(system).toContain("optimize");
    expect(system).toContain("execute");
  });

  test("has relevant topics", () => {
    expect(Array.isArray(character.topics)).toBe(true);
    expect(character.topics?.length).toBeGreaterThan(5);

    const topics = character.topics?.map((t) => t.toLowerCase());
    expect(topics).toContain("liquidity pools");
    expect(topics).toContain("yield farming");
  });

  test("has adjectives for personality", () => {
    expect(Array.isArray(character.adjectives)).toBe(true);
    expect(character.adjectives?.length).toBeGreaterThan(3);
    expect(character.adjectives).toContain("analytical");
  });

  test("has style guidelines", () => {
    expect(character.style).toBeDefined();
    expect(character.style?.all).toBeDefined();
    expect(Array.isArray(character.style?.all)).toBe(true);
    expect(character.style?.all?.length).toBeGreaterThan(0);
  });

  test("has message examples", () => {
    expect(Array.isArray(character.messageExamples)).toBe(true);
    const examples = character.messageExamples ?? [];
    expect(examples.length).toBeGreaterThan(0);

    // Each example should be a group with examples
    const firstExample = examples[0];
    expect(Array.isArray(firstExample?.examples)).toBe(true);
    expect(firstExample?.examples?.length).toBeGreaterThan(0);
  });

  test("message examples have proper structure", () => {
    const examples = character.messageExamples ?? [];
    const firstGroup = examples[0];
    const example = firstGroup?.examples?.[0];
    expect(example).toHaveProperty("name");
    expect(example).toHaveProperty("content");
    expect(example?.content).toHaveProperty("text");
  });
});

// =============================================================================
// Tests: Character Settings
// =============================================================================

describe("Character Settings", () => {
  test("has settings defined", () => {
    expect(character.settings).toBeDefined();
    expect(typeof character.settings).toBe("object");
  });

  test("has check interval setting", () => {
    expect(character.settings?.LP_CHECK_INTERVAL_MS).toBeDefined();
    const interval = Number(character.settings?.LP_CHECK_INTERVAL_MS);
    expect(interval).toBeGreaterThan(0);
    expect(interval).toBe(300000); // 5 minutes
  });

  test("has gain threshold setting", () => {
    expect(character.settings?.LP_MIN_GAIN_THRESHOLD_PERCENT).toBeDefined();
    const threshold = Number(character.settings?.LP_MIN_GAIN_THRESHOLD_PERCENT);
    expect(threshold).toBe(1.0);
  });

  test("has max slippage setting", () => {
    expect(character.settings?.LP_MAX_SLIPPAGE_BPS).toBeDefined();
    const slippage = Number(character.settings?.LP_MAX_SLIPPAGE_BPS);
    expect(slippage).toBe(50); // 0.5%
    expect(slippage).toBeLessThanOrEqual(100); // Reasonable upper bound
  });

  test("has auto rebalance setting", () => {
    expect(character.settings?.LP_AUTO_REBALANCE_ENABLED).toBeDefined();
    expect(character.settings?.LP_AUTO_REBALANCE_ENABLED).toBe("true");
  });

  test("has concentrated reposition threshold", () => {
    expect(
      character.settings?.LP_CONCENTRATED_REPOSITION_THRESHOLD,
    ).toBeDefined();
    const threshold = Number(
      character.settings?.LP_CONCENTRATED_REPOSITION_THRESHOLD,
    );
    expect(threshold).toBe(0.1); // 10%
    expect(threshold).toBeGreaterThan(0);
    expect(threshold).toBeLessThan(1);
  });

  test("has Solana DEX preferences", () => {
    expect(character.settings?.LP_SOLANA_DEXES).toBeDefined();
    const solanaDexes = String(character.settings?.LP_SOLANA_DEXES);
    const dexes = solanaDexes.split(",");
    expect(dexes).toContain("raydium");
    expect(dexes).toContain("orca");
    expect(dexes).toContain("meteora");
  });

  test("has EVM DEX preferences", () => {
    expect(character.settings?.LP_EVM_DEXES).toBeDefined();
    const evmDexes = String(character.settings?.LP_EVM_DEXES);
    const dexes = evmDexes.split(",");
    expect(dexes).toContain("uniswap");
    expect(dexes).toContain("aerodrome");
  });

  test("has risk management settings", () => {
    expect(character.settings?.LP_MAX_POSITION_SIZE_USD).toBeDefined();
    expect(character.settings?.LP_MIN_POOL_TVL_USD).toBeDefined();
    expect(character.settings?.LP_MAX_IL_RISK_PERCENT).toBeDefined();

    const maxPosition = Number(character.settings?.LP_MAX_POSITION_SIZE_USD);
    const minTvl = Number(character.settings?.LP_MIN_POOL_TVL_USD);
    const maxIl = Number(character.settings?.LP_MAX_IL_RISK_PERCENT);

    expect(maxPosition).toBe(10000);
    expect(minTvl).toBe(100000);
    expect(maxIl).toBe(10);
  });

  test("all settings are strings", () => {
    const settings = character.settings ?? {};
    for (const [_key, value] of Object.entries(settings)) {
      expect(typeof value).toBe("string");
    }
  });

  test("settings values are valid numbers when parsed", () => {
    const numericSettings = [
      "LP_CHECK_INTERVAL_MS",
      "LP_MIN_GAIN_THRESHOLD_PERCENT",
      "LP_MAX_SLIPPAGE_BPS",
      "LP_CONCENTRATED_REPOSITION_THRESHOLD",
      "LP_MAX_POSITION_SIZE_USD",
      "LP_MIN_POOL_TVL_USD",
      "LP_MAX_IL_RISK_PERCENT",
    ];

    for (const key of numericSettings) {
      const value = character.settings?.[key];
      const parsed = Number(value);
      expect(Number.isNaN(parsed)).toBe(false);
    }
  });
});

// =============================================================================
// Tests: Character Consistency
// =============================================================================

describe("Character Consistency", () => {
  test("name appears in message examples", () => {
    const hasCharacterInExamples = character.messageExamples?.some((convo) =>
      convo.some((msg) => msg.name === character.name),
    );
    expect(hasCharacterInExamples).toBe(true);
  });

  test("bio and system are aligned", () => {
    // Both should mention similar capabilities
    const bio = getBioString().toLowerCase();
    const system = (character.system ?? "").toLowerCase();

    // Both should mention monitoring/tracking
    expect(bio).toMatch(/monitor|track|manage/);
    expect(system).toMatch(/monitor|track|manage/);
  });

  test("topics align with described capabilities", () => {
    const bio = getBioString().toLowerCase();
    const _system = (character.system ?? "").toLowerCase();
    const topics = (character.topics ?? []).map((t) => t.toLowerCase());

    // If bio mentions Solana, topics should include Solana-related items
    if (bio.includes("solana")) {
      expect(
        topics.some(
          (t) =>
            t.includes("raydium") ||
            t.includes("orca") ||
            t.includes("meteora"),
        ),
      ).toBe(true);
    }

    // If bio mentions EVM, topics should include EVM DEXes
    if (bio.includes("evm")) {
      expect(
        topics.some(
          (t) =>
            t.includes("uniswap") ||
            t.includes("pancakeswap") ||
            t.includes("aerodrome"),
        ),
      ).toBe(true);
    }
  });

  test("style guidelines are actionable", () => {
    for (const styleKey of ["all", "chat", "post"] as const) {
      const guidelines = character.style?.[styleKey];
      if (guidelines) {
        for (const guideline of guidelines) {
          // Each guideline should be a non-empty instructive string
          expect(guideline.length).toBeGreaterThanOrEqual(10);
          // Should contain action verbs
          expect(guideline).toMatch(
            /[A-Z]|use|be|provide|explain|share|report/i,
          );
        }
      }
    }
  });
});
