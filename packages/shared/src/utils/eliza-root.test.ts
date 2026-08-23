/**
 * Coverage for eliza-root.
 */
import { describe, expect, it } from "vitest";
import { resolveElizaPackageRoot, resolveElizaPackageRootSync } from "./eliza-root.js";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
describe("eliza-root", () => {
  it("finds root from repo", async () => {
    const root = await resolveElizaPackageRoot({ cwd: process.cwd() });
    expect(root).toBeTruthy();
  });
  it("sync finds root", () => {
    expect(resolveElizaPackageRootSync({ cwd: process.cwd() })).toBeTruthy();
  });
  it("returns null for tmp", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "eliza-test-"));
    expect(await resolveElizaPackageRoot({ cwd: tmp })).toBeNull();
  });
});
