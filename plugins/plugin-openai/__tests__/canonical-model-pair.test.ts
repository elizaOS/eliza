/**
 * Covers canonical two-knob derivation (ELIZA_MODEL_SMALL/LARGE) through this
 * plugin's model getters: the pair feeds tiers when the OPENAI_* escape hatches
 * are unset, loses to them when set, wins over the Cerebras overlay's baked-in
 * default, and never crosses families. Deterministic — stub runtime settings.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { getLargeModel, getSmallModel } from "../utils/config";

const runtimeWith = (map: Record<string, string>) =>
  ({
    getSetting: (key: string) => map[key] ?? null,
  }) as unknown as IAgentRuntime;

describe("openai canonical model pair", () => {
  it("derives small/large from the pair when OPENAI_* are unset", () => {
    const runtime = runtimeWith({
      ELIZA_MODEL_SMALL: "gpt-5.6-mini",
      ELIZA_MODEL_LARGE: "gpt-5.6-sol",
    });
    expect(getSmallModel(runtime)).toBe("gpt-5.6-mini");
    expect(getLargeModel(runtime)).toBe("gpt-5.6-sol");
  });

  it("keeps OPENAI_* as the winning escape hatch", () => {
    const runtime = runtimeWith({
      OPENAI_SMALL_MODEL: "explicit-small",
      ELIZA_MODEL_SMALL: "canonical-small",
    });
    expect(getSmallModel(runtime)).toBe("explicit-small");
  });

  it("ignores a pair value qualified for another family", () => {
    const runtime = runtimeWith({
      ELIZA_MODEL_LARGE: "anthropic/claude-opus-4-8",
    });
    expect(getLargeModel(runtime)).toBe("gpt-5.6-sol");
  });

  it("beats the Cerebras overlay default but not its explicit keys", () => {
    const cerebras = (extra: Record<string, string>) =>
      runtimeWith({ ELIZA_PROVIDER: "cerebras", ...extra });

    expect(getSmallModel(cerebras({ ELIZA_MODEL_SMALL: "cerebras/llama-4-maverick" }))).toBe(
      "llama-4-maverick"
    );
    expect(
      getSmallModel(
        cerebras({
          CEREBRAS_SMALL_MODEL: "explicit-cerebras",
          ELIZA_MODEL_SMALL: "llama-4-maverick",
        })
      )
    ).toBe("explicit-cerebras");
    // Unqualified pair values flow into the overlay too.
    expect(getLargeModel(cerebras({ ELIZA_MODEL_LARGE: "qwen-3-235b" }))).toBe("qwen-3-235b");
  });

  it("changes nothing when the pair is unset", () => {
    expect(getSmallModel(runtimeWith({}))).toBe("gpt-5.6-luna");
    expect(getLargeModel(runtimeWith({}))).toBe("gpt-5.6-sol");
  });
});
