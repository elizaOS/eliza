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

  it("keeps the bootstrap shell on the elizaOS white and blue startup surface", () => {
    const source = readFileSync(
      resolve(repoRoot, "packages/ui/src/components/shell/StartupShell.tsx"),
      "utf8",
    );

    const bootstrapShell = source.slice(
      source.indexOf("function BootstrapGateShell"),
    );
    expect(bootstrapShell).toContain("bg-[#F7F9FF]");
    expect(bootstrapShell).toContain("text-[#0B35F1]");
    expect(bootstrapShell).not.toContain("bg-[#ffe600]");
    expect(bootstrapShell).not.toContain("radial-gradient");
    expect(bootstrapShell).not.toContain("blur-[");
  });

  it("keeps the startup failure shell on the elizaOS white and blue surface", () => {
    const source = readFileSync(
      resolve(
        repoRoot,
        "packages/ui/src/components/shell/StartupFailureView.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("bg-[#F7F9FF]");
    expect(source).toContain("text-[#0B35F1]");
    expect(source).not.toContain("bg-danger");
    expect(source).not.toContain("text-danger");
    expect(source).not.toContain('variant="danger"');
    expect(source).not.toContain("radial-gradient");
  });
});
