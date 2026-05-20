import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("side-effect app module registrations", () => {
  it("loads the hearwear View Manager registration from the app shell", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "plugin-registrations.ts"),
      "utf8",
    );

    expect(source).toContain('key: "@elizaos/plugin-hearwear/register"');
    expect(source).toContain(
      'load: () => import("@elizaos/plugin-hearwear/register")',
    );
  });

  it("declares the hearwear plugin dependency for packaged app builds", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(packageJson.dependencies?.["@elizaos/plugin-hearwear"]).toBe(
      "workspace:*",
    );
  });
});
