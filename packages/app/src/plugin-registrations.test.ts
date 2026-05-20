import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("side-effect app module registrations", () => {
  it("loads the smartglasses View Manager registration from the app shell", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "plugin-registrations.ts"),
      "utf8",
    );

    expect(source).toContain('key: "@elizaos/plugin-smartglasses/register"');
    expect(source).toContain(
      'load: () => import("@elizaos/plugin-smartglasses/register")',
    );
  });

  it("declares the smartglasses plugin dependency for packaged app builds", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(packageJson.dependencies?.["@elizaos/plugin-smartglasses"]).toBe(
      "workspace:*",
    );
  });
});
