/**
 * Covers canonical two-knob derivation (ELIZA_MODEL_SMALL/LARGE) through this
 * plugin's model getters: the pair feeds small/large below the OLLAMA_* escape
 * hatches and above the bare aliases, honors ollama-qualified values, skips
 * other families, and passes unknown-prefix slash ids (hf.co/...) through
 * whole. Deterministic — stub runtime settings, env keys cleared per test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LARGE_MODEL,
  DEFAULT_SMALL_MODEL,
  getLargeModel,
  getSmallModel,
} from "../utils/config";

const runtimeWith = (map: Record<string, string>) => ({
  getSetting: (key: string) => map[key] ?? null,
});

const ENV_KEYS = [
  "OLLAMA_SMALL_MODEL",
  "OLLAMA_LARGE_MODEL",
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

describe("ollama canonical model pair", () => {
  it("derives small/large from the pair when OLLAMA_* are unset", () => {
    const runtime = runtimeWith({
      ELIZA_MODEL_SMALL: "llama3.2:3b",
      ELIZA_MODEL_LARGE: "llama3.3:70b",
    });
    expect(getSmallModel(runtime)).toBe("llama3.2:3b");
    expect(getLargeModel(runtime)).toBe("llama3.3:70b");
  });

  it("keeps OLLAMA_* as the winning escape hatch but beats the bare alias", () => {
    expect(
      getSmallModel(
        runtimeWith({ OLLAMA_SMALL_MODEL: "explicit-small", ELIZA_MODEL_SMALL: "canonical-small" })
      )
    ).toBe("explicit-small");
    expect(
      getLargeModel(
        runtimeWith({ ELIZA_MODEL_LARGE: "canonical-large", LARGE_MODEL: "bare-large" })
      )
    ).toBe("canonical-large");
  });

  it("honors ollama-qualified values and skips other families", () => {
    expect(getSmallModel(runtimeWith({ ELIZA_MODEL_SMALL: "ollama/llama3.2:3b" }))).toBe(
      "llama3.2:3b"
    );
    expect(getLargeModel(runtimeWith({ ELIZA_MODEL_LARGE: "anthropic/claude-opus-4-8" }))).toBe(
      DEFAULT_LARGE_MODEL
    );
  });

  it("passes unknown-prefix slash-bearing ids through whole", () => {
    // hf.co/... is a native Ollama model id, not a family qualification.
    const id = "hf.co/bartowski/Llama-3.2-3B-GGUF";
    expect(getSmallModel(runtimeWith({ ELIZA_MODEL_SMALL: id }))).toBe(id);
  });

  it("changes nothing when the pair is unset", () => {
    expect(getSmallModel(runtimeWith({}))).toBe(DEFAULT_SMALL_MODEL);
    expect(getLargeModel(runtimeWith({}))).toBe(DEFAULT_LARGE_MODEL);
  });
});
