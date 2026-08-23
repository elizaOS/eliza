import { describe, expect, it } from "vitest";
import {
  getCliVersion,
  getPackageRoot,
  readPackageJson,
} from "../package-info.ts";

describe("package-info", () => {
  it("getPackageRoot resolves to the package parent", () => {
    // The test harness places this file under <root>/elizaos/package-info.ts
    // with a package.json in <root>/, so the root is the parent directory.
    const root = getPackageRoot();
    expect(root.endsWith("elizaos")).toBe(false);
  });

  it("readPackageJson reads the package metadata", () => {
    const pkg = readPackageJson();
    expect(typeof pkg.name).toBe("string");
    expect(typeof pkg.version).toBe("string");
  });

  it("getCliVersion returns the package version", () => {
    const version = getCliVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
