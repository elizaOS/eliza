/**
 * Covers the CLI package-metadata helpers against the real on-disk package,
 * so the resolved root is the directory that actually holds package.json
 * rather than a path assembled by the test.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getCliVersion,
  getPackageRoot,
  readPackageJson,
} from "../package-info.ts";

describe("package-info", () => {
  it("getPackageRoot resolves to the directory holding package.json", () => {
    const root = getPackageRoot();
    expect(path.basename(root)).toBe("elizaos");
    expect(fs.existsSync(path.join(root, "package.json"))).toBe(true);
  });

  it("readPackageJson reads the package metadata", () => {
    const pkg = readPackageJson();
    expect(pkg.name).toBe("elizaos");
    expect(typeof pkg.version).toBe("string");
  });

  it("getCliVersion returns the package version", () => {
    expect(getCliVersion()).toBe(readPackageJson().version);
    expect(getCliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
