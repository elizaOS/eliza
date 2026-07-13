// Regression guards for the dedicated-agent default text tiers and the retired
// gpt-4o defaults. Small stays the cheap Cerebras gemma; large must be a
// GENUINELY stronger model (zai-glm-4.7) — plugin-elizacloud's ACTION_PLANNER
// falls back to large, so a fresh agent's planning quality rides on this
// constant, and applyManagedAgentInferenceEnvDefaults re-pins it on every
// blue/green fleet upgrade (#8434). gpt-4o is no longer served as a default
// anywhere on the cloud surface.
import { describe, expect, test } from "bun:test";
import { API_ENDPOINTS } from "../swagger/endpoint-discovery";
import {
  CEREBRAS_DEFAULT_TEXT_LARGE_MODEL,
  CEREBRAS_DEFAULT_TEXT_SMALL_MODEL,
  CEREBRAS_NATIVE_TEXT_MODELS,
} from "./catalog";

describe("dedicated-agent default text tiers", () => {
  test("small stays the cheap Cerebras default", () => {
    expect(CEREBRAS_DEFAULT_TEXT_SMALL_MODEL).toBe("gemma-4-31b");
  });

  test("large is a genuinely stronger model than small", () => {
    expect(CEREBRAS_DEFAULT_TEXT_LARGE_MODEL).toBe("zai-glm-4.7");
    expect(CEREBRAS_DEFAULT_TEXT_LARGE_MODEL).not.toBe(CEREBRAS_DEFAULT_TEXT_SMALL_MODEL);
  });

  test("both tiers route cerebras-native (bare ids, no gateway decoration)", () => {
    expect(CEREBRAS_NATIVE_TEXT_MODELS).toContain(CEREBRAS_DEFAULT_TEXT_SMALL_MODEL);
    expect(CEREBRAS_NATIVE_TEXT_MODELS).toContain(CEREBRAS_DEFAULT_TEXT_LARGE_MODEL);
  });
});

describe("retired gpt-4o defaults", () => {
  test("no API-explorer endpoint documents gpt-4o as a default value", () => {
    for (const endpoint of API_ENDPOINTS) {
      const params = [
        ...(endpoint.parameters?.path ?? []),
        ...(endpoint.parameters?.query ?? []),
        ...(endpoint.parameters?.body ?? []),
        ...(endpoint.parameters?.headers ?? []),
      ];
      for (const param of params) {
        expect(param.defaultValue).not.toBe("gpt-4o");
      }
    }
  });
});
