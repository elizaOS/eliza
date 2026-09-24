/** Proves aesthetic-audit cleanup cannot target filesystem or workspace roots. */
import { describe, expect, it } from "bun:test";
import path from "node:path";
import {
  resolveAuditAppOutput,
  resolveAuditCloudOutput,
} from "./audit-output.mjs";

describe("resolveAuditAppOutput", () => {
  const appDir = path.resolve("/workspace/repo/packages/app");
  const repoRoot = path.resolve("/workspace/repo");

  it("resolves the default and an explicit artifact directory", () => {
    expect(resolveAuditAppOutput({ appDir, repoRoot })).toBe(
      path.join(repoRoot, "test-results", "aesthetic-audit"),
    );
    expect(
      resolveAuditAppOutput({
        appDir,
        repoRoot,
        configured: "evidence/current",
      }),
    ).toBe(path.join(appDir, "evidence/current"));
    expect(resolveAuditCloudOutput({ appDir, repoRoot })).toBe(
      path.join(repoRoot, "test-results", "aesthetic-audit-cloud"),
    );
  });

  it("rejects destructive roots", () => {
    for (const configured of [
      path.parse(appDir).root,
      path.dirname(repoRoot),
      path.join(repoRoot, "test-results"),
      repoRoot,
      path.dirname(appDir),
      appDir,
      path.join(appDir, "..", "ui"),
    ]) {
      expect(() =>
        resolveAuditAppOutput({ appDir, repoRoot, configured }),
      ).toThrow("refusing to clean unsafe audit output");
    }
  });
});
