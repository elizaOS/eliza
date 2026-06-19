import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const EXPECTED_SIDE_EFFECT_MODULES = [
  "@elizaos/plugin-feed",
  "@elizaos/plugin-scape",
  "@elizaos/plugin-hyperscape",
  "@elizaos/plugin-2004scape",
  "@elizaos/plugin-defense-of-the-agents",
  "@elizaos/plugin-clawville",
  "@elizaos/plugin-trajectory-logger",
  "@elizaos/plugin-shopify-ui",
  "@elizaos/plugin-hyperliquid-app",
  "@elizaos/plugin-polymarket-app",
  "@elizaos/plugin-wallet-ui",
  "@elizaos/app-model-tester",
  "@elizaos/plugin-vector-browser/register",
  "@elizaos/plugin-contacts/register",
  "@elizaos/plugin-device-settings/register",
  "@elizaos/plugin-messages/register",
  "@elizaos/plugin-phone/register",
  "@elizaos/plugin-task-coordinator/register",
  "@elizaos/plugin-wifi/register",
  "@elizaos/plugin-facewear/register",
] as const;

describe("side-effect app module registrations", () => {
  it("loads every side-effect app module from the app shell", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "plugin-registrations.ts"),
      "utf8",
    );

    const keys = [...source.matchAll(/key:\s*"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(keys).toEqual([...EXPECTED_SIDE_EFFECT_MODULES]);

    for (const moduleId of EXPECTED_SIDE_EFFECT_MODULES) {
      expect(source).toContain(`key: "${moduleId}"`);
      expect(source).toContain(`load: () => import("${moduleId}")`);
    }
  });

  it("declares side-effect module plugin dependencies for packaged app builds", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    for (const moduleId of EXPECTED_SIDE_EFFECT_MODULES) {
      const packageName = moduleId.replace(/\/register$/, "");
      expect(packageJson.dependencies?.[packageName]).toBe("workspace:*");
    }
  });

  it("declares TypeScript modules for register-only side-effect imports", () => {
    const declarations = readFileSync(
      resolve(import.meta.dirname, "types", "side-effect-app-modules.d.ts"),
      "utf8",
    );

    for (const moduleId of EXPECTED_SIDE_EFFECT_MODULES.filter((id) =>
      id.endsWith("/register"),
    )) {
      expect(declarations).toContain(`declare module "${moduleId}";`);
    }
  });
});
