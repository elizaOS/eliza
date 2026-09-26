/** Proves aesthetic-audit cleanup cannot target filesystem or workspace roots. */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveAuditAppOutput,
  resolveAuditCloudOutput,
} from "./audit-output.ts";

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
        configured: "../../test-results/evidence/current",
      }),
    ).toBe(path.join(repoRoot, "test-results/evidence/current"));
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
      path.join(appDir, "src"),
      path.join(appDir, "public"),
      path.join(appDir, "..", "ui"),
    ]) {
      expect(() =>
        resolveAuditAppOutput({ appDir, repoRoot, configured }),
      ).toThrow("refusing to clean unsafe audit output");
    }
  });
});

it("rejects source cleanup through an external symlink or missing leaf", () => {
  const root = mkdtempSync(path.join(tmpdir(), "audit-output-boundary-"));
  try {
    const repoRoot = path.join(root, "repo");
    const appDir = path.join(repoRoot, "packages/app");
    const source = path.join(appDir, "src");
    mkdirSync(source, { recursive: true });
    const alias = path.join(root, "evidence");
    symlinkSync(source, alias, "dir");
    for (const configured of [alias, path.join(alias, "new-capture")]) {
      expect(() =>
        resolveAuditAppOutput({ appDir, repoRoot, configured }),
      ).toThrow("unsafe audit output");
    }
    expect(
      resolveAuditAppOutput({
        appDir,
        repoRoot,
        configured: path.join(root, "external-output"),
      }),
    ).toBe(path.join(root, "external-output"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
