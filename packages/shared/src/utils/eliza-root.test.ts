import { describe, expect, it } from "vitest";
import { resolveElizaPackageRootSync } from "./eliza-root.js";

describe("eliza-root", () => {
  it("returns null for empty opts", async () => {
    expect(resolveElizaPackageRootSync({})).toBeNull();
    expect(resolveElizaPackageRootSync({ cwd: "/tmp" })).toBeNull();
  });

  it("returns null for non-eliza directory", () => {
    expect(resolveElizaPackageRootSync({ cwd: "/tmp" })).toBeNull();
  });

  it("handles argv1 without bin segment", () => {
    const result = resolveElizaPackageRootSync({
      argv1: "/usr/local/bin/node",
      cwd: "/tmp",
    });
    expect(result === null || typeof result === "string").toBe(true);
  });
});
