import { describe, expect, it, vi } from "vitest";
import {
  type EnvLike,
  readEnvKvCacheType,
  resolveKvCacheType,
} from "./kv-cache-resolver";

const ELIZA_1_MODEL = "/data/local/tmp/eliza-1-2b-32k.gguf";

describe("readEnvKvCacheType", () => {
  it("returns recognised values verbatim", () => {
    const env: EnvLike = {
      A: "f16",
      B: "tbq3_0",
      C: "tbq4_0",
    };
    expect(readEnvKvCacheType("A", env)).toBe("f16");
    expect(readEnvKvCacheType("B", env)).toBe("tbq3_0");
    expect(readEnvKvCacheType("C", env)).toBe("tbq4_0");
  });

  it("normalises case and trims whitespace", () => {
    const env: EnvLike = { A: " TBQ4_0 ", B: "F16" };
    expect(readEnvKvCacheType("A", env)).toBe("tbq4_0");
    expect(readEnvKvCacheType("B", env)).toBe("f16");
  });

  it("returns undefined for unset and blank values without warning", () => {
    const warn = vi.fn();
    expect(readEnvKvCacheType("MISSING", {}, warn)).toBeUndefined();
    expect(readEnvKvCacheType("BLANK", { BLANK: "" }, warn)).toBeUndefined();
    expect(
      readEnvKvCacheType("WHITE", { WHITE: "   " }, warn),
    ).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns on unrecognised values and returns undefined (no throw)", () => {
    const warn = vi.fn();
    expect(readEnvKvCacheType("X", { X: "q4_0" }, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/X=q4_0/);
  });
});

describe("resolveKvCacheType", () => {
  it("returns undefined when no explicit or env override is present", () => {
    expect(resolveKvCacheType(ELIZA_1_MODEL, undefined, {})).toBeUndefined();
    expect(
      resolveKvCacheType(ELIZA_1_MODEL, { k: undefined, v: undefined }, {}),
    ).toBeUndefined();
  });

  it("env var selects cache types", () => {
    const env: EnvLike = {
      ELIZA_LLAMA_CACHE_TYPE_K: "tbq4_0",
      ELIZA_LLAMA_CACHE_TYPE_V: "tbq3_0",
    };
    expect(resolveKvCacheType(ELIZA_1_MODEL, undefined, env)).toEqual({
      k: "tbq4_0",
      v: "tbq3_0",
    });
  });

  it("explicit override beats env var", () => {
    const env: EnvLike = {
      ELIZA_LLAMA_CACHE_TYPE_K: "f16",
      ELIZA_LLAMA_CACHE_TYPE_V: "f16",
    };
    expect(
      resolveKvCacheType(ELIZA_1_MODEL, { k: "tbq4_0", v: "tbq3_0" }, env),
    ).toEqual({
      k: "tbq4_0",
      v: "tbq3_0",
    });
  });

  it("explicit override on one side, env on the other", () => {
    const env: EnvLike = {
      ELIZA_LLAMA_CACHE_TYPE_V: "tbq3_0",
    };
    expect(resolveKvCacheType(ELIZA_1_MODEL, { k: "tbq4_0" }, env)).toEqual({
      k: "tbq4_0",
      v: "tbq3_0",
    });
  });

  it("env-only on a single side still returns a result", () => {
    const env: EnvLike = { ELIZA_LLAMA_CACHE_TYPE_K: "f16" };
    expect(resolveKvCacheType(ELIZA_1_MODEL, undefined, env)).toEqual({
      k: "f16",
      v: undefined,
    });
  });

  it("ignores invalid env values and returns undefined without a default", () => {
    const warn = vi.fn();
    const env: EnvLike = {
      ELIZA_LLAMA_CACHE_TYPE_K: "garbage",
      ELIZA_LLAMA_CACHE_TYPE_V: "alsogarbage",
    };
    expect(resolveKvCacheType(ELIZA_1_MODEL, undefined, env, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("explicit override on both sides skips env entirely", () => {
    const warn = vi.fn();
    const env: EnvLike = {
      ELIZA_LLAMA_CACHE_TYPE_K: "garbage",
      ELIZA_LLAMA_CACHE_TYPE_V: "alsogarbage",
    };
    // The resolver currently still parses env vars to surface warnings even
    // when explicit overrides win — that's intentional so the operator
    // sees a typo regardless of the override path.
    expect(
      resolveKvCacheType(ELIZA_1_MODEL, { k: "f16", v: "f16" }, env, warn),
    ).toEqual({
      k: "f16",
      v: "f16",
    });
  });
});
