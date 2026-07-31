/** Verifies platform-native plugin ownership in the generated Capacitor projects. */
import { describe, expect, it } from "vitest";
import config from "../capacitor.config";

describe("Capacitor platform plugin ownership", () => {
  it("excludes the retired Android llama.cpp bridge without excluding it from iOS", () => {
    expect(config.android?.includePlugins).not.toContain("llama-cpp-capacitor");
    expect(config.ios?.includePlugins).toBeUndefined();
  });

  it("admits installed Android plugins without scanning application dependencies", () => {
    expect(config.android?.includePlugins).toContain("@capacitor/app");
    expect(config.android?.includePlugins).toContain(
      "@elizaos/capacitor-bun-runtime",
    );
    expect(config.android?.includePlugins).not.toContain("react");
    expect(new Set(config.android?.includePlugins).size).toBe(
      config.android?.includePlugins?.length,
    );
  });
});
