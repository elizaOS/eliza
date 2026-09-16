/** Tests the canonical real-runtime plugin Vitest factory against source resolution. */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPluginRealRuntimeConfig } from "./plugin-real-runtime.config.ts";

describe("createPluginRealRuntimeConfig", () => {
  it("selects real-runtime suites and resolves the core testing source", () => {
    const config = createPluginRealRuntimeConfig();
    expect(config.test?.include).toEqual(["__tests__/**/*.real.test.ts"]);
    expect(config.test?.pool).toBe("forks");
    const aliases = config.resolve?.alias;
    expect(Array.isArray(aliases)).toBe(true);
    if (!Array.isArray(aliases)) throw new Error("expected source alias array");
    const coreTesting = aliases.find(
      (alias) =>
        alias &&
        typeof alias === "object" &&
        "find" in alias &&
        alias.find instanceof RegExp &&
        alias.find.test("@elizaos/core/testing"),
    );
    expect(coreTesting).toBeDefined();
    if (!coreTesting || !("replacement" in coreTesting)) {
      throw new Error("expected core testing source alias");
    }
    expect(existsSync(String(coreTesting.replacement))).toBe(true);
  });
});
