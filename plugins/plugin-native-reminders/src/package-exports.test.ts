/**
 * Pins the source-mode export used by fresh-workspace Node runtimes before the
 * native Reminders package has produced its distributable build artifacts.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("@elizaos/macosreminders package exports", () => {
  it("resolves the package root from source under eliza-source", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports?: {
        "."?: {
          "eliza-source"?: Record<string, string>;
        };
      };
    };

    expect(packageJson.exports?.["."]?.["eliza-source"]).toEqual({
      types: "./src/index.ts",
      import: "./src/index.ts",
      default: "./src/index.ts",
    });
  });
});
