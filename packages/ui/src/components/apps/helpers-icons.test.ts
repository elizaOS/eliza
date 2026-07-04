/**
 * Covers the catalog icon helpers `getAppEmoji` / `getAppIconName` in `helpers.ts`,
 * asserting section apps resolve to Lucide icon names rather than raw emoji glyphs.
 * Pure functions over in-memory `RegistryAppInfo` fixtures.
 */

import { describe, expect, it } from "vitest";
import type { RegistryAppInfo } from "../../api";
import { getAppEmoji, getAppIconName } from "./helpers";

function app(overrides: Partial<RegistryAppInfo>): RegistryAppInfo {
  return {
    category: "utility",
    description: "",
    displayName: "Demo",
    name: "@elizaos/plugin-demo",
    ...overrides,
  } as RegistryAppInfo;
}

describe("app catalog icon helpers", () => {
  it("returns icon names instead of raw emoji glyphs for app sections", () => {
    const cases = [
      app({ name: "@elizaos/plugin-personal-assistant" }),
      app({ category: "game", name: "@elizaos/plugin-game-demo" }),
      app({ category: "developer", name: "@elizaos/plugin-tooling" }),
      app({ category: "finance", name: "@elizaos/plugin-wallet" }),
      app({ category: "utility", name: "@elizaos/plugin-utility" }),
    ];

    for (const candidate of cases) {
      expect(getAppIconName(candidate)).toMatch(/^[A-Za-z0-9]+$/);
      expect(getAppEmoji(candidate)).toBe(getAppIconName(candidate));
      expect(getAppEmoji(candidate)).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    }
  });
});
