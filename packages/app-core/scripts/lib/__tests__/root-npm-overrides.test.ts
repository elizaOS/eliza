import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type RootPackage = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
};

describe("root npm override compatibility", () => {
  it("keeps every direct dependency specifier identical to its npm override", () => {
    const rootPackage = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "../../../../../package.json"),
        "utf8",
      ),
    ) as RootPackage;

    const directDependencies = {
      ...rootPackage.dependencies,
      ...rootPackage.devDependencies,
    };
    const mismatches = Object.entries(rootPackage.overrides ?? {}).flatMap(
      ([packageName, overrideSpecifier]) => {
        const directSpecifier = directDependencies[packageName];
        return directSpecifier !== undefined &&
          directSpecifier !== overrideSpecifier
          ? [{ packageName, directSpecifier, overrideSpecifier }]
          : [];
      },
    );

    expect(mismatches).toEqual([]);
  });
});
