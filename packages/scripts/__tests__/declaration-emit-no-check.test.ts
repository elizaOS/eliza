// Exercises tests declaration emit no check.test automation behavior with deterministic script fixtures.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

function trackedBuildFiles(): string[] {
  return execFileSync("git", ["ls-files", "packages", "plugins"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  })
    .split(/\r?\n/)
    .filter((file) =>
      /(?:^|\/)(?:package\.json|build\.(?:ts|mjs))$/.test(file),
    );
}

function hasDeclarationEmit(command: string): boolean {
  return /\btsc\b/.test(command) && command.includes("--emitDeclarationOnly");
}

describe("declaration emit build commands", () => {
  test("use --noCheck so build emits declarations without a second typecheck", () => {
    const missingNoCheck: string[] = [];

    for (const file of trackedBuildFiles()) {
      const text = readFileSync(path.join(repoRoot, file), "utf8");

      if (file.endsWith("package.json")) {
        const manifest = JSON.parse(text);
        const buildScript = manifest.scripts?.build;
        if (
          typeof buildScript === "string" &&
          hasDeclarationEmit(buildScript) &&
          !buildScript.includes("--noCheck")
        ) {
          missingNoCheck.push(`${file} scripts.build`);
        }
        continue;
      }

      if (
        text.includes("--emitDeclarationOnly") &&
        !text.includes("--noCheck")
      ) {
        missingNoCheck.push(file);
      }
    }

    expect(missingNoCheck).toEqual([]);
  });
});
