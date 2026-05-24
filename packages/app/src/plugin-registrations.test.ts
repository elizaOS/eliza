import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("side-effect app module registrations", () => {
  it("loads the facewear View Manager registration from the app shell", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "plugin-registrations.ts"),
      "utf8",
    );

    expect(source).toContain('key: "@elizaos/plugin-facewear/register"');
    expect(source).toContain(
      'load: () => import("@elizaos/plugin-facewear/register")',
    );
  });

  it("declares the facewear plugin dependency for packaged app builds", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(packageJson.dependencies?.["@elizaos/plugin-facewear"]).toBe(
      "workspace:*",
    );
  });
});
