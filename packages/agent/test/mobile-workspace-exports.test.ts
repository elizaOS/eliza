import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { findWorkspaceSourceEntry } from "../scripts/mobile-workspace-entry";

test("mobile source fallback follows declared subpaths and preserves browser selection", () => {
  const root = mkdtempSync(join(tmpdir(), "mobile-workspace-export-"));
  try {
    mkdirSync(join(root, "src/nested"), { recursive: true });
    writeFileSync(join(root, "src/nested/entry.ts"), "export {};");
    writeFileSync(join(root, "src/index.browser.ts"), "export {};");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "@elizaos/fixture",
        exports: {
          "./alias": {
            "eliza-source": "./src/nested/entry.ts",
            import: "./dist/missing.js",
          },
          ".": {
            "eliza-source": "./src/nested/entry.ts",
            browser: "./src/index.browser.ts",
          },
        },
      }),
    );
    expect(findWorkspaceSourceEntry(root, "alias")).toBe(
      join(root, "src/nested/entry.ts"),
    );
    expect(findWorkspaceSourceEntry(root, "")).toBe(
      join(root, "src/nested/entry.ts"),
    );
    expect(findWorkspaceSourceEntry(root, "", "browser")).toBe(
      join(root, "src/index.browser.ts"),
    );
    expect(findWorkspaceSourceEntry(root, "absent")).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
