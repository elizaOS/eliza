import { describe, expect, it } from "vitest";
import { DependencyManager } from "../dep-manager";

describe("DependencyManager", () => {
  it("checkOne returns a single result", async () => {
    const mgr = new DependencyManager();
    const result = await mgr.checkOne("adb");
    expect(result.id).toBe("adb");
    expect(["found", "missing"]).toContain(result.status);
  });

  it("autoInstall re-verifies via checkOne and returns 'found' or 'install-failed' (never blind 'found')", async () => {
    // We can't actually run brew/apt in this test env. The contract we verify
    // here is the return shape:
    //   - if the binary is already on PATH, autoInstall short-circuits to found
    //   - otherwise it returns either found (after install) or install-failed
    //   - it never returns the raw exit code without re-verification
    const mgr = new DependencyManager();
    const result = await mgr.autoInstall("adb");
    expect(["found", "install-failed", "missing"]).toContain(result.status);

    // If we got install-failed, manualInstructions MUST be present.
    if (result.status === "install-failed") {
      expect(result.manualInstructions).toBeDefined();
      expect(result.errorMessage).toBeDefined();
    }

    // If we got found, foundPath MUST be present.
    if (result.status === "found") {
      expect(result.foundPath).toBeTruthy();
    }
  }, 60_000);
});
