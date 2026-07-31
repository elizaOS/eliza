/** Verifies platform-native plugin ownership in the generated Capacitor projects. */
import { describe, expect, it } from "vitest";
import config, { resolveAndroidCapacitorPlugins } from "../capacitor.config";

describe("Capacitor platform plugin ownership", () => {
  it("excludes the retired Android llama.cpp bridge without excluding it from iOS", () => {
    expect(config.android?.includePlugins).not.toContain("llama-cpp-capacitor");
    expect(config.ios?.includePlugins).toBeUndefined();
  });

  it("preserves Capacitor's dependency scan while removing only the retired bridge", () => {
    expect(
      resolveAndroidCapacitorPlugins(
        {
          "@capacitor/app": "8.1.0",
          "llama-cpp-capacitor": "0.1.5",
        },
        {
          "@capacitor/app": "8.1.0",
          "@capacitor/cli": "8.5.0",
        },
      ),
    ).toEqual(["@capacitor/app", "@capacitor/cli"]);
  });
});
