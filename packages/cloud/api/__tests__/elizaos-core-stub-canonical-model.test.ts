/**
 * Pins the Worker-safe `readCanonicalModel` mirror in the @elizaos/core stub to
 * core's semantics: runtime-over-env resolution, family gating for qualified
 * values, unknown-prefix slash ids passing through whole, and blank-is-unset.
 * Pure string work — no Worker, DB, or network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCanonicalModel } from "../src/stubs/elizaos-core";

const runtimeWith = (map: Record<string, string>) => ({
  getSetting: (key: string) => map[key] ?? null,
});

const ENV_KEYS = ["ELIZA_MODEL_SMALL", "ELIZA_MODEL_LARGE"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("elizaos-core stub readCanonicalModel", () => {
  it("reads the per-tier keys and returns unqualified values to every caller", () => {
    const runtime = runtimeWith({
      ELIZA_MODEL_SMALL: "canonical-small",
      ELIZA_MODEL_LARGE: "canonical-large",
    });
    expect(readCanonicalModel(runtime, "small", "openai")).toBe(
      "canonical-small",
    );
    expect(readCanonicalModel(runtime, "large", "anthropic")).toBe(
      "canonical-large",
    );
    expect(readCanonicalModel(runtime, "large")).toBe("canonical-large");
  });

  it("prefers the runtime setting over the env fallback", () => {
    process.env.ELIZA_MODEL_SMALL = "env-small";
    expect(
      readCanonicalModel(
        runtimeWith({ ELIZA_MODEL_SMALL: "runtime-small" }),
        "small",
      ),
    ).toBe("runtime-small");
    expect(readCanonicalModel(runtimeWith({}), "small")).toBe("env-small");
  });

  it("honors qualified values only for the matching family and its aliases", () => {
    const runtime = runtimeWith({
      ELIZA_MODEL_LARGE: "anthropic/claude-opus-4-8",
    });
    expect(readCanonicalModel(runtime, "large", "anthropic")).toBe(
      "claude-opus-4-8",
    );
    expect(readCanonicalModel(runtime, "large", "claude")).toBe(
      "claude-opus-4-8",
    );
    expect(readCanonicalModel(runtime, "large", "openai")).toBeUndefined();
    // Without a family to check against, a qualified value must not leak.
    expect(readCanonicalModel(runtime, "large")).toBeUndefined();
  });

  it("treats unknown-prefix slash values as whole model ids", () => {
    const runtime = runtimeWith({
      ELIZA_MODEL_LARGE: "hf.co/bartowski/Llama-3.2-3B-GGUF",
    });
    expect(readCanonicalModel(runtime, "large", "ollama")).toBe(
      "hf.co/bartowski/Llama-3.2-3B-GGUF",
    );
  });

  it("parses a colliding known-family first token as a qualification (mirror of core's contract)", () => {
    // groq's native id `openai/gpt-oss-120b` starts with a known family token,
    // so the bare spelling is an OpenAI qualification — never the groq id. The
    // supported spelling is the explicit family-pinned groq/openai/gpt-oss-120b.
    const runtime = runtimeWith({ ELIZA_MODEL_SMALL: "openai/gpt-oss-120b" });
    expect(readCanonicalModel(runtime, "small", "groq")).toBeUndefined();
    expect(readCanonicalModel(runtime, "small", "openai")).toBe("gpt-oss-120b");
    const pinned = runtimeWith({
      ELIZA_MODEL_SMALL: "groq/openai/gpt-oss-120b",
    });
    expect(readCanonicalModel(pinned, "small", "groq")).toBe(
      "openai/gpt-oss-120b",
    );
    expect(readCanonicalModel(pinned, "small", "cerebras")).toBeUndefined();
  });

  it("treats blank values as unset", () => {
    expect(
      readCanonicalModel(runtimeWith({ ELIZA_MODEL_SMALL: "   " }), "small"),
    ).toBeUndefined();
    expect(readCanonicalModel(runtimeWith({}), "small")).toBeUndefined();
  });
});
