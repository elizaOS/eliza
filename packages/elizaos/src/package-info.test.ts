import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getCliVersion,
  getPackageRoot,
  isStandaloneBinary,
  readPackageJson,
} from "./package-info.js";

describe("package-info", () => {
  it("does not report a standalone binary in the normal module runtime", () => {
    // Under vitest we run from a real on-disk module, never from the bunfs
    // virtual root, so the standalone-binary branch must stay off here.
    expect(isStandaloneBinary()).toBe(false);
  });

  it("resolves the package root to the directory that holds package.json", () => {
    const root = getPackageRoot();
    expect(fs.existsSync(path.join(root, "package.json"))).toBe(true);
    // package-info.ts lives in src/, so the root is one level up.
    expect(path.basename(root)).toBe("elizaos");
  });

  it("reads name and version from the resolved package.json", () => {
    const pkg = readPackageJson();
    expect(pkg.name).toBe("elizaos");
    expect(getCliVersion()).toBe(pkg.version);
  });
});
