/**
 * Smoke test for the browser and edge barrels: both must re-export the
 * canonical-model helpers (the two-knob ELIZA_MODEL_SMALL/LARGE pair) alongside
 * long-standing setting-resolution exports, and the re-export must be the real
 * family-gated implementation from utils/canonical-model, not a stub.
 */
import { describe, expect, it } from "vitest";
import * as browserBarrel from "../index.browser";
import * as edgeBarrel from "../index.edge";
import {
  CANONICAL_MODEL_ENV_KEYS,
  readCanonicalModel,
} from "../utils/canonical-model";

const barrels = [
  ["browser", browserBarrel],
  ["edge", edgeBarrel],
] as const;

describe.each(barrels)("@elizaos/core %s barrel", (_name, barrel) => {
  it("re-exports the canonical-model helpers from utils/canonical-model", () => {
    expect(barrel.readCanonicalModel).toBe(readCanonicalModel);
    expect(barrel.CANONICAL_MODEL_ENV_KEYS).toBe(CANONICAL_MODEL_ENV_KEYS);
    expect(barrel.CANONICAL_MODEL_ENV_KEYS).toEqual({
      small: "ELIZA_MODEL_SMALL",
      large: "ELIZA_MODEL_LARGE",
    });
    expect(typeof barrel.canonicalModelIsQualified).toBe("function");
    // The sibling resolution helpers the pair layers on stay exported too.
    expect(typeof barrel.resolveSetting).toBe("function");
  });

  it("resolves the pair with family gating through the barrel export", () => {
    const runtime = (value: string) => ({
      getSetting: (key: string) => (key === "ELIZA_MODEL_LARGE" ? value : null),
    });
    expect(
      barrel.readCanonicalModel(runtime("anthropic/claude-opus-4-8"), "large", "anthropic"),
    ).toBe("claude-opus-4-8");
    expect(
      barrel.readCanonicalModel(runtime("anthropic/claude-opus-4-8"), "large", "openai"),
    ).toBeUndefined();
  });
});
