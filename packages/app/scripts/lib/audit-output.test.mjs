/** Proves app-audit cleanup cannot target the filesystem, repository, or app root. */
import { describe, expect, it } from "bun:test";
import path from "node:path";
import { resolveAuditAppOutput } from "./audit-output.mjs";

describe("resolveAuditAppOutput", () => {
  const appDir = path.resolve("/workspace/repo/packages/app");
  const repoRoot = path.resolve("/workspace/repo");

  it("resolves the default and an explicit artifact directory", () => {
    expect(resolveAuditAppOutput({ appDir, repoRoot })).toBe(
      path.join(appDir, "aesthetic-audit-output"),
    );
    expect(
      resolveAuditAppOutput({
        appDir,
        repoRoot,
        configured: "evidence/current",
      }),
    ).toBe(path.join(appDir, "evidence/current"));
  });

  it("rejects destructive roots", () => {
    for (const configured of [
      path.parse(appDir).root,
      path.dirname(repoRoot),
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
