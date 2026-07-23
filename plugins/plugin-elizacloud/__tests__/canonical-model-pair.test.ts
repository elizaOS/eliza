/**
 * Covers canonical two-knob derivation (ELIZA_MODEL_SMALL/LARGE) through this
 * plugin's model getters: the pair feeds small/large below the ELIZAOS_CLOUD_*
 * escape hatches and above the bare aliases, honors the elizacloud family
 * aliases (cloud/, eliza-cloud/), and skips other families. Deterministic —
 * stub runtime settings, env keys cleared per test.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { DEFAULT_ELIZA_CLOUD_TEXT_MODEL } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ELIZA_CLOUD_LARGE_MODEL, getLargeModel, getSmallModel } from "../src/utils/config";

const runtimeWith = (map: Record<string, string>) =>
  ({ getSetting: (key: string) => map[key] ?? null }) as unknown as IAgentRuntime;

const ENV_KEYS = [
  "ELIZAOS_CLOUD_SMALL_MODEL",
  "ELIZAOS_CLOUD_LARGE_MODEL",
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

describe("elizacloud canonical model pair", () => {
  it("derives small/large from the pair when ELIZAOS_CLOUD_* are unset", () => {
    const runtime = runtimeWith({
      ELIZA_MODEL_SMALL: "canonical-small",
      ELIZA_MODEL_LARGE: "canonical-large",
    });
    expect(getSmallModel(runtime)).toBe("canonical-small");
    expect(getLargeModel(runtime)).toBe("canonical-large");
  });

  it("keeps ELIZAOS_CLOUD_* as the winning escape hatch but beats the bare alias", () => {
    expect(
      getSmallModel(
        runtimeWith({
          ELIZAOS_CLOUD_SMALL_MODEL: "explicit-small",
          ELIZA_MODEL_SMALL: "canonical-small",
        })
      )
    ).toBe("explicit-small");
    expect(
      getLargeModel(
        runtimeWith({ ELIZA_MODEL_LARGE: "canonical-large", LARGE_MODEL: "bare-large" })
      )
    ).toBe("canonical-large");
  });

  it("honors elizacloud family aliases and skips other families", () => {
    expect(getSmallModel(runtimeWith({ ELIZA_MODEL_SMALL: "cloud/gemma-4-31b" }))).toBe(
      "gemma-4-31b"
    );
    expect(getLargeModel(runtimeWith({ ELIZA_MODEL_LARGE: "eliza-cloud/zai-glm-4.7" }))).toBe(
      "zai-glm-4.7"
    );
    expect(getLargeModel(runtimeWith({ ELIZA_MODEL_LARGE: "anthropic/claude-opus-4-8" }))).toBe(
      DEFAULT_ELIZA_CLOUD_LARGE_MODEL
    );
  });

  it("changes nothing when the pair is unset", () => {
    expect(getSmallModel(runtimeWith({}))).toBe(DEFAULT_ELIZA_CLOUD_TEXT_MODEL);
    expect(getLargeModel(runtimeWith({}))).toBe(DEFAULT_ELIZA_CLOUD_LARGE_MODEL);
  });
});
