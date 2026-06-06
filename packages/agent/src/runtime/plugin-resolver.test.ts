import { describe, expect, it } from "vitest";
import { resolveRuntimePluginImportSpecifier } from "./plugin-resolver";

describe("resolveRuntimePluginImportSpecifier", () => {
  it("uses app plugin runtime entrypoints for core app plugins", () => {
    expect(resolveRuntimePluginImportSpecifier("@elizaos/plugin-personal-assistant")).toBe(
      "@elizaos/plugin-personal-assistant/plugin",
    );
    expect(
      resolveRuntimePluginImportSpecifier("@elizaos/plugin-companion"),
    ).toBe("@elizaos/plugin-companion/plugin");
  });

  it("keeps regular plugin package roots unchanged", () => {
    expect(resolveRuntimePluginImportSpecifier("@elizaos/plugin-google")).toBe(
      "@elizaos/plugin-google",
    );
  });
});
