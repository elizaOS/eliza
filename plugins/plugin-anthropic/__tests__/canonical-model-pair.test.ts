/**
 * Covers canonical two-knob derivation (ELIZA_MODEL_SMALL/LARGE) through this
 * plugin's model getters: the pair feeds small/large when the ANTHROPIC_*
 * escape hatches are unset, loses to them when set, sits above the bare
 * SMALL_MODEL/LARGE_MODEL aliases, and never crosses families. Deterministic —
 * stub runtime settings with the relevant env keys cleared per test.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLargeModel, getSmallModel } from "../utils/config";

const runtimeWith = (map: Record<string, string>) =>
  ({ getSetting: (key: string) => map[key] }) as unknown as IAgentRuntime;

const ENV_KEYS = [
  "ANTHROPIC_SMALL_MODEL",
  "ANTHROPIC_LARGE_MODEL",
  "SMALL_MODEL",
  "LARGE_MODEL",
  "ELIZA_MODEL_SMALL",
  "ELIZA_MODEL_LARGE",
];
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});
afterEach(() => {
  process.env = { ...originalEnv };
});

describe("anthropic canonical model pair", () => {
  it("derives small/large from the pair when ANTHROPIC_* are unset", () => {
    const runtime = runtimeWith({
      ELIZA_MODEL_SMALL: "claude-haiku-4-5",
      ELIZA_MODEL_LARGE: "claude-opus-4-9",
    });
    expect(getSmallModel(runtime)).toBe("claude-haiku-4-5");
    expect(getLargeModel(runtime)).toBe("claude-opus-4-9");
  });

  it("reads the pair from the environment when runtime settings are silent", () => {
    process.env.ELIZA_MODEL_SMALL = "claude-haiku-4-5";
    expect(getSmallModel(runtimeWith({}))).toBe("claude-haiku-4-5");
  });

  it("keeps ANTHROPIC_* as the winning escape hatch but beats the bare alias", () => {
    expect(
      getSmallModel(
        runtimeWith({
          ANTHROPIC_SMALL_MODEL: "explicit-small",
          ELIZA_MODEL_SMALL: "canonical-small",
        })
      )
    ).toBe("explicit-small");
    expect(
      getSmallModel(
        runtimeWith({
          ELIZA_MODEL_SMALL: "canonical-small",
          SMALL_MODEL: "bare-small",
        })
      )
    ).toBe("canonical-small");
  });

  it("honors anthropic/claude-qualified values and skips other families", () => {
    expect(getLargeModel(runtimeWith({ ELIZA_MODEL_LARGE: "anthropic/claude-opus-4-9" }))).toBe(
      "claude-opus-4-9"
    );
    expect(getSmallModel(runtimeWith({ ELIZA_MODEL_SMALL: "claude/claude-haiku-4-5" }))).toBe(
      "claude-haiku-4-5"
    );
    // A pair value qualified for another family falls through to the bare
    // alias, then the package default — never to an Anthropic request.
    expect(
      getLargeModel(
        runtimeWith({ ELIZA_MODEL_LARGE: "openai/gpt-5.6-sol", LARGE_MODEL: "bare-large" })
      )
    ).toBe("bare-large");
    expect(getLargeModel(runtimeWith({ ELIZA_MODEL_LARGE: "openai/gpt-5.6-sol" }))).toBe(
      "claude-opus-4-8"
    );
  });

  it("changes nothing when the pair is unset", () => {
    expect(getSmallModel(runtimeWith({}))).toBe("claude-sonnet-5");
    expect(getLargeModel(runtimeWith({}))).toBe("claude-opus-4-8");
  });
});
