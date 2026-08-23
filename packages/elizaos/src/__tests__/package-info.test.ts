/**
 * Exercises CLI package-root and metadata resolution against the checked-out package filesystem.
 */
import { describe, expect, it } from "vitest";
import {
  getCliVersion,
  getPackageRoot,
  readPackageJson,
} from "../package-info.ts";

describe("package-info", () => {
  it("getPackageRoot resolves to the package parent", () => {
    // package-info.ts lives under <root>/src, so its parent is the elizaos
    // package root containing package.json.
    const root = getPackageRoot();
    expect(root.endsWith("elizaos")).toBe(true);
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
