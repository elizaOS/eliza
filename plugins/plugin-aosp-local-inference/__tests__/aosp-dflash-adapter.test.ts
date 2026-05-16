import { describe, expect, it } from "vitest";

import { buildDflashServerArgv } from "../src/aosp-dflash-adapter";

describe("buildDflashServerArgv", () => {
  it("uses current llama.cpp speculative draft flags", () => {
    const argv = buildDflashServerArgv(
      {
        modelPath: "/models/target.gguf",
        draftModelPath: "/models/drafter.gguf",
        contextSize: 2048,
        draftContextSize: 512,
        draftMin: 2,
        draftMax: 6,
        cacheTypeK: "q8_0",
        cacheTypeV: "q4_0",
        disableThinking: true,
      },
      18081,
    );

    expect(argv).toContain("--spec-draft-n-min");
    expect(argv).toContain("--spec-draft-n-max");
    expect(argv).not.toContain("--draft-min");
    expect(argv).not.toContain("--draft-max");
    expect(argv).not.toContain("--ctx-size-draft");
    expect(argv).toContain("--reasoning");
    expect(argv).toContain("off");
    expect(argv).toContain("--cache-type-k");
    expect(argv).toContain("q8_0");
  });
});
