import { describe, expect, it } from "vitest";

import {
  buildKokoroOrtSessionOptions,
  DEFAULT_KOKORO_EXECUTION_PROVIDER,
  type KokoroExecutionProvider,
  KOKORO_EXECUTION_PROVIDER_IDS,
  parseKokoroExecutionProvider,
} from "./kokoro-execution-provider.js";

describe("kokoro-execution-provider", () => {
  it("defaults to cpu so #7666 behaviour is unchanged until #7667 wires it", () => {
    expect(DEFAULT_KOKORO_EXECUTION_PROVIDER).toBe("cpu");
    expect(buildKokoroOrtSessionOptions()).toEqual({
      executionProviders: ["cpu"],
    });
  });

  it("emits exactly one provider id per call", () => {
    for (const id of KOKORO_EXECUTION_PROVIDER_IDS) {
      const opts = buildKokoroOrtSessionOptions(id);
      expect(opts.executionProviders).toHaveLength(1);
      expect(opts.executionProviders[0]).toBe(id);
    }
  });

  it("parses known provider ids, case-insensitive, with whitespace trim", () => {
    const cases: ReadonlyArray<[string, KokoroExecutionProvider]> = [
      ["cpu", "cpu"],
      ["NNAPI", "nnapi"],
      ["  XnnPack ", "xnnpack"],
      ["coreml", "coreml"],
    ];
    for (const [input, expected] of cases) {
      expect(parseKokoroExecutionProvider(input)).toBe(expected);
    }
  });

  it("rejects anything not in the allowlist instead of falling back silently", () => {
    expect(parseKokoroExecutionProvider("cuda")).toBeNull();
    expect(parseKokoroExecutionProvider("")).toBeNull();
    expect(parseKokoroExecutionProvider(undefined)).toBeNull();
    expect(parseKokoroExecutionProvider(null)).toBeNull();
  });
});
