/**
 * Verifies that boot starts independent plugins together while preserving
 * declared dependency order without elapsed-time gates.
 */
import { describe, expect, it } from "vitest";
import { planPluginRegistrationWaves } from "./plugin-registration-waves.ts";

describe("planPluginRegistrationWaves", () => {
  it("maximizes each dependency-safe parallel wave", () => {
    expect(
      planPluginRegistrationWaves(
        [
          {
            name: "@elizaos/plugin-scheduling",
            dependencies: ["@elizaos/plugin-sql"],
          },
          {
            name: "@elizaos/plugin-goals",
            dependencies: ["@elizaos/plugin-scheduling"],
          },
          {
            name: "@elizaos/plugin-discord",
            dependencies: [],
          },
        ],
        new Set(["@elizaos/plugin-sql"]),
      ),
    ).toEqual([
      ["@elizaos/plugin-scheduling", "@elizaos/plugin-discord"],
      ["@elizaos/plugin-goals"],
    ]);
  });

  it("rejects a missing dependency before registration starts", () => {
    expect(() =>
      planPluginRegistrationWaves(
        [
          {
            name: "@elizaos/plugin-goals",
            dependencies: ["@elizaos/plugin-scheduling"],
          },
        ],
        new Set(),
      ),
    ).toThrow("unavailable dependencies");
  });

  it("rejects dependency cycles instead of registering in arbitrary order", () => {
    expect(() =>
      planPluginRegistrationWaves(
        [
          { name: "plugin-a", dependencies: ["plugin-b"] },
          { name: "plugin-b", dependencies: ["plugin-a"] },
        ],
        new Set(),
      ),
    ).toThrow("Plugin dependency cycle");
  });
});
