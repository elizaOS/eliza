/**
 * Proves the public registry API is inert in a real Bun bundle while the explicit
 * package command still generates the canonical wire artifact in a filesystem fixture.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const bunExecutable = process.env.BUN_EXEC_PATH ?? "bun";
const temporaryRoots: string[] = [];

function makeTemporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "registry-bundle-import-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("community registry executable boundary", () => {
  it("does not generate files when the public API runs from a Bun bundle", () => {
    const root = makeTemporaryRoot();
    const bundleDir = path.join(root, "bundle");
    const entryPath = path.join(root, "entry.ts");
    const bundlePath = path.join(bundleDir, "entry.js");
    const generatedPath = path.join(root, "generated-registry.json");
    const publicEntryPath = path.join(packageRoot, "src", "index.ts");
    mkdirSync(bundleDir);
    writeFileSync(
      entryPath,
      [
        `import { isValidRegistryPackageName } from ${JSON.stringify(publicEntryPath)};`,
        'if (!isValidRegistryPackageName("community-plugin")) throw new Error("validator failed");',
        'console.log("validator-ok");',
        "",
      ].join("\n"),
    );

    execFileSync(
      bunExecutable,
      ["build", entryPath, "--target", "bun", "--outfile", bundlePath],
      { encoding: "utf8", stdio: "pipe" },
    );
    const stdout = execFileSync(bunExecutable, [bundlePath], {
      cwd: root,
      encoding: "utf8",
    });

    expect(stdout).toContain("validator-ok");
    expect(existsSync(generatedPath)).toBe(false);
  });

  it("keeps the package generate command explicit and byte-compatible", () => {
    const root = makeTemporaryRoot();
    const fixtureRoot = path.join(root, "registry");
    cpSync(path.join(packageRoot, "src"), path.join(fixtureRoot, "src"), {
      recursive: true,
    });
    cpSync(
      path.join(packageRoot, "entries"),
      path.join(fixtureRoot, "entries"),
      { recursive: true },
    );
    cpSync(
      path.join(packageRoot, "package.json"),
      path.join(fixtureRoot, "package.json"),
    );

    const stdout = execFileSync(bunExecutable, ["run", "generate"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
    const generated = readFileSync(
      path.join(fixtureRoot, "generated-registry.json"),
      "utf8",
    );
    const canonical = readFileSync(
      path.join(packageRoot, "generated-registry.json"),
      "utf8",
    );

    expect(stdout).toContain("third-party entries");
    expect(generated).toBe(canonical);
  });
});
