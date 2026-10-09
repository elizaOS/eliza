import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMobileWorkflowPackage } from "../lib/script-metadata.ts";

test("mobile artifact owner follows workspace metadata and rejects missing or competing owners", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "workflow-discovery-"));
  const manifest = (dir: string, enabled: boolean) => {
    mkdirSync(join(repoRoot, dir), { recursive: true });
    writeFileSync(
      join(repoRoot, dir, "package.json"),
      JSON.stringify({
        name: `@fixture/${dir.split("/").at(-1)}`,
        elizaos: { scripts: { mobileWorkflowArtifact: enabled } },
      }),
    );
  };
  try {
    writeFileSync(
      join(repoRoot, "package.json"),
      JSON.stringify({ workspaces: ["features/*"] }),
    );
    expect(() => resolveMobileWorkflowPackage({ repoRoot })).toThrow("found 0");
    manifest("features/relocated-engine", true);
    expect(resolveMobileWorkflowPackage({ repoRoot })).toBe(
      "features/relocated-engine",
    );
    manifest("features/another-engine", true);
    expect(() => resolveMobileWorkflowPackage({ repoRoot })).toThrow("found 2");
    manifest("features/relocated-engine", false);
    expect(resolveMobileWorkflowPackage({ repoRoot })).toBe(
      "features/another-engine",
    );
    rmSync(join(repoRoot, "features/another-engine"), { recursive: true });
    expect(() => resolveMobileWorkflowPackage({ repoRoot })).toThrow("found 0");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
