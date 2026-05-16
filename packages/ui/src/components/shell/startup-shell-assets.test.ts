import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../",
);

const shellSourcePaths = [
  "packages/ui/src/components/shell/StartupShell.tsx",
  "packages/ui/src/components/shell/RuntimeGate.tsx",
];

describe("startup shell assets", () => {
  it("does not reference missing splash background images", () => {
    for (const sourcePath of shellSourcePaths) {
      const source = readFileSync(resolve(repoRoot, sourcePath), "utf8");
      expect(source).not.toContain("splash-bg.svg");
      expect(source).not.toContain("splash-bg.png");
    }
  });
});
